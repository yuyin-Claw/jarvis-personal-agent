# 汉化 Omarchy 计划（fork 维护中文版）

> 独立产品线，与 JARVIS 仓库分离。
> **2026-11-14 盘点完成——结论：上游 zh-CN 翻译已近乎完整，fork 全量汉化不需要，转向「配置 + 补缺 + 反馈上游」路线。**

## 盘点结论（2026-11-14，上游 commit 723072a = VM 实际运行版本）

### 上游 i18n 机制（远比预期完善）

- `default/i18n/`：53 语言目录，每语言 4 个 catalog（menu.json / shell.json / cli.json / keybindings.json）+ 51 篇中文手册 `manual/zh-CN/`
- 语言注册表 `default/i18n/locales.json`（zh-CN 在列）；切换命令 `omarchy-language zh-CN`
- 复数规则：中文只需 `other` 类别（plural.jq 明确 zh-CN/zh-TW/ja/ko 同组）——缺 `.one` 键是**正确状态非缺陷**
- 翻译由 CI 机器人（Muse）自动同步：`scripts/i18n-sync.py` + translation-manifest.json 按英文源 hash 追赶
- 终端输出/诊断/开发者画廊按设计保留英文

### zh-CN 覆盖率实测（VM 所用 commit 723072a，2026-11-14 上游 HEAD 附近）

| Catalog | 英文键数 | zh-CN | 覆盖率 |
|---|---|---|---|
| menu.json | 437 | 437 | 100% |
| shell.json | 555 | 555 | 100% |
| cli.json | 434 | 434 | 100% |
| keybindings.json | 193 | 193 | 100% |
| manual（手册） | 51 篇 | 51 篇 | 100% |

- 占位符（%1/%2）全量校验：0 不匹配
- zh==en 的词条仅个位数，全部是品牌/专名（Dropbox、Ping），符合上游翻译规范（产品名保留英文）
- 质量抽查（搜索/取消/电池/电源等高频词）：翻译正常

### 用户 VM 里看到"汉化差"的真实原因（待验证假设）

VM 传参已带 `tryomarchy.mac_language=zh tryomarchy.locale=zh_CN.UTF-8`，但**Omarchy 自身语言是独立设置**（`~/.config/omarchy/language`，Setup > Language 菜单切换；宿主 locale 只影响 LANG 环境变量）。最可能：首次启动 owner setup 未选中文，Omarchy 界面语言仍是英文默认。
**验证方法：VM 内 Super 菜单 → Setup → Language → 简体中文；或终端 `omarchy-language zh-CN`。**

## 修正后的行动计划（替代原第 2/3 步全量 fork）

### 第 1 步：VM 内切换中文并实测（5 分钟）

- [ ] VM 内执行 `omarchy-language zh-CN`（或菜单 Setup > Language > 简体中文）
- [ ] 截图核对：菜单/bar/通知/快捷键提示/设置项/手册是否全部中文
- [ ] 若有个别词条仍英文 → 记录具体 key（用上游 catalog 比对确认是"翻译缺失"还是"按规范保留"）

### 第 2 步：按实测结果分叉

- **情况 A（大概率）：切换后即全中文** → 取消 fork 计划。剩余工作：
  - [ ] 中文字体与 fcitx5/rime 输入法配置确认（中文语言自带输入法与 CJK 字形，docs/input-methods.md）
  - [ ] 找到的真实缺失词条 → 直接向上游提 PR/i18n-sync（上游有完善翻译流程，回馈成本低于自维护）
  - [ ] Try Omarchy 的 first-boot owner setup 未跟随宿主语言的问题 → 向 omacom/try-omarchy 反馈
- **情况 B（小概率）：切换后仍有成片英文** → 定位是 catalog 缺失还是硬编码：
  - catalog 缺失 → 补翻译提 PR（上游机器人流程会自动接收）
  - 硬编码（bin/ 安装脚本等）→ 上游设计如此（终端/诊断保留英文），评估是否值得 fork

### 原 fork 维护路线（已降级为备选，仅在 B 且上游拒收 PR 时启用）

- [ ] fork basecamp/omarchy → omarchy-zh；每周 upstream 差异检查
- [ ] 注意商标：Omarchy 名/logo 归 Omacom 基金会，分发需查政策

## 经验记录

- Try Omarchy VM 的 Omarchy 版本看 `guest-status.json`（本次为 4.0.0.r7848.g723072a-1，edge 滚动构建，非 4.5.0 正式版）
- 上游翻译规范：品牌名/技术缩写/键名/占位符保留原文；终端输出不翻译
- 结论性教训：**"看起来没汉化"≠"没有汉化"——先查语言设置，再查翻译覆盖**（本盘点避免了一次多余的 fork）
