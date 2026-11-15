#!/usr/bin/env node
// 在 Omarchy guest 内运行：输出五端点探测结果（真实依赖状态，不假装成功）
import { OmarchyPlatformAdapter } from "../dist/index.js";

// guest 自包含包通过环境变量显式指向随包携带的渲染层与宿主脚本
const opts = {};
if (process.env.JARVIS_AVATAR_HTML) opts.htmlPath = process.env.JARVIS_AVATAR_HTML;
if (process.env.JARVIS_HOST_SCRIPT) opts.hostScript = process.env.JARVIS_HOST_SCRIPT;
const adapter = new OmarchyPlatformAdapter(opts);
const statuses = await adapter.probe();
for (const s of statuses) {
  console.log(`${s.endpoint.padEnd(14)} ${s.state.padEnd(12)} ${s.detail ?? ""}`);
}
console.log(JSON.stringify(statuses));
