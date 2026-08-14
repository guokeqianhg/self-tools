#!/usr/bin/env python3
"""根据各文档 frontmatter 自动生成 / 更新目录 index.md（OKF §6）。

用法:
    python tools/build_index.py [bundle_root] [--force]

行为:
    - 按 type 分组列出目录内的概念文档，description 取自 frontmatter；
    - 已存在且不含 auto-index 标记的 index.md 视为人工维护，默认跳过；
    - 根 index.md 自动保留 okf_version frontmatter。
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    sys.exit("缺少依赖，请先执行: pip install pyyaml")

MARKER = "<!-- auto-index: 由 tools/build_index.py 生成，可被安全覆盖 -->"
SKIP_DIRS = {".git", ".github", "site", "node_modules", "tools", "agent", "__pycache__"}
DIR_TITLES = {
    "metrics": "指标与度量",
    "product": "系统与工具",
    "team": "组织与协作",
    "guides": "流程指南",
    "references": "公开资料",
    "templates": "文档模板",
}
FM_RE = re.compile(r"^---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(\r?\n|$)", re.DOTALL)


def frontmatter(path: Path) -> dict:
    m = FM_RE.match(path.read_text(encoding="utf-8"))
    if not m:
        return {}
    try:
        data = yaml.safe_load(m.group(1))
        return data if isinstance(data, dict) else {}
    except yaml.YAMLError:
        return {}


def collect(dirpath: Path) -> dict[str, list[str]]:
    groups: dict[str, list[str]] = {}
    for p in sorted(dirpath.iterdir()):
        if p.name.startswith(".") or p.name in ("index.md", "log.md"):
            continue
        if p.is_dir():
            if p.name in SKIP_DIRS:
                continue
            groups.setdefault("目录", []).append(f"* [{p.name}/]({p.name}/)")
        elif p.suffix == ".md":
            fm = frontmatter(p)
            title = fm.get("title") or p.stem
            desc = str(fm.get("description") or "").strip()
            line = f"* [{title}]({p.name})" + (f" - {desc}" if desc else "")
            groups.setdefault(str(fm.get("type") or "其他"), []).append(line)
    return groups


def build(root: Path, force: bool) -> None:
    dirs = [root]
    for d in sorted(root.rglob("*")):
        if not d.is_dir():
            continue
        rel_parts = d.relative_to(root).parts
        if any(part in SKIP_DIRS or part.startswith(".") for part in rel_parts):
            continue
        dirs.append(d)

    for dirpath in dirs:
        is_root = dirpath == root
        target = dirpath / "index.md"
        if target.exists() and not force:
            if MARKER not in target.read_text(encoding="utf-8"):
                print(f"跳过 {target.relative_to(root)}（人工维护，--force 可覆盖）")
                continue

        title = "知识库" if is_root else DIR_TITLES.get(dirpath.name, dirpath.name)
        lines: list[str] = []
        if is_root:
            lines += ["---", 'okf_version: "0.1"', "---", ""]
        lines += [MARKER, "", f"# {title}", ""]
        groups = collect(dirpath)
        if not groups:
            lines += ["_暂无条目，待补充。_", ""]
        for group, items in groups.items():
            lines += [f"## {group}", *items, ""]
        target.write_text("\n".join(lines), encoding="utf-8")
        print(f"生成 {target.relative_to(root)}")


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    root = Path(args[0]).resolve() if args else Path(__file__).resolve().parent.parent
    build(root, force="--force" in sys.argv)
