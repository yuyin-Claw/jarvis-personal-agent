#!/bin/sh
# chrome-clean：浏览器缓存清理（高危删除类，PLAN Step 4.4 逐项权限）
#
# 安全设计：
# - dryRun 默认 true（只扫描报告）
# - 真删必须 dryRun=false + confirm=true（双开关）
# - 只删缓存：Cache / Code Cache / GPUCache / Service Worker 缓存目录
# - **绝不删**：Cookie / Login Data / History / Bookmarks / Preferences / Sessions
# - 测试重定向：JARVIS_CHROME_CLEAN_ROOT env（默认 $HOME）
# - 按浏览器独立 fs_read + fs_delete 权限
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

# 浏览器目标（按 root 重定向）
root = Path(os.environ.get("JARVIS_CHROME_CLEAN_ROOT", str(Path.home())))
home = root

# 浏览器路径（mac + Linux 主流路径）
browsers = [
    ("chrome-mac", home / "Library" / "Caches" / "Google" / "Chrome"),
    ("chromium-mac", home / "Library" / "Caches" / "Chromium"),
    ("chrome-linux", home / ".cache" / "google-chrome"),
    ("chromium-linux", home / ".cache" / "chromium"),
]

# 只清理这些子目录（缓存相关，**不含用户数据**）
CACHE_SUBDIRS = [
    "Cache",
    "Code Cache",
    "GPUCache",
    "Service Worker/CacheStorage",
    "Service Worker/ScriptCache",
    "ShaderCache",
    "GrShaderCache",
]

# **绝不删除**的用户数据（防御性黑名单，遇到就跳过）
NEVER_DELETE = {
    "Cookies", "Cookies-journal",
    "Login Data", "Login Data-journal",
    "History", "History-journal",
    "Bookmarks", "Bookmarks.bak",
    "Preferences", "Secure Preferences",
    "Sessions", "Current Session", "Last Session",
    "Web Data", "Web Data-journal",
    "Favicons", "Favicons-journal",
    "Top Sites", "Top Sites-journal",
    "Shortcuts", "Shortcuts-journal",
    "Network Action Predictor",
    "Visited Links",
    "Local State",
}

def dir_size_and_count(p):
    total_bytes = 0
    file_count = 0
    if not p.exists():
        return 0, 0
    for dirpath, dirnames, filenames in os.walk(str(p)):
        # 防御：遇黑名单目录直接剪枝（不进入）
        dirnames[:] = [d for d in dirnames if d not in NEVER_DELETE]
        for f in filenames:
            if f in NEVER_DELETE:
                continue
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

for brand, browser_root in browsers:
    # targets 过滤
    if targets_filter and brand not in targets_filter:
        continue

    if not browser_root.exists():
        results.append({
            "browser": brand, "path": str(browser_root),
            "sizeMB": 0.0, "fileCount": 0,
            "deleted": False, "skipped": "浏览器目录不存在"
        })
        continue

    # 扫描浏览器根下的缓存子目录（含 Default/Profile 各 profile）
    # Chrome 结构：root/Default/Cache, root/Profile 1/Cache, ...
    # 也可能 root 直接就是缓存目录（mac Caches 路径已细分）
    cache_targets = []

    # 情况 1：root 本身就是缓存根（macOS ~/Library/Caches/Google/Chrome）
    for sub in CACHE_SUBDIRS:
        # 在 root 直接下找
        direct = browser_root / sub
        if direct.exists():
            cache_targets.append((f"{brand}/{sub}", direct))
        # 在 root/Default 或 root/Profile * 下找
        for profile_dir in browser_root.glob("Default"):
            if profile_dir.is_dir():
                prof_target = profile_dir / sub
                if prof_target.exists():
                    cache_targets.append((f"{brand}/Default/{sub}", prof_target))
        for profile_dir in browser_root.glob("Profile *"):
            if profile_dir.is_dir():
                prof_target = profile_dir / sub
                if prof_target.exists():
                    cache_targets.append((f"{brand}/{profile_dir.name}/{sub}", prof_target))

    if not cache_targets:
        results.append({
            "browser": brand, "path": str(browser_root),
            "sizeMB": 0.0, "fileCount": 0,
            "deleted": False, "skipped": "无缓存子目录"
        })
        continue

    for label, cache_dir in cache_targets:
        bytes_, files = dir_size_and_count(cache_dir)
        size_mb = round(bytes_ / 1024 / 1024, 2)
        if size_mb < min_size_mb:
            results.append({
                "browser": brand, "path": str(cache_dir),
                "sizeMB": size_mb, "fileCount": files,
                "deleted": False, "skipped": f"小于阈值 {min_size_mb}MB"
            })
            continue
        total_size_mb += size_mb
        total_files += files
        deleted = False
        if not dry_run:
            # 真删：清空目录内容（保留目录本身）
            try:
                for item in cache_dir.iterdir():
                    if item.name in NEVER_DELETE:
                        continue
                    if item.is_dir():
                        shutil.rmtree(str(item))
                    else:
                        item.unlink()
                deleted = True
                deleted_count += 1
            except Exception as e:
                results.append({
                    "browser": brand, "path": str(cache_dir),
                    "sizeMB": size_mb, "fileCount": files,
                    "deleted": False, "skipped": f"删除失败：{e}"
                })
                continue
        results.append({
            "browser": brand, "path": str(cache_dir),
            "sizeMB": size_mb, "fileCount": files,
            "deleted": deleted
        })

total_size_mb = round(total_size_mb, 2)
above_threshold = [r for r in results if r.get("sizeMB", 0) >= min_size_mb]
if dry_run:
    speech = f"扫描到 {total_size_mb}MB 浏览器缓存（{total_files} 个文件），涉及 {len(above_threshold)} 个缓存目录。dry-run 模式未删除；要真删请 confirm:true。"
else:
    speech = f"已清理 {deleted_count} 个缓存目录，释放约 {total_size_mb}MB（{total_files} 个文件）。"

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
