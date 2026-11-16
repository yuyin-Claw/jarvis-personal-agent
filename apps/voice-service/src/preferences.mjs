import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SETTINGS_FILE = process.env.JARVIS_SETTINGS_FILE
  ?? path.join(os.homedir(), ".local/share/jarvis/settings.json");

/** 每次请求读取，设置窗口修改后无需重启 voice-service。 */
export function voiceEnabled() {
  try {
    const value = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")).voiceEnabled;
    return value !== false; // 缺字段/损坏文件保持默认开启，兼容既有部署
  } catch {
    return true;
  }
}
