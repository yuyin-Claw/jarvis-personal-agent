-- JARVIS 数字人窗口规则（Try Omarchy Lua 配置体系）
-- 安装：~/.config/hypr/jarvis.lua，并在 ~/.config/hypr/hyprland.lua 追加：
--   require("hypr.jarvis")
-- 生效：hyprctl reload
--
-- 生产形态 = 右下角浮动小窗（420x480、置顶、不抢焦点）。
-- 注意 Try Omarchy 用 Lua 配置（helpers.lua 的 o.window），传统 hyprland.conf
-- 的 windowrule 行在此环境不被加载；move 用计算式元组（见 apps/pip.lua 示例）。

o.window("jarvis-avatar-host.py", {
  float = true,
  size = "420 480",
  -- 右下角：屏幕逻辑尺寸 - 窗口 - 边距（镜像 apps/pip.lua 的画中画位置）
  move = { "(monitor_w-window_w-40)", "(monitor_h-window_h-40)" },
  pin = true,            -- 所有工作区可见（置顶钉住）
  no_blur = true,
  no_initial_focus = true, -- 启动不抢焦点（键名须下划线：官方 apps/*.lua 同款）
})

-- 透明悬浮球：显式开透明（默认 GTK 透明视觉 + WebKit 透明背景）
o.transparent_window("jarvis-avatar-host.py", "1.0 1.0")
