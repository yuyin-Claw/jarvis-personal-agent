#!/bin/sh
# weather-briefing：每日天气查询与播报文本（wttr.in，HTTP 无需 key）
# 输入：stdin JSON {"args": {"city": "Shanghai", "lang": "zh"}}
# 输出：stdout JSON {ok, implemented:true, result:{city, tempC, feelsLikeC,
#   desc, windKmph, humidity, speech, raw?}}
# 权限：仅 network（wttr.in 只读）；无文件写入、无系统调用。

# 读 stdin JSON 并提取 city（无 jq 依赖：sed 提取 "city":"..." 或 "city": "..."）
input=$(cat)
city=$(printf %s "$input" | sed -n 's/.*"city" *: *"\([^"]*\)".*/\1/p')
[ -z "$city" ] && city="Shanghai"
lang=$(printf %s "$input" | sed -n 's/.*"lang" *: *"\([^"]*\)".*/\1/p')
[ -z "$lang" ] && lang="zh"

# wttr.in JSON 格式（format=j1）；HTTP（VM 出网 HTTPS 受限，HTTP 可达）
url="http://wttr.in/$(printf %s "$city" | sed 's/ /%20/g')?format=j1&lang=$lang"
resp=$(curl -s --max-time 15 "$url" 2>/dev/null)
[ -z "$resp" ] && { printf '{"ok": false, "implemented": true, "error": "wttr.in 无响应（网络不可达）"}\n'; exit 0; }

# 提取当前天气（python3 解析 JSON，比 sed 可靠）
printf %s "$resp" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    c = d['current_condition'][0]
    temp = c.get('temp_C','?')
    feels = c.get('FeelsLikeC','?')
    # 中文描述优先（lang=zh 时 wttr 返回 lang_zh 字段）
    desc = (c.get('lang_zh') or [{}])
    if isinstance(desc, list) and desc:
        desc = desc[0].get('value','')
    if not desc:
        desc = c.get('weatherDesc',[{}])[0].get('value','?')
    # 常见天气英文→中文（wttr 对 zh 的 lang_zh 字段常为空，映射兜底）
    ZH = {'Sunny':'晴','Clear':'晴','Partly cloudy':'多云间晴','Cloudy':'阴',
          'Overcast':'阴','Mist':'薄雾','Fog':'雾','Smoky haze':'霾',
          'Light rain':'小雨','Moderate rain':'中雨','Heavy rain':'大雨',
          'Light drizzle':'毛毛雨','Patchy rain possible':'可能有零星小雨',
          'Thunderstorm':'雷暴','Snow':'雪','Light snow':'小雪','Haze':'霾'}
    desc = ZH.get(desc, desc)
    wind = c.get('windspeedKmph','?')
    hum = c.get('humidity','?')
    city = '$city'
    speech = f'{city}现在气温{temp}度，{desc}，体感{feels}度，风速每小时{wind}公里，湿度{hum}%。'
    print(json.dumps({
        'ok': True, 'implemented': True,
        'result': {'city': city, 'tempC': temp, 'feelsLikeC': feels,
                   'desc': desc, 'windKmph': wind, 'humidity': hum, 'speech': speech}
    }, ensure_ascii=False))
except Exception as e:
    print(json.dumps({'ok': False, 'implemented': True, 'error': '解析失败: '+str(e)}, ensure_ascii=False))
"
