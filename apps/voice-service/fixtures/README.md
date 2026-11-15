# 测试语音 fixtures

真实人声中文语音波形（16 kHz / mono / 16-bit WAV），供验收脚本在**任何系统**
上直接读取，不再依赖 `say` 等宿主专有工具生成（ADR-009 零 macOS 依赖红线）。

| 文件 | 内容 | 已被真实 ASR 验证过的转写 |
| --- | --- | --- |
| `zh-user-utterance.wav` | 「请介绍一下你自己」 | whisper base → `请介绍一下你自己。` |
| `zh-interrupt.wav` | 「等一下，我有个问题」 | whisper base → `等一下，我有个问题` |

来源：2026-11-15 macOS 真实语音对话验收留档（AIFF → 16k WAV 转码）。
该验收路径已随 MacBackend 一并移除；fixture 是它留给独立语音服务的唯一遗产。
