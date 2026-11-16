#!/usr/bin/env python3
"""Omarchy guest 本地记忆模型基准：Qwen3 Embedding 0.6B + Qwen3 4B。"""
import json
import math
import os
import statistics
import subprocess
import time
import urllib.request
from pathlib import Path

BASE = os.environ.get("JARVIS_OLLAMA_BASE_URL", "http://127.0.0.1:11434")
REPORT = Path(os.environ.get("JARVIS_OLLAMA_BENCHMARK_REPORT", "/tmp/ollama-memory-benchmark.json"))

RECORDS = [
    {"id": "coffee", "content": "用户喜欢喝咖啡，尤其偏爱拿铁。"},
    {"id": "glm", "content": "JARVIS 项目决定使用 GLM 作为默认模型。"},
    {"id": "kws", "content": "设置中心可以修改中文唤醒词并自动生成 KWS 音素。"},
    {"id": "chrome", "content": "chrome-clean 只清缓存，保护 Cookies 与登录状态。"},
    {"id": "bridge", "content": "invoke_ui 卡死由 bridge agent 缺少 req 轮询导致。"},
]
QUERIES = [
    ("我喜欢喝什么", "coffee"),
    ("项目默认模型是什么", "glm"),
    ("怎么修改唤醒词", "kws"),
    ("清浏览器会退出登录吗", "chrome"),
    ("弹窗卡死怎么修", "bridge"),
]


def post(path, payload, timeout=180):
    req = urllib.request.Request(BASE + path, data=json.dumps(payload, ensure_ascii=False).encode(), headers={"content-type": "application/json"})
    started = time.perf_counter()
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = json.loads(resp.read().decode())
    return body, (time.perf_counter() - started) * 1000


def cosine(a, b):
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(x * x for x in b))
    return dot / (na * nb) if na and nb else 0


def memory_mb():
    text = subprocess.check_output(["free", "-m"], text=True)
    mem = text.splitlines()[1].split()
    return {"total": int(mem[1]), "used": int(mem[2]), "available": int(mem[6])}


report = {"base": BASE, "memoryBefore": memory_mb()}
try:
    texts = [r["content"] for r in RECORDS]
    embedded, cold_ms = post("/api/embed", {"model": "qwen3-embedding:0.6b", "input": texts})
    vectors = embedded["embeddings"]
    report["embedding"] = {"count": len(vectors), "dimensions": len(vectors[0]), "coldMs": round(cold_ms, 1)}

    query_latencies = []
    recall = []
    for query, expected in QUERIES:
        result, elapsed = post("/api/embed", {"model": "qwen3-embedding:0.6b", "input": query})
        qv = result["embeddings"][0]
        query_latencies.append(elapsed)
        scores = sorted(((cosine(qv, v), r["id"]) for v, r in zip(vectors, RECORDS)), reverse=True)
        recall.append({"query": query, "expected": expected, "top1": scores[0][1], "score": round(scores[0][0], 4), "ok": scores[0][1] == expected})
    report["recall"] = recall
    report["queryLatencyMs"] = {"p50": round(statistics.median(query_latencies), 1), "max": round(max(query_latencies), 1)}

    dialogue = "用户：我喜欢喝咖啡，尤其喜欢拿铁。\n助手：记住了。\n用户：JARVIS 项目决定使用 GLM 作为默认模型，后续不要随意更换。\n助手：明白。"
    prompt = "从对话中提取长期有用的用户偏好与项目决策。每条只能表达一个主题；用户偏好与项目决策必须拆成不同条目，不得合并类别。忽略寒暄，不虚构，不提取敏感信息。\n" + dialogue
    distilled, distill_ms = post("/api/chat", {
        "model": "qwen3:4b",
        "messages": [{"role": "user", "content": prompt}],
        "stream": False,
        "think": False,
        "keep_alive": 0,
        "options": {"temperature": 0},
        "format": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "kind": {"type": "string", "enum": ["user_profile", "conversation_summary", "project", "goal", "decision", "experience"]},
                    "content": {"type": "string"},
                    "confidence": {"type": "number"},
                },
                "required": ["kind", "content", "confidence"],
                "additionalProperties": False,
            },
        },
    })
    candidates = json.loads(distilled["message"]["content"])
    report["distill"] = {"ms": round(distill_ms, 1), "candidates": candidates, "count": len(candidates)}

    loaded = subprocess.check_output(["ollama", "ps"], text=True, env={**os.environ, "PATH": str(Path.home() / ".local/bin") + ":" + os.environ.get("PATH", "")})
    report["qwen4bUnloaded"] = "qwen3:4b" not in loaded
    report["loadedModelsAfterDistill"] = loaded
    report["memoryAfter"] = memory_mb()
    report["ok"] = (
        len(vectors[0]) == 1024
        and sum(1 for r in recall if r["ok"]) >= 4
        and len(candidates) >= 2
        and report["qwen4bUnloaded"]
    )
except Exception as e:
    report["ok"] = False
    report["error"] = repr(e)

REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
