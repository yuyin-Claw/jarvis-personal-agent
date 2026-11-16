# JARVIS Dynamic UI Host（FR-12）

按需生成交互界面——任务列表 / 设置窗口 / 确认对话框 / 进度条。

## 架构

```
Orchestrator → UI Host（HTTP API）→ HTML 渲染 → webkit2gtk 窗口弹出
用户操作 → UI Host 回传结果 → Orchestrator 继续执行
```

## API

### POST /ui/render

生成界面并弹出窗口。

**请求**：
```json
{
  "type": "settings" | "task_list" | "confirm" | "progress" | "custom",
  "title": "JARVIS 设置",
  "data": {...},
  "actions": [{"id": "ok", "label": "确定"}, {"id": "cancel", "label": "取消"}]
}
```

**响应**：
```json
{"ok": true, "windowId": "abc12345", "htmlPath": "..."}
```

### GET /ui/result/<windowId>

查询用户操作结果。

**响应**：
```json
{"ok": true, "windowId": "abc12345", "result": {"action": "ok", "data": {...}, "at": 1234567890}}
```

### POST /ui/close/<windowId>

关闭窗口。

### GET /health

健康检查。

## 界面类型

### settings（设置窗口）

显示 agent 状态 + 唤醒词设置 + 语音反馈 / 主动通知开关。

**data**：
```json
{
  "agentStatus": {"jarvis-core": true, "jarvis-voice": true, "jarvis-avatar": false},
  "wakeWord": "你好贾维斯",
  "voiceEnabled": true,
  "notifyEnabled": true
}
```

### task_list（任务列表）

显示任务列表。

**data**：
```json
{
  "tasks": [
    {"subject": "写报告", "status": "running"},
    {"subject": "改 bug", "status": "done"}
  ]
}
```

### confirm（确认对话框）

显示确认消息。

**data**：
```json
{"message": "确定要删除此文件吗？"}
```

### progress（进度条）

显示进度条。

**data**：
```json
{"percent": 75, "message": "处理中..."}
```

## 部署

```sh
# 复制到 guest
cp -r apps/ui-host ~/.local/share/jarvis/

# 安装 systemd unit
cp apps/ui-host/jarvis-ui-host.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now jarvis-ui-host
```

## 测试

```sh
# 健康检查
curl http://localhost:8788/health

# 生成设置窗口
curl -X POST http://localhost:8788/ui/render \
  -H "content-type: application/json" \
  -d '{
    "type": "settings",
    "title": "JARVIS 设置",
    "data": {
      "agentStatus": {"jarvis-core": true, "jarvis-voice": true},
      "wakeWord": "你好贾维斯"
    }
  }'
```
