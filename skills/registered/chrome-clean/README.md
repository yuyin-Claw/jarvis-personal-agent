# chrome-clean

- 需求：清理 Chrome / Chromium 浏览器缓存（macOS / Linux）
- 形态：skill
- 状态：**已实现**

## 安全行为

- 默认 `dryRun=true`，只扫描不删除。
- 真删必须同时满足 `dryRun=false`、`confirm=true` 和对应目录的 `fs_delete` 授权。
- 只清理 HTTP Cache / Code Cache / GPUCache / Service Worker 缓存。
- 防御性保护 Cookies、Login Data、History、Local Storage 等登录与用户数据。

## 验证

```sh
jarvis capabilities health chrome-clean
jarvis capabilities run chrome-clean '{"args":{"dryRun":true}}'
```
