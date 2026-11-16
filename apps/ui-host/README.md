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

### 设置中心 API

- `GET /api/status`：真实 settings 与 core/voice/avatar/bridge-agent/ui-host 状态。
- `POST /api/agent`：`{"action":"start"|"stop"|"restart"}`；仅操作 core/voice/avatar，UI Host 与 bridge-agent 保持在线。
- `POST /api/wake-word`：`{"wakeWord":"你好小贾"}`；支持 2-8 个汉字，自动生成 KWS 音素、加载模型校验、热重启 voice，失败回滚。
- `POST /api/preferences`：`{"voiceEnabled":true,"notifyEnabled":true}`；原子写入 settings.json，TTS/通知在下次请求立即生效。

## 界面类型

### settings（设置窗口）

显示真实 agent 状态，支持激活/停用/重启、唤醒词修改、语音反馈和主动通知开关。
窗口加载后自动调用 `/api/status`，不再依赖 render data 注入静态状态。

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

# 中文唤醒词音素生成依赖
python3 -m pip install --user --break-system-packages pypinyin

# 安装 systemd unit
cp apps/ui-host/jarvis-ui-host.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now jarvis-ui-host
```

## Super+J 全局快捷键

`apps/voice-service/deploy/jarvis.lua` 注册 `SUPER + J`：已有设置窗口则聚焦，否则运行 `open-settings.py` 经 UI Host 新建。部署后执行 `hyprctl reload`，并确认 `hyprctl configerrors` 无输出。

## 测试

```sh
# Python 事务与音素测试
cd apps/ui-host/src
python3 agent_control.test.py -v

# 健康检查与真实状态
curl http://localhost:8788/health
curl http://localhost:8788/api/status

# 生成设置窗口（窗口自动加载真实状态）
curl -X POST http://localhost:8788/ui/render \
  -H "content-type: application/json" \
  -d '{"type":"settings","title":"JARVIS 设置","data":{}}'
```
