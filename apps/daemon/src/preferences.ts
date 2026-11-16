import { readFileSync } from "node:fs";
import type { NotifyChannel, ProactiveNotice } from "@jarvis/runtime";

export function notificationsEnabled(settingsFile: string): boolean {
  try {
    const value = JSON.parse(readFileSync(settingsFile, "utf8")) as { notifyEnabled?: unknown };
    return value.notifyEnabled !== false; // 缺字段/损坏文件保持默认开启
  } catch {
    return true;
  }
}

/** 设置窗口的主动通知开关：发送前读取，修改后无需重启 daemon。 */
export class PreferenceNotifyChannel implements NotifyChannel {
  constructor(
    private readonly inner: NotifyChannel,
    private readonly settingsFile: string,
  ) {}

  async send(notice: ProactiveNotice): Promise<void> {
    if (!notificationsEnabled(this.settingsFile)) return;
    await this.inner.send(notice);
  }
}
