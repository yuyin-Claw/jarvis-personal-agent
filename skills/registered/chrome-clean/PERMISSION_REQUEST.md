# 权限申请单：chrome-clean

- 需求：浏览器缓存清理（高危删除类，dry-run 默认 + confirm 双开关）
- 实现：python3 内嵌，Chrome / Chromium（mac + Linux）缓存目录扫描 + 可选真删
- 高危说明：**本能力涉及删除操作**，按 PLAN Step 4.4 逐项权限申请，
  用户可为每个浏览器独立 grant/revoke

## 权限申请（按浏览器逐项）

| # | 权限 | 用途 | 状态 |
|---|---|---|---|
| 1 | fs_read ~/Library/Caches/Google/Chrome read | 扫描 mac Chrome 缓存 | 申请中 |
| 2 | fs_delete ~/Library/Caches/Google/Chrome delete | 清空 mac Chrome 缓存 | 申请中 |
| 3 | fs_read ~/Library/Caches/Chromium read | 扫描 mac Chromium 缓存 | 申请中 |
| 4 | fs_delete ~/Library/Caches/Chromium delete | 清空 mac Chromium 缓存 | 申请中 |
| 5 | fs_read ~/.cache/google-chrome read | 扫描 Linux Chrome 缓存 | 申请中 |
| 6 | fs_delete ~/.cache/google-chrome delete | 清空 Linux Chrome 缓存 | 申请中 |
| 7 | fs_read ~/.cache/chromium read | 扫描 Linux Chromium 缓存 | 申请中 |
| 8 | fs_delete ~/.cache/chromium delete | 清空 Linux Chromium 缓存 | 申请中 |

## 安全设计（红线）

- **dryRun 默认 true**：未授予 fs_delete 也能跑（只扫描报告）
- **真删双开关**：必须 dryRun=false + confirm=true，否则拒绝执行
- **只清缓存子目录**：Cache / Code Cache / GPUCache / Service Worker/CacheStorage / Service Worker/ScriptCache / ShaderCache / GrShaderCache
- **绝不删用户数据**（防御性黑名单）：Cookies / Login Data / History / Bookmarks / Preferences / Sessions / Web Data / Favicons / Top Sites / Shortcuts / Local State 等
- **大小阈值**：默认 1MB，小于该值跳过
- **清空而非删除目录**：保留目录本身，只清空内容
- **测试重定向**：JARVIS_CHROME_CLEAN_ROOT env 把 root 指向测试目录

## 授予命令（用户逐项执行）

```sh
# 最小授权（只扫描 mac Chrome）
jarvis capabilities grant chrome-clean fs_read ~/Library/Caches/Google/Chrome read

# 完整授权（mac Chrome 扫描 + 真删）
jarvis capabilities grant chrome-clean fs_read ~/Library/Caches/Google/Chrome read
jarvis capabilities grant chrome-clean fs_delete ~/Library/Caches/Google/Chrome delete

# 撤销某项
jarvis capabilities revoke chrome-clean fs_delete ~/Library/Caches/Google/Chrome

# 查看权限对照
jarvis capabilities permissions chrome-clean
```

> 授予动作只能由用户执行（capabilities.db 手工落库或 jarvis capabilities grant），
> Factory/Registry 无自动授予路径。
