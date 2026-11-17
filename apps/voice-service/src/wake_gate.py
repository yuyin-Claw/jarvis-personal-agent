"""唤醒词 → 指令的门控状态（无 sherpa_onnx 依赖，便于单测）。"""
import re


def _normalize(text: str) -> str:
    return re.sub(r"[^\w\u4e00-\u9fff]", "", text or "").lower()


class WakeCommandGate:
    def __init__(self, timeout_s: float = 8.0):
        self.timeout_s = timeout_s
        self.active = False
        self.keyword = ""
        self.started_at = 0.0

    def wake(self, keyword: str, now: float):
        self.active = True
        self.keyword = keyword
        self.started_at = now

    def reset(self):
        self.active = False
        self.keyword = ""

    def on_text(self, text: str, now: float) -> str:
        """wait=仅唤醒词/空段，accept=包含实际指令，discard=已超时。"""
        if not self.active:
            return "discard"
        if now - self.started_at > self.timeout_s:
            self.reset()
            return "discard"
        normalized = _normalize(text)
        keyword = _normalize(self.keyword)
        command = normalized[len(keyword):] if keyword and normalized.startswith(keyword) else normalized
        if command in {"停一下", "停止", "停止播放", "别说了", "安静"}:
            self.started_at = now
            return "stop"
        if command in {"休息吧", "去睡觉", "睡觉吧", "晚安", "退下", "进入睡眠", "睡眠模式", "先休息"}:
            self.reset()
            return "sleep"
        if not normalized or normalized == keyword:
            return "wait"
        # 有效指令刷新滑动会话计时；保持 active，5 分钟内无需重复唤醒。
        self.started_at = now
        return "accept"

    def expired(self, now: float) -> bool:
        return self.active and now - self.started_at > self.timeout_s
