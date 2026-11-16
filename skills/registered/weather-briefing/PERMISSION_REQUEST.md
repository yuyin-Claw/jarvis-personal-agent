# 权限申请单：weather-briefing

- 需求：每日天气查询与播报
- 实现：wttr.in HTTP 只读查询（format=j1），无文件写入、无系统调用

| 权限 | 用途 | 状态 |
|---|---|---|
| network（wttr.in:80 connect） | 天气数据查询 | 申请中（skill.json 声明；授予需用户手工落库） |

> 授予动作只能由用户执行（capabilities.db 手工落库），Factory/Registry 无自动授予路径。
