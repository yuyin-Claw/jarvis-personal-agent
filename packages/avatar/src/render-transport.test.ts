import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AvatarRenderTransport } from "./render-transport.js";
import { AvatarStateEngine } from "./state-engine.js";

const dirs: string[] = [];
function transport() {
  const dir = mkdtempSync(join(tmpdir(), "avatar-transport-"));
  dirs.push(dir);
  return new AvatarRenderTransport({ baseDir: dir, sleep: () => Promise.resolve() });
}
afterEach(() => {
  // 临时目录仅含测试自建文件，保留到进程结束即可（避免跨平台 rm 差异）
});

describe("AvatarRenderTransport 状态文件通道", () => {
  it("publish 原子写合法 JSON，seq 单调递增，不残留 .tmp", () => {
    const t = transport();
    const p1 = t.setState("speaking", { intensity: 0.8, amplitude: 0.6, caption: "你好" });
    const p2 = t.setState("working", { intensity: 0.4 });
    expect(p2.seq).toBe(p1.seq + 1);
    const raw = readFileSync(t.stateFile, "utf8");
    expect(JSON.parse(raw)).toMatchObject({ seq: 2, state: "working", intensity: 0.4 });
    expect(existsSync(`${t.stateFile}.tmp`)).toBe(false);
  });

  it("publish(AestheticState) 携带 caption，且不写入 undefined 字段", () => {
    const t = transport();
    const p = t.publish({ state: "responding", intensity: 0.9, enteredAt: 1, caption: "完成" }, {
      capture: "/tmp/shot.png",
    });
    const obj = JSON.parse(readFileSync(t.stateFile, "utf8"));
    expect(obj).toEqual({
      seq: p.seq,
      state: "responding",
      intensity: 0.9,
      caption: "完成",
      capture: "/tmp/shot.png",
    });
    expect("amplitude" in obj).toBe(false);
  });

  it("bind 状态引擎：每次状态转换自动推送（同状态忽略事件不重复推）", () => {
    const t = transport();
    const e = new AvatarStateEngine({ now: () => 1, setTimeoutImpl: () => 0 });
    const unbind = t.bind(e);
    e.dispatch({ type: "user_speech_start" }); // idle → listening
    e.dispatch({ type: "user_speech_end" }); // listening → thinking
    expect(JSON.parse(readFileSync(t.stateFile, "utf8"))).toMatchObject({ seq: 2, state: "thinking" });
    e.dispatch({ type: "proactive_notice" }); // thinking 下无转换 → 不应推送
    expect(JSON.parse(readFileSync(t.stateFile, "utf8")).seq).toBe(2);
    unbind();
    e.dispatch({ type: "tts_start" }); // thinking → speaking，但已解绑
    expect(JSON.parse(readFileSync(t.stateFile, "utf8")).seq).toBe(2);
  });

  it("强度更新也推送（不触发状态转换但表现需刷新）", () => {
    const t = transport();
    const e = new AvatarStateEngine({ now: () => 1, setTimeoutImpl: () => 0 });
    t.bind(e);
    e.setIntensity(0.77, "处理中");
    expect(JSON.parse(readFileSync(t.stateFile, "utf8"))).toMatchObject({
      seq: 1,
      state: "idle",
      intensity: 0.77,
      caption: "处理中",
    });
  });

  it("waitForAck 命中目标 seq，坏 JSON 返回 null", async () => {
    const t = transport();
    expect(await t.waitForAck(1, 10, 1)).toBeNull();
    writeFileSync(t.ackFile, "{broken");
    expect(t.readAck()).toBeNull();
    writeFileSync(t.ackFile, JSON.stringify({ seq: 1, ok: true, result: '{"ok":true}' }));
    expect(await t.waitForAck(1, 10, 1)).toMatchObject({ seq: 1, ok: true });
  });

  it("重启后延续既有 seq，避免宿主忽略新指令", () => {
    const dir = mkdtempSync(join(tmpdir(), "avatar-resume-"));
    dirs.push(dir);
    const first = new AvatarRenderTransport({ baseDir: dir, sleep: () => Promise.resolve() });
    first.setState("idle");
    first.setState("speaking");
    const second = new AvatarRenderTransport({ baseDir: dir, sleep: () => Promise.resolve() });
    const p = second.setState("working");
    expect(p.seq).toBe(3);
    expect(JSON.parse(readFileSync(second.stateFile, "utf8")).seq).toBe(3);
  });

  it("waitForCapture 以 <path>.done 为准", async () => {
    const t = transport();
    const shot = join(dirs[dirs.length - 1], "shot.png");
    expect(await t.waitForCapture(shot, 10, 1)).toBe(false);
    writeFileSync(shot, "png");
    expect(await t.waitForCapture(shot, 10, 1)).toBe(false); // 仅有 PNG 不算完成
    writeFileSync(`${shot}.done`, "");
    expect(await t.waitForCapture(shot, 10, 1)).toBe(true);
  });
});
