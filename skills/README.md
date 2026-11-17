# JARVIS Skills（Factory 产物备份）

本目录是 **Factory 生成的真实能力代码的 mac 侧备份**。

## 为什么有这个目录

JARVIS 的能力闭环（ADR-011）让 JARVIS 能「自己长出能力」——capability_gap 触发 Factory 生成骨架 → 用户审批 → 注册 → 实现 → 对话直调 invoke_capability。

这些能力的代码默认落在 **guest 内**（`~/.local/share/jarvis/skills/` 和 `~/.local/share/jarvis/.factory-staging/`），**不在 git 仓库**。VM 重装或损坏 = 真实能力全丢。

本目录把这些代码同步回 mac 仓库，纳入 git 追踪，防丢。

## 目录结构

```
skills/
├── registered/    ← 已注册能力（guest ~/.local/share/jarvis/skills/）
│   ├── sysinfo/            参照 Skill：只读系统信息（零权限）
│   ├── weather-briefing/   首个真实能力：wttr.in 天气查询（network 权限）
│   └── chrome-clean/       已实现：浏览器缓存清理（dry-run 默认 + confirm + 数据保护）
└── staging/       ← 待审骨架（guest ~/.local/share/jarvis/.factory-staging/）
    └── sys-cache-clean/    待审：系统缓存清理（高危删除类，需逐项权限申请）
```

## 同步协议

**guest → mac**（推荐每天一次或每次实现新能力后）：

```sh
# 1. guest 内打包
sh adapters/omarchy/scripts/gexec.sh \
  'tar czf /tmp/skills-backup.tar.gz -C ~/.local/share/jarvis skills .factory-staging'

# 2. 经通道 base64 回传
sh adapters/omarchy/scripts/gexec.sh \
  'base64 -w0 /tmp/skills-backup.tar.gz' | tail -1 | tr -d '\r\n' > /tmp/skills-backup.b64

# 3. mac 侧解码并覆盖到 skills/
base64 -d /tmp/skills-backup.b64 > /tmp/skills-backup.tar.gz
rm -rf /tmp/skills-extract && mkdir -p /tmp/skills-extract
tar xzf /tmp/skills-backup.tar.gz -C /tmp/skills-extract
rsync -a --delete /tmp/skills-extract/skills/ skills/registered/
rsync -a --delete /tmp/skills-extract/.factory-staging/ skills/staging/

# 4. 清理冗余（已 approve 实现的 staging 骨架）
# 手动检查 skills/staging/ 与 skills/registered/ 重复项并 rm

# 5. 提交
git add skills/ && git commit -m "chore(skills): 同步 guest 真实能力代码"
```

**mac → guest**（恢复 / 部署到干净 VM）：

```sh
# 打包 mac 仓库 skills/ → 9p → guest 解包到 ~/.local/share/jarvis/
tar czf /Users/yuyin/Omarchy/skills-restore.tar.gz -C skills registered staging
sh adapters/omarchy/scripts/gexec.sh \
  'tar xzf /mnt/mac/skills-restore.tar.gz -C /tmp && \
   rsync -a /tmp/registered/ ~/.local/share/jarvis/skills/ && \
   rsync -a /tmp/staging/ ~/.local/share/jarvis/.factory-staging/'
```

## 注意

- **不追踪 capabilities.db**（注册表数据库）——它在 guest 内，每次注册状态可能不同。恢复后需要重跑 `capabilities approve <name>` 或手动 SQL 同步
- **不追踪权限授予状态**——权限是运行时用户批准落库的，备份只保留申请单（PERMISSION_REQUEST.md），恢复后需要重新 `capabilities grant`
- **staging 是临时态**——已 approve 实现的骨架应当从 staging 删除（保留在 registered 即可）

## 当前能力状态（2026-11-17）

| 能力 | 状态 | 权限 |
|---|---|---|
| sysinfo | ✅ 已实现（参照） | 零 |
| weather-briefing | ✅ 已实现 + 对话直调 | network（wttr.in:80，**待 grant**） |
| chrome-clean | ✅ 已实现（dry-run 默认；真删需 confirm + 逐项权限） | fs_read / fs_delete（按浏览器目录；保护 Cookies / Login Data / History） |
| sys-cache-clean | ⏳ staging 待审 | 高危删除类，需逐项审批 |
