#!/usr/bin/env python3
"""OKF v0.1 Bundle 合规校验（对应 SPEC §9）。

用法:
    python tools/validate.py [bundle_root]

校验规则（ERROR）:
    1. 每个非保留 .md 文件必须包含可解析的 YAML frontmatter；
    2. 每个 frontmatter 必须包含非空 type 字段；
    3. index.md 不允许携带 frontmatter（根目录除外，且仅允许 okf_version）；
    4. log.md 的二级标题必须是 YYYY-MM-DD。

软提示（WARN，不阻断）:
    - timestamp 非 ISO 8601；
    - 断链（规范允许，代表"尚未编写的知识"）。

退出码: 0 = 通过, 1 = 存在 ERROR
"""
from __future__ import annotations

import datetime
import re
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    sys.exit("缺少依赖，请先执行: pip install pyyaml（见 tools/requirements.txt）")

SKIP_DIRS = {".git", ".github", "site", "node_modules", "__pycache__"}
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
FM_RE = re.compile(r"^---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(\r?\n|$)", re.DOTALL)
LINK_RE = re.compile(r"\[[^\]]*\]\(([^)\s]+)[^)]*\)")

errors: list[str] = []
warnings: list[str] = []


def iter_markdown(root: Path):
    for path in sorted(root.rglob("*.md")):
        rel = path.relative_to(root)
        if any(part in SKIP_DIRS or part.startswith(".") for part in rel.parts[:-1]):
            continue
        yield path, rel


def parse_frontmatter(text: str):
    """返回 dict；无 frontmatter 返回 None；非法返回 'INVALID'。"""
    m = FM_RE.match(text)
    if not m:
        return None
    try:
        data = yaml.safe_load(m.group(1))
    except yaml.YAMLError:
        return "INVALID"
    return data if isinstance(data, dict) else "INVALID"


def check_concept(rel: Path, fm) -> None:
    if fm is None:
        errors.append(f"{rel}: 缺少 YAML frontmatter")
        return
    if fm == "INVALID":
        errors.append(f"{rel}: frontmatter 不是合法的 YAML 映射")
        return
    if not isinstance(fm.get("type"), str) or not fm["type"].strip():
        errors.append(f"{rel}: frontmatter 缺少非空 type 字段")
    ts = fm.get("timestamp")
    if ts not in (None, "") and not isinstance(ts, (datetime.date, datetime.datetime)):
        if not re.match(r"^\d{4}-\d{2}-\d{2}", str(ts)):
            warnings.append(f"{rel}: timestamp 建议使用 ISO 8601 格式")
    # 有效期保鲜：timestamp 超过 90 天未更新 → 建议复审（WARN，不阻断）
    parsed = None
    if isinstance(ts, datetime.datetime):
        parsed = ts.date()
    elif isinstance(ts, datetime.date):
        parsed = ts
    elif isinstance(ts, str):
        m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", ts)
        if m:
            parsed = datetime.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    if parsed and (datetime.date.today() - parsed).days > 90:
        warnings.append(f"{rel}: 超过 90 天未更新（timestamp {parsed}），建议复审保鲜")


def check_index(rel: Path, fm, is_root: bool) -> None:
    if fm in (None, "INVALID"):
        return
    if not is_root:
        errors.append(f"{rel}: 仅 bundle 根目录的 index.md 允许携带 frontmatter")
    elif set(fm) - {"okf_version"}:
        warnings.append(f"{rel}: 根 index.md 的 frontmatter 建议仅保留 okf_version")


def check_log(rel: Path, text: str) -> None:
    for m in re.finditer(r"^##\s+(.+?)\s*$", text, re.MULTILINE):
        if not DATE_RE.match(m.group(1)):
            errors.append(f"{rel}: 日志日期标题必须为 YYYY-MM-DD，实际为 '{m.group(1)}'")


def check_links(root: Path, path: Path, rel: Path, text: str) -> None:
    body = FM_RE.sub("", text, count=1)
    for m in LINK_RE.finditer(body):
        target = m.group(1).split("#")[0].strip()
        if not target or "://" in target or target.startswith("mailto:"):
            continue
        dest = root / target.lstrip("/") if target.startswith("/") else path.parent / target
        if not dest.exists():
            warnings.append(f"{rel}: 断链（可为尚未编写的知识）-> {target}")


def main() -> int:
    root = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent
    count = 0
    for path, rel in iter_markdown(root):
        count += 1
        text = path.read_text(encoding="utf-8")
        name = path.name.lower()
        if name == "index.md":
            check_index(rel, parse_frontmatter(text), is_root=(rel.parent == Path(".")))
        elif name == "log.md":
            check_log(rel, text)
        else:
            check_concept(rel, parse_frontmatter(text))
        check_links(root, path, rel, text)

    for w in warnings:
        print(f"WARN  {w}")
    for e in errors:
        print(f"ERROR {e}")
    print(f"\n扫描 {count} 个 Markdown 文件：{len(errors)} error(s), {len(warnings)} warning(s)")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
