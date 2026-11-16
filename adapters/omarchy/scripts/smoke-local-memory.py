#!/usr/bin/env python3
"""guest 本地记忆生产链路冒烟：Ollama 向量 + Qwen3 蒸馏 + SQLite 索引。"""
import json
import os
import pathlib
import sqlite3
import subprocess

CORE = pathlib.Path.home() / ".local/share/jarvis/core"
DB = pathlib.Path("/tmp/jarvis-local-memory-smoke.db")
REPORT = pathlib.Path("/mnt/mac/local-memory-smoke-result.json")
for p in DB.parent.glob(DB.name + "*"):
    p.unlink()
env = {**os.environ, "JARVIS_DB_PATH": str(DB), "JARVIS_ENV_FILE": "/mnt/mac/jarvis-core.env"}

create = r'''
import { SqliteMemoryEngine } from './packages/memory/dist/index.js';
const m = new SqliteMemoryEngine({path: process.env.JARVIS_DB_PATH});
m.migrate();
const c = m.createConversation('本地记忆冒烟');
m.appendMessage(c.id, 'user', '我喜欢喝咖啡，尤其喜欢拿铁。');
m.appendMessage(c.id, 'assistant', '记住了。');
m.appendMessage(c.id, 'user', 'JARVIS 项目决定使用 GLM 作为默认模型，后续不要随意更换。');
m.appendMessage(c.id, 'assistant', '明白，会遵循这个决定。');
console.log(c.id);
m.close();
'''
conv = subprocess.check_output(["node", "--input-type=module", "-e", create], cwd=CORE, env=env, text=True).strip()
report = {"conversation": conv}

def cli(*args):
    p = subprocess.run(["node", "apps/daemon/dist/cli.js", "memory", *args], cwd=CORE, env=env, text=True, capture_output=True, timeout=240)
    if p.returncode:
        raise RuntimeError(p.stdout + p.stderr)
    return p.stdout + p.stderr

try:
    first = cli("distill", conv)
    assert "降级 GLM" not in first, first
    report["firstDistill"] = first
    second = cli("distill", conv)
    assert "写入/刷新 0 条" in second, second
    report["secondDistill"] = second

    coffee = cli("search", "我喜欢喝什么")
    glm = cli("search", "项目默认模型是什么")
    assert "咖啡" in coffee and "GLM" in glm, (coffee, glm)
    report["semanticSearch"] = {"coffee": coffee, "glm": glm}

    with sqlite3.connect(DB) as db:
        vectors = db.execute("SELECT model, dimensions, COUNT(*) FROM memory_embeddings GROUP BY model, dimensions").fetchall()
    assert vectors and vectors[0][0] == "qwen3-embedding:0.6b" and vectors[0][1] == 1024, vectors
    report["vectors"] = vectors
    report["ok"] = True
except Exception as e:
    report["ok"] = False
    report["error"] = repr(e)

REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
