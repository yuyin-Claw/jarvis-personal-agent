#!/usr/bin/env node
// 0.2-③ 输入端验收：编译后的 Swift 助手 --status-only 权限探测。
// 未授权是合法结果（Core 自动降级文本输入），因此断言的是「探测链路可用」。
import { probeSpeechPermissions } from "../dist/index.js";

const status = await probeSpeechPermissions();
if (!status) {
  console.error("FAIL: 权限探测无返回（二进制缺失或输出异常）");
  process.exit(1);
}
console.log(`PASS  SFSpeechRecognizer 可用：${status.available}，locale=${status.locale ?? "n/a"}`);
console.log(`      语音识别授权：${status.speech}；麦克风授权：${status.mic}`);
const ready = status.speech === "authorized" && status.mic === "granted" && status.available;
console.log(
  ready
    ? "PASS  实时语音识别可用，可启动 SpeechInput.start()"
    : "PASS  权限未就绪 → Core 自动降级文本输入（不弹系统授权窗，主流程不阻塞）",
);
