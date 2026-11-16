# JARVIS 冒烟质检（十域 25 项断言）

在 Omarchy guest 内执行（需 9p 挂载 /mnt/mac）：

```sh
sh /mnt/mac/smoke-part1.sh   # 域1-5：systemd/config/语音/实时链路/对话审批
sh /mnt/mac/smoke-part2.sh   # 域6-10：数字人/能力闭环/通知状态机/数据层/管道多轮
```

- 每项输出 PASS/FAIL，末尾汇总
- 需要 GLM key（JARVIS_ENV_FILE=/mnt/mac/jarvis-core.env）
- live 链路依赖 jarvis-mic null-sink（jarvis-mic.conf 已持久化到
  ~/.config/pipewire/pipewire.conf.d/，重启自动加载）
- 高危审批门测试用唯一路径（$$ 后缀）避免重复任务被 GLM 判 continue_task
