import { describe, expect, it } from "vitest";
import { MacNotifyChannel, escapeAppleScript } from "./mac-notify.js";
import type { ProactiveNotice } from "./runtime.js";

function notice(over: Partial<ProactiveNotice> = {}): ProactiveNotice {
  return { text: "任务停滞提醒", priority: "normal", dedupeKey: "k", at: new Date().toISOString(), ...over };
}

describe("escapeAppleScript", () => {
  it("转义引号与反斜杠", () => {
    expect(escapeAppleScript('说"你好"')).toBe('说\\"你好\\"');
    expect(escapeAppleScript("C:\\path")).toBe("C:\\\\path");
    expect(escapeAppleScript("正常文本")).toBe("正常文本");
  });
});

describe("MacNotifyChannel", () => {
  it("darwin：调用 osascript，high 带声音", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const ch = new MacNotifyChannel(
      async (cmd, args) => {
        calls.push({ cmd, args });
        return { stdout: "", stderr: "" };
      },
      "darwin",
    );
    await ch.send(notice());
    await ch.send(notice({ priority: "high" }));
    expect(calls).toHaveLength(2);
    expect(calls[0]?.cmd).toBe("osascript");
    expect(calls[0]?.args[1]).toContain("with title \"JARVIS\"");
    expect(calls[0]?.args[1]).not.toContain("sound");
    expect(calls[1]?.args[1]).toContain("sound name \"default\"");
    expect(calls[1]?.args[1]).toContain("JARVIS · 重要");
  });

  it("标题与正文注入防护", async () => {
    const seen: string[] = [];
    const ch = new MacNotifyChannel(
      async (_cmd, args) => {
        seen.push(String(args[1]));
        return { stdout: "", stderr: "" };
      },
      "darwin",
    );
    await ch.send(notice({ text: '任务"完成"); display alert "pwned' }));
    // 引号被转义，无法逃出字符串
    expect(seen[0]).toContain('\\"');
    expect(seen[0]).not.toContain('""');
  });

  it("非 darwin 静默跳过", async () => {
    let called = false;
    const ch = new MacNotifyChannel(
      async () => {
        called = true;
        return { stdout: "", stderr: "" };
      },
      "linux",
    );
    await ch.send(notice());
    expect(called).toBe(false);
  });

  it("osascript 失败不抛（降级文件通道兜底）", async () => {
    const ch = new MacNotifyChannel(
      async () => {
        throw new Error("notification center off");
      },
      "darwin",
    );
    await expect(ch.send(notice())).resolves.toBeUndefined();
  });
});
