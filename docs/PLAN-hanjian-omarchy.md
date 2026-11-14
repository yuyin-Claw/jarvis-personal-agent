# 汉化 Omarchy 计划（fork 维护中文版）

> 独立产品线，与 JARVIS 仓库分离。本文件是行动计划，动工前需完成第 1 步盘点。

## 背景事实

- Omarchy 4.5.0（2026-11-05 发布）已带多语言支持与新版通知系统——**中文覆盖度未查**
- 上游更新节奏快（4.5 → 未来版本），fork 维护成本 = 每次上游 release 的 rebase 工作量
- ADR-003（docs/decisions.md）：汉化 fork 不得与 JARVIS 耦合

## 第 0 步：环境就绪（已完成）

- [x] Try Omarchy v1.2.0 已装于 macOS（VM 内即 Omarchy 环境）
- [x] VM 首次启动完成（2026-11-14 用户确认）
- [x] **中文汉化程度实测：差**（用户目视确认，2026-11-14）——fork 补全的价值已坐实
- [ ] VM 内进一步定位：哪些界面是英文（first-run 向导/bar/通知/Agent 面板/设置项）

## 第 1 步：盘点中文缺口（动工前的硬前提）

在 VM（或上游 GitHub）中盘点：
- [ ] 上游 i18n 机制：语言文件位置（若为 Quickshell/QML 则是 qs-ts 翻译文件；若为主题文案则在 default/ 配置）
- [ ] 中文（zh-CN）现有覆盖率：完全缺失 / 部分翻译 / 已完整
- [ ] 无 i18n 钩子的硬编码文案规模（bar、first-run 向导、通知、Agent 面板等）
- [ ] 字体链：中文字体（Noto Sans CJK）是否默认安装、Hyprland/终端/浏览器渲染是否正常

**分支决策**：若上游 i18n 已覆盖中文 → 直接配置即得，fork 仅做少量补翻，成本大降；若硬编码为主 → 进入第 2 步全量汉化。

## 第 2 步：fork 与汉化工程

- [ ] fork basecamp/omarchy → 独立仓库（建议名 omarchy-zh）
- [ ] 建立翻译文件层：文案与代码分离，遵循上游现有 i18n 结构（若有）；无则按 ADR-008 借鉴的 default/ + refresh 模式自建 overlay
- [ ] 分优先级翻译：P0 first-run 向导/系统通知/Agent 面板 → P1 bar/快捷键提示 → P2 文档 README
- [ ] 中文字体与输入法：确认 fcitx5/rime 在 Hyprland 下的配置模板并入 default/
- [ ] 构建验证：VM 内完整跑一遍安装向导 + 日常操作截图对比

## 第 3 步：维护机制（长期）

- [ ] 每周 upstream 差异检查（上游 4.x 迭代快，rebase 拖延 = 成本指数增长）
- [ ] 翻译表用工具管理（提取-合并脚本），避免每次 rebase 手工比对
- [ ] 时机成熟时向上游回馈翻译（减少自有维护面）

## 风险

| 风险 | 对策 |
|---|---|
| 上游无 i18n 钩子，硬编码遍布 | 工作量从"配置"变"工程"，先完成第 1 步盘点再决策投入 |
| rebase 冲突累积 | 文案改动集中在独立目录/文件，不散落修改上游源文件 |
| 商标：Omarchy 名字与 logo 归 Omacom 基金会 | fork 分发需注意命名（如 "Omarchy 中文社区版" 需谨慎，先查商标政策） |
| Try Omarchy VM 是只读体验版 | 正式 fork 构建需在 VM 内装完整 Arch/Omarchy 环境（VM 本身可装包） |
