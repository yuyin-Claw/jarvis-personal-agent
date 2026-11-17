#!/usr/bin/env python3
"""Omarchy Wiki 编译层生产冒烟。"""
import json
import os
import pathlib
import shutil
import subprocess

CORE = pathlib.Path.home() / ".local/share/jarvis/core"
DB = pathlib.Path("/tmp/jarvis-local-memory-smoke.db")
ROOT = pathlib.Path("/tmp/jarvis-wiki-smoke")
REPORT = pathlib.Path("/mnt/mac/wiki-compiler-smoke-result.json")
shutil.rmtree(ROOT, ignore_errors=True)
ROOT.mkdir(parents=True)
(ROOT / "notes.md").write_text("用户手写笔记，编译不得删除", encoding="utf-8")
env = {**os.environ, "JARVIS_DB_PATH": str(DB), "JARVIS_ENV_FILE": "/mnt/mac/jarvis-core.env"}

seed = r'''
import { SqliteMemoryEngine, OllamaEmbeddingProvider } from './packages/memory/dist/index.js';
const m = new SqliteMemoryEngine({path: process.env.JARVIS_DB_PATH, embedding: new OllamaEmbeddingProvider()});
m.migrate();
const conv = m.listConversations()[0].id;
await m.rememberSemantic({kind:'decision',content:'JARVIS 的记忆与模型必须部署在 Omarchy 内',source:'user_correction',sourceRef:conv+':decision'});
await m.rememberSemantic({kind:'experience',content:'LLM 生成页面必须保留来源且不能覆盖用户文件',source:'user_correction',sourceRef:conv+':experience'});
m.close();
'''
report = {}
try:
    subprocess.run(["node", "--input-type=module", "-e", seed], cwd=CORE, env=env, check=True, text=True, capture_output=True, timeout=60)
    compiled = subprocess.run(["node", "apps/daemon/dist/cli.js", "memory", "wiki", str(ROOT)], cwd=CORE, env=env, text=True, capture_output=True, timeout=240)
    assert compiled.returncode == 0, compiled.stdout + compiled.stderr
    output = compiled.stdout + compiled.stderr
    assert "概览模式 llm" in output, output
    required = ["index.md", "overview.md", "SCHEMA.md", "log.md", "user/preferences.md", "projects/index.md", ".jarvis-wiki-manifest.json"]
    for rel in required:
        assert (ROOT / rel).exists(), rel
    decisions = list((ROOT / "decisions").glob("mem_*.md"))
    experiences = list((ROOT / "experiences").glob("mem_*.md"))
    assert decisions and experiences
    assert "source_ref:" in decisions[0].read_text(encoding="utf-8")
    assert (ROOT / "notes.md").read_text(encoding="utf-8") == "用户手写笔记，编译不得删除"
    overview = (ROOT / "overview.md").read_text(encoding="utf-8")
    assert "## 当前重点" in overview and "## 关键决策" in overview and "## 用户偏好" in overview, overview
    assert "我需要" not in overview and "首先，用户要求" not in overview, overview
    assert "JAR:VIS" not in overview, overview
    assert len(overview.splitlines()) < 80, len(overview.splitlines())

    loaded = subprocess.check_output(["ollama", "ps"], text=True, env={**os.environ, "PATH": str(pathlib.Path.home() / ".local/bin") + ":" + os.environ.get("PATH", "")})
    assert "qwen3:4b" not in loaded, loaded
    shutil.copy(ROOT / "index.md", "/mnt/mac/wiki-index-smoke.md")
    shutil.copy(ROOT / "overview.md", "/mnt/mac/wiki-overview-smoke.md")
    report.update(ok=True, output=output, decisionPages=len(decisions), experiencePages=len(experiences), qwen4bUnloaded=True, root=str(ROOT))
except Exception as e:
    report.update(ok=False, error=repr(e))

REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
