#!/usr/bin/env python3
"""Wiki Lint + 用户纠正/删除闭环的 guest 生产冒烟。"""
import json
import os
import pathlib
import shutil
import subprocess

CORE = pathlib.Path.home() / ".local/share/jarvis/core"
DB = pathlib.Path("/tmp/jarvis-local-memory-smoke.db")
ROOT = pathlib.Path("/tmp/jarvis-wiki-correction")
REPORT = pathlib.Path("/mnt/mac/wiki-lint-correction-result.json")
base = {**os.environ, "JARVIS_ENV_FILE": "/mnt/mac/jarvis-core.env"}
report = {}

def cli(args, env, timeout=240):
    p = subprocess.run(["node", "apps/daemon/dist/cli.js", "memory", *args], cwd=CORE, env=env, text=True, capture_output=True, timeout=timeout)
    if p.returncode:
        raise RuntimeError(p.stdout + p.stderr)
    return p.stdout + p.stderr

try:
    lint = cli(["lint"], base)
    lint_path = pathlib.Path.home() / ".local/share/jarvis/memory/wiki/lint.md"
    assert lint_path.exists()
    shutil.copy(lint_path, "/mnt/mac/production-wiki-lint.md")
    report["lint"] = lint

    shutil.rmtree(ROOT, ignore_errors=True)
    env = {**base, "JARVIS_DB_PATH": str(DB), "JARVIS_WIKI_ROOT": str(ROOT)}
    get_id = r'''import {SqliteMemoryEngine} from './packages/memory/dist/index.js'; const m=new SqliteMemoryEngine({path:process.env.JARVIS_DB_PATH}); m.migrate(); let r=m.list({kind:'decision'})[0]; if(!r) r=m.remember({kind:'decision',content:'待纠正决策',source:'test'}); console.log(r.id); m.close();'''
    memory_id = subprocess.check_output(["node", "--input-type=module", "-e", get_id], cwd=CORE, env=env, text=True).strip()
    corrected = cli(["correct", memory_id, "JARVIS 的模型与记忆必须部署在 Omarchy 内（已复核）"], env)
    pages = list((ROOT / "decisions").glob("mem_*.md"))
    assert any("已复核" in p.read_text(encoding="utf-8") for p in pages), corrected
    report["correct"] = corrected

    deleted = cli(["delete", memory_id], env)
    assert not (ROOT / "decisions" / f"{memory_id}.md").exists(), deleted
    report["delete"] = deleted
    report["ok"] = True
except Exception as e:
    report["ok"] = False
    report["error"] = repr(e)

REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
