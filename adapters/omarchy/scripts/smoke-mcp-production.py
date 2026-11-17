#!/usr/bin/env python3
"""真实 MCP Factory：从生产 sysinfo 生成 stdio server 并完成 JSON-RPC 调用。"""
import json
import os
import pathlib
import shutil
import subprocess

CORE = pathlib.Path.home() / ".local/share/jarvis/core"
OUT = pathlib.Path("/tmp/jarvis-mcp-production")
REPORT = pathlib.Path("/mnt/mac/mcp-production-result.json")
shutil.rmtree(OUT, ignore_errors=True)
env = {**os.environ, "JARVIS_MCP_ROOT": str(OUT)}
report = {}
try:
    generated = subprocess.run(["node", "apps/daemon/dist/cli.js", "factory", "mcp", "sysinfo"], cwd=CORE, env=env, text=True, capture_output=True, timeout=30)
    assert generated.returncode == 0, generated.stdout + generated.stderr
    versions = subprocess.check_output(["node", "apps/daemon/dist/cli.js", "capabilities", "versions", "sysinfo"], cwd=CORE, text=True)
    server = OUT / "sysinfo@0.1.0/server.mjs"
    proc = subprocess.Popen(["node", str(server)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    responses = []
    for message in [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
        {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "jarvis_sysinfo", "arguments": {}}},
    ]:
        proc.stdin.write(json.dumps(message) + "\n")
        proc.stdin.flush()
        responses.append(json.loads(proc.stdout.readline()))
    proc.kill()
    assert responses[0]["result"]["serverInfo"]["version"] == "0.1.0"
    assert responses[1]["result"]["tools"][0]["name"] == "jarvis_sysinfo"
    assert responses[2]["result"]["isError"] is False, responses[2]
    report = {"ok": True, "generated": generated.stdout, "versions": versions, "responses": responses}
except Exception as e:
    report = {"ok": False, "error": repr(e)}
REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
