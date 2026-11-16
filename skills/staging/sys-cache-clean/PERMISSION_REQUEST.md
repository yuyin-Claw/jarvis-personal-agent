# 权限申请单：sys-cache-clean

- 需求：系统缓存清理（高危删除类，dry-run 默认 + confirm 双开关）
- 实现：python3 内嵌，白名单目录扫描 + 大小阈值过滤 + 可选真删
- 高危说明：**本能力涉及删除操作**，按 PLAN Step 4.4 逐项权限申请，
  用户可为每个目录独立 grant/revoke（例如只授权 ~/.cache，不授权 npm）

## 权限申请（按目录逐项）

| # | 权限 | 用途 | 状态 |
|---|---|---|---|
| 1 | fs_read ~/.cache read | 扫描缓存大小 | 申请中 |
| 2 | fs_read ~/.npm/_cacache read | 扫描 npm 缓存 | 申请中 |
| 3 | fs_read ~/.pnpm-store read | 扫描 pnpm store | 申请中 |
| 4 | fs_read ~/Library/Caches read | 扫描 macOS 用户缓存 | 申请中 |
| 5 | fs_read /tmp/jarvis-* read | 扫描 jarvis 临时文件 | 申请中 |
| 6 | fs_delete ~/.cache delete | 清空 ~/.cache 内容 | 申请中 |
| 7 | fs_delete ~/.npm/_cacache delete | 清空 npm 缓存 | 申请中 |
| 8 | fs_delete ~/.pnpm-store delete | 清空 pnpm store | 申请中 |
| 9 | fs_delete ~/Library/Caches delete | 清空 macOS 用户缓存 | 申请中 |
| 10 | fs_delete /tmp/jarvis-* delete | 删除 jarvis 临时文件 | 申请中 |

## 安全设计（红线）

- **dryRun 默认 true**：未授予 fs_delete 也能跑（只扫描报告）
- **真删双开关**：必须 dryRun=false + confirm=true，否则拒绝执行
- **白名单**：仅上述 5 个目录 + /tmp/jarvis-*，不碰其他路径
- **大小阈值**：默认 1MB，小于该大小跳过（避免无谓 IO）
- **清空而非删除目录**：保留目录本身，只清空内容（避免破坏后续写入）
- **测试重定向**：JARVIS_CACHE_CLEAN_ROOT env 把 root 指向测试目录

## 授予命令（用户逐项执行）

```sh
# 最小授权（只扫描）
jarvis capabilities grant sys-cache-clean fs_read ~/.cache read

# 完整授权（扫描 + 真删 ~/.cache）
jarvis capabilities grant sys-cache-clean fs_read ~/.cache read
jarvis capabilities grant sys-cache-clean fs_delete ~/.cache delete

# 撤销某项
jarvis capabilities revoke sys-cache-clean fs_delete ~/.cache

# 查看权限对照
jarvis capabilities permissions sys-cache-clean
```

> 授予动作只能由用户执行（capabilities.db 手工落库或 jarvis capabilities grant），
> Factory/Registry 无自动授予路径。
