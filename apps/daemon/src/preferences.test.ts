import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProactiveNotice } from "@jarvis/runtime";
import { notificationsEnabled, PreferenceNotifyChannel } from "./preferences.js";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-notify-pref-"));
  return { dir, file: path.join(dir, "settings.json") };
}

const notice: ProactiveNotice = {
  at: new Date().toISOString(),
  text: "测试通知",
  priority: "normal",
  dedupeKey: "test",
};

describe("主动通知偏好开关", () => {
  it("缺文件/损坏文件默认开启", () => {
    const { dir, file } = fixture();
    expect(notificationsEnabled(file)).toBe(true);
    fs.writeFileSync(file, "bad json");
    expect(notificationsEnabled(file)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("notifyEnabled=false 时不调用底层通道，恢复后继续发送", async () => {
    const { dir, file } = fixture();
    const sent: string[] = [];
    const channel = new PreferenceNotifyChannel({
      send: async (n) => { sent.push(n.text); },
    }, file);
    fs.writeFileSync(file, JSON.stringify({ notifyEnabled: false }));
    await channel.send(notice);
    expect(sent).toEqual([]);
    fs.writeFileSync(file, JSON.stringify({ notifyEnabled: true }));
    await channel.send(notice);
    expect(sent).toEqual(["测试通知"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
