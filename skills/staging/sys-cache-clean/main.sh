#!/bin/sh
# sys-cache-clean：系统缓存清理（高危删除类，PLAN Step 4.4 逐项权限）
#
# 安全设计：
# - dryRun 默认 true（只扫描报告，不删除）
# - 真删必须 dryRun=false + confirm=true（双开关）
# - 白名单目录：~/.cache / npm / pnpm / macOS Caches / jarvis 临时文件
# - 测试重定向：JARVIS_CACHE_CLEAN_ROOT env（默认 $HOME）
# - 每个目录独立 fs_read + fs_delete 权限（registry.run 运行时校验）
#
# 输入：stdin JSON {args:{dryRun,confirm,targets,minSizeMB}}
# 输出：stdout JSON {ok,implemented,result:{...}}
set -e

input=$(cat)
exec python3 - "$input" << 'PYEOF'
import json, os, sys, shutil, time
from pathlib import Path

data = json.loads(sys.argv[1])
args = data.get("args", {}) or {}
dry_run = bool(args.get("dryRun", True))
confirm = bool(args.get("confirm", False))
targets_filter = args.get("targets") or None
min_size_mb = float(args.get("minSizeMB", 1))

# 真删必须双开关（高危红线）
if not dry_run and not confirm:
    print(json.dumps({
        "ok": False, "implemented": True,
        "error": "高危操作需 confirm:true（dryRun=false + confirm=true 双开关）"
    }))
    sys.exit(0)

# 白名单目标（按 root 重定向）
root = Path(os.environ.get("JARVIS_CACHE_CLEAN_ROOT", str(Path.home())))
home = root  # 默认 root=$HOME，测试时 root=/tmp/cache-clean-test

candidates = [
    ("cache", home / ".cache"),
    ("npm", home / ".npm" / "_cacache"),
    ("pnpm", home / ".pnpm-store"),
    ("macos-caches", home / "Library" / "Caches"),
    ("jarvis-tmp", Path("/tmp")),  # 仅 jarvis-* 子项
]

def dir_size_and_count(p):
    total_bytes = 0
    file_count = 0
    if not p.exists():
        return 0, 0
    for dirpath, dirnames, filenames in os.walk(str(p)):
        for f in filenames:
            fp = Path(dirpath) / f
            try:
                total_bytes += fp.stat().st_size
                file_count += 1
            except (OSError, FileNotFoundError):
                pass
    return total_bytes, file_count

results = []
total_size_mb = 0.0
total_files = 0
deleted_count = 0

for label, path in candidates:
    # targets 过滤
    if targets_filter and label not in targets_filter:
        continue

    # jarvis-tmp 特殊处理：只扫 /tmp/jarvis-* 子项
    if label == "jarvis-tmp":
        jarvis_items = list(path.glob("jarvis-*"))
        if not jarvis_items:
            results.append({
                "path": "/tmp/jarvis-*",
                "sizeMB": 0.0, "fileCount": 0,
                "deleted": False, "skipped": "无 jarvis-* 项"
            })
            continue
        for item in jarvis_items:
            bytes_, files = dir_size_and_count(item)
            size_mb = round(bytes_ / 1024 / 1024, 2)
            if size_mb < min_size_mb:
                results.append({
                    "path": str(item), "sizeMB": size_mb, "fileCount": files,
                    "deleted": False, "skipped": "小于阈值 " + str(min_size_mb) + "MB"
                })
                continue
            total_size_mb += size_mb
            total_files += files
            deleted = False
            if not dry_run:
                try:
                    if item.is_dir():
                        shutil.rmtree(str(item))
                    else:
                        item.unlink()
                    deleted = True
                    deleted_count += 1
                except Exception as e:
                    results.append({
                        "path": str(item), "sizeMB": size_mb, "fileCount": files,
                        "deleted": False, "skipped": "删除失败：" + str(e)
                    })
                    continue
            results.append({
                "path": str(item), "sizeMB": size_mb, "fileCount": files,
                "deleted": deleted
            })
        continue

    # 普通目标
    bytes_, files = dir_size_and_count(path)
    size_mb = round(bytes_ / 1024 / 1024, 2)
    if not path.exists():
        results.append({
            "path": str(path), "sizeMB": 0.0, "fileCount": 0,
            "deleted": False, "skipped": "目录不存在"
        })
        continue
    if size_mb < min_size_mb:
        results.append({
            "path": str(path), "sizeMB": size_mb, "fileCount": files,
            "deleted": False, "skipped": "小于阈值 " + str(min_size_mb) + "MB"
        })
        continue
    total_size_mb += size_mb
    total_files += files
    deleted = False
    if not dry_run:
        # 真删：清空目录内容（保留目录本身）
        try:
            for item in path.iterdir():
                if item.is_dir():
                    shutil.rmtree(str(item))
                else:
                    item.unlink()
            deleted = True
            deleted_count += 1
        except Exception as e:
            results.append({
                "path": str(path), "sizeMB": size_mb, "fileCount": files,
                "deleted": False, "skipped": "删除失败：" + str(e)
            })
            continue
    results.append({
        "path": str(path), "sizeMB": size_mb, "fileCount": files,
        "deleted": deleted
    })

total_size_mb = round(total_size_mb, 2)
above_threshold = [r for r in results if r.get("sizeMB", 0) >= min_size_mb]
if dry_run:
    speech = "扫描到 " + str(total_size_mb) + "MB 缓存（" + str(total_files) + " 个文件），涉及 " + str(len(above_threshold)) + " 个目录。dry-run 模式未删除；要真删请 confirm:true。"
else:
    speech = "已清理 " + str(deleted_count) + " 个目录，释放约 " + str(total_size_mb) + "MB（" + str(total_files) + " 个文件）。"

print(json.dumps({
    "ok": True, "implemented": True,
    "result": {
        "dryRun": dry_run,
        "scannedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "targets": results,
        "totalSizeMB": total_size_mb,
        "totalFiles": total_files,
        "deletedCount": deleted_count,
        "speech": speech,
    }
}, ensure_ascii=False))
PYEOF
