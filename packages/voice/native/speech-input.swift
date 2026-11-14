// JARVIS 语音输入（macOS SFSpeechRecognizer）— 0.2-③ 输入端
// 构建：swiftc -O speech-input.swift -o jarvis-speech
// 协议：stdout JSONL
//   {"type":"status","speech":"authorized|denied|notDetermined|...","mic":"granted|denied|undetermined","available":true}
//   {"type":"ready"}                         已开始收音
//   {"type":"partial","text":"..."}          中间结果（用于打断 TTS）
//   {"type":"final","text":"..."}            一句话结束
//   {"type":"error","message":"..."}
//
// --status-only：只报权限与可用性，不触碰麦克风、不弹授权窗，
// 供自动验收与 Core 决定是否降级到文本输入。

import Foundation
import Speech
import AVFoundation

func emit(_ obj: [String: Any]) {
    guard let d = try? JSONSerialization.data(withJSONObject: obj),
          let s = String(data: d, encoding: .utf8) else { return }
    FileHandle.standardOutput.write((s + "\n").data(using: .utf8)!)
}

let locale = Locale(identifier: "zh-CN")

func speechStatus() -> String {
    switch SFSpeechRecognizer.authorizationStatus() {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "notDetermined"
    @unknown default: return "unknown"
    }
}

func micStatus() -> String {
    if #available(macOS 14.0, *) {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: return "granted"
        case .denied: return "denied"
        case .undetermined: return "undetermined"
        @unknown default: return "unknown"
        }
    }
    return "unknown"
}

if CommandLine.arguments.contains("--status-only") {
    emit([
        "type": "status",
        "speech": speechStatus(),
        "mic": micStatus(),
        "available": SFSpeechRecognizer(locale: locale) != nil,
        "locale": locale.identifier,
    ])
    exit(0)
}

guard SFSpeechRecognizer.authorizationStatus() == .authorized,
      micStatus() == "granted",
      let recognizer = SFSpeechRecognizer(locale: locale) else {
    emit(["type": "error", "message": "speech or microphone permission not granted; use --status-only / text fallback"])
    exit(2)
}

let engine = AVAudioEngine()
let request = SFSpeechAudioBufferRecognitionRequest()
request.shouldReportPartialResults = true
let input = engine.inputNode
let format = input.outputFormat(forBus: 0)
input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
    request.append(buffer)
}
do {
    engine.prepare()
    try engine.start()
} catch {
    emit(["type": "error", "message": "audio engine: \(error.localizedDescription)"])
    exit(3)
}
emit(["type": "ready"])

// 保持 task 引用，避免被提前释放
let task = recognizer.recognitionTask(with: request) { result, error in
    if let r = result {
        emit(["type": r.isFinal ? "final" : "partial", "text": r.bestTranscription.formattedString])
    }
    if let e = error {
        emit(["type": "error", "message": e.localizedDescription])
    }
}
_ = task
signal(SIGTERM) { _ in exit(0) }
RunLoop.main.run()
