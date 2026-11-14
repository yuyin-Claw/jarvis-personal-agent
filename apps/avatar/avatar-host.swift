// JARVIS Avatar 宿主窗口（macOS）：透明无边框置顶 NSWindow + WKWebView
// 构建：swiftc -O -framework Cocoa -framework WebKit avatar-host.swift -o jarvis-avatar
// 运行：./jarvis-avatar [avatar.html] [--x N --y N --width N --height N]
//
// 控制通道（状态文件，避免 FIFO 的一次性读断流问题）：
//   写 ~/.local/share/jarvis/avatar.state.json，JSON 形如
//   {"seq":1,"state":"speaking","intensity":0.85,"amplitude":0.7,
//    "caption":"...","capture":"/tmp/shot.png"}
//   seq 必须递增；宿主 60ms 轮询，变化时注入 WebView 并回写 avatar.ack.json。
//   capture 字段：状态生效、过渡动画稳定后由宿主截取自身窗口 PNG，并生成 <path>.done。

import Cocoa
import WebKit
import CoreGraphics

let BASE = NSHomeDirectory() + "/.local/share/jarvis"
let STATE_FILE = BASE + "/avatar.state.json"
let ACK_FILE = BASE + "/avatar.ack.json"

final class AvatarDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    var webView: WKWebView!
    var lastSeq: Int = -1
    var width: CGFloat = 260
    var height: CGFloat = 300
    var topLeft: CGPoint?

    func applicationDidFinishLaunching(_ n: Notification) {
        NSApp.setActivationPolicy(.accessory) // 不占 Dock
        parseArgs()
        try? FileManager.default.createDirectory(atPath: BASE, withIntermediateDirectories: true)

        let screen = NSScreen.main?.frame ?? CGRect(x: 0, y: 0, width: 1728, height: 1117)
        let size = NSSize(width: width, height: height)
        let origin: CGPoint
        if let tl = topLeft {
            origin = CGPoint(x: tl.x, y: screen.maxY - tl.y - height)
        } else {
            origin = CGPoint(x: screen.maxX - width - 24, y: screen.maxY - height - 24)
        }
        let style: NSWindow.StyleMask = [.borderless, .nonactivatingPanel]
        window = NSWindow(contentRect: NSRect(origin: origin, size: size),
                          styleMask: style, backing: .buffered, defer: false)
        window.isOpaque = false
        window.backgroundColor = .clear
        window.level = .floating
        window.isMovableByWindowBackground = true
        window.collectionBehavior = [.canJoinAllSpaces, .stationary]
        window.ignoresMouseEvents = false

        let cfg = WKWebViewConfiguration()
        let user = WKUserContentController()
        user.add(self, name: "jarvis")
        cfg.userContentController = user

        webView = WKWebView(frame: NSRect(origin: .zero, size: size), configuration: cfg)
        webView.setValue(false, forKey: "drawsBackground")
        let htmlPath = htmlArgument()
        let html = URL(fileURLWithPath: htmlPath)
        webView.loadFileURL(html, allowingReadAccessTo: html.deletingLastPathComponent())
        window.contentView = webView
        window.orderFrontRegardless()

        // 启动时清掉旧 ack，避免验收脚本读到上一轮结果
        try? FileManager.default.removeItem(atPath: ACK_FILE)
        Timer.scheduledTimer(withTimeInterval: 0.06, repeats: true) { [weak self] _ in
            self?.pollState()
        }
        FileHandle.standardError.write("jarvis-avatar ready: \(htmlPath)\n".data(using: .utf8)!)
    }

    private func parseArgs() {
        let a = CommandLine.arguments
        var i = 1
        while i < a.count {
            switch a[i] {
            case "--x": if i + 1 < a.count, let v = Double(a[i+1]) { topLeft = CGPoint(x: v, y: topLeft?.y ?? 60); i += 1 }
            case "--y": if i + 1 < a.count, let v = Double(a[i+1]) { topLeft = CGPoint(x: topLeft?.x ?? 60, y: v); i += 1 }
            case "--width": if i + 1 < a.count, let v = Double(a[i+1]) { width = CGFloat(v); i += 1 }
            case "--height": if i + 1 < a.count, let v = Double(a[i+1]) { height = CGFloat(v); i += 1 }
            default: break
            }
            i += 1
        }
    }

    private func htmlArgument() -> String {
        let a = CommandLine.arguments
        if a.count > 1, !a[1].hasPrefix("--") { return a[1] }
        return Bundle.main.bundlePath + "/avatar.html"
    }

    /// 轮询状态文件；seq 递增即注入（同内容重发也能触发）
    private func pollState() {
        guard let data = FileManager.default.contents(atPath: STATE_FILE),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let seq = obj["seq"] as? Int,
              seq > lastSeq else { return }
        lastSeq = seq
        apply(text: String(data: data, encoding: .utf8) ?? "{}", capture: obj["capture"] as? String)
    }

    /// base64 传原始 JSON 文本，避免字符串插值注入 JS 时的引号/转义问题
    private func apply(text: String, capture: String?) {
        let b64 = Data(text.utf8).base64EncodedString()
        let js = """
        (function(){
          try {
            var raw = atob('\(b64)');
            var bytes = Uint8Array.from(raw, function(c){ return c.charCodeAt(0); });
            var d = JSON.parse(new TextDecoder().decode(bytes));
            if (!window.jarvis) return JSON.stringify({ok:false, error:'renderer not ready'});
            if (d.state) window.jarvis.setState(d.state, d.intensity, d.caption);
            if (typeof d.amplitude === 'number') window.jarvis.setAmplitude(d.amplitude);
            return JSON.stringify({ok:true, state:window.jarvis.getState(), frame:window.jarvis.frame()});
          } catch(e) { return JSON.stringify({ok:false, error:String(e)}); }
        })()
        """
        webView.evaluateJavaScript(js) { [weak self] result, err in
            guard let self else { return }
            let payload: [String: Any] = [
                "seq": self.lastSeq,
                "ok": err == nil,
                "result": result as? String ?? "",
                "ts": Date().timeIntervalSince1970,
            ]
            self.writeJSON(payload, to: ACK_FILE)
            if let capture, err == nil {
                // 等状态过渡动画（600ms）+ 若干渲染帧后截窗口
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.75) { [weak self] in
                    self?.captureWindow(to: capture)
                }
            }
        }
    }

    private func writeJSON(_ obj: [String: Any], to path: String) {
        guard let d = try? JSONSerialization.data(withJSONObject: obj) else { return }
        try? d.write(to: URL(fileURLWithPath: path), options: .atomic)
    }

    /// 只截自身窗口（不含桌面），得到干净的可断言画面。
    /// macOS 15+ SDK 已禁用 CGWindowListCreateImage，改用 screencapture -l；
    /// 失败时回退到 NSView 缓存绘制。
    private func captureWindow(to path: String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        p.arguments = ["-l", String(window.windowNumber), "-x", "-o", path]
        p.standardError = Pipe()
        p.standardOutput = Pipe()
        var ok = false
        do {
            try p.run()
            p.waitUntilExit()
            ok = p.terminationStatus == 0 && FileManager.default.fileExists(atPath: path)
        } catch { ok = false }
        if !ok { ok = captureViaView(to: path) }
        guard ok else {
            FileHandle.standardError.write("capture failed for window \(window.windowNumber)\n".data(using: .utf8)!)
            return
        }
        try? FileManager.default.removeItem(atPath: path + ".done")
        FileManager.default.createFile(atPath: path + ".done", contents: Data())
    }

    private func captureViaView(to path: String) -> Bool {
        guard let view = window.contentView,
              let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return false }
        view.cacheDisplay(in: view.bounds, to: rep)
        guard let png = rep.representation(using: .png, properties: [:]) else { return false }
        try? png.write(to: URL(fileURLWithPath: path))
        return FileManager.default.fileExists(atPath: path)
    }

    func userContentController(_ ucc: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        // 预留：HTML → 宿主事件（如点击切换大小）
    }
}

let app = NSApplication.shared
let delegate = AvatarDelegate()
app.delegate = delegate
app.run()
