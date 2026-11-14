/**
 * 配置加载：模型端点从环境变量读取（凭证不落配置文件，AGENTS.md 红线）
 *
 * 环境变量（或项目根 .env 文件，key=value 每行一行，不入 git）：
 *   JARVIS_LLM_BASE_URL   默认 GLM coding plan 端点
 *   JARVIS_LLM_API_KEY    必填（或 JARVIS_GL_API_KEY 兼容）
 *   JARVIS_LLM_MODEL      默认 glm-5.3-flash
 *   JARVIS_DB_PATH        默认 ~/.local/share/jarvis/database/jarvis.db
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export interface JarvisConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  dbPath: string;
}

/** 极简 .env 加载（不引依赖；只支持 KEY=VALUE，# 注释） */
function loadDotEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const text = fs.readFileSync(file, "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const k = trimmed.slice(0, eq).trim();
      let v = trimmed.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      out[k] = v;
    }
  } catch {
    // 文件不存在则忽略
  }
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): JarvisConfig {
  // 优先级：真实环境变量 > JARVIS_ENV_FILE 指定文件 > 项目 .env > 仓库 .env
  const envFile = env.JARVIS_ENV_FILE;
  const dotenv = {
    ...(envFile ? loadDotEnv(envFile) : {}),
    ...loadDotEnv(path.join(process.cwd(), ".env")),
    ...loadDotEnv(path.join(process.cwd(), "..", ".env")),
  };
  const get = (k: string): string | undefined => env[k] ?? dotenv[k];

  const apiKey = get("JARVIS_LLM_API_KEY") ?? get("JARVIS_GL_API_KEY") ?? "";
  if (!apiKey) {
    throw new Error(
      "缺少 JARVIS_LLM_API_KEY（设置环境变量，或在 jevis/.env 写入 JARVIS_LLM_API_KEY=...；.env 已被 gitignore）",
    );
  }
  const dbPath =
    get("JARVIS_DB_PATH") ??
    path.join(os.homedir(), ".local", "share", "jarvis", "database", "jarvis.db");
  return {
    baseUrl: get("JARVIS_LLM_BASE_URL") ?? "https://open.bigmodel.cn/api/coding/paas/v4",
    apiKey,
    model: get("JARVIS_LLM_MODEL") ?? "glm-5.3-flash",
    dbPath,
  };
}
