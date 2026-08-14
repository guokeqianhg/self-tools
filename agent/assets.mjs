// assets/ 图片的引用追踪与孤儿清理（方案 A：落盘动作时同步删除失去全部引用的图片）。
//
// 两条铁律（防止误删）：
//   1) 只在"保存/删除/入库/丢弃"等落盘动作时触发，绝不在编辑过程中删文件（编辑可反悔）；
//   2) 必须全库零引用才删——扫描范围 = 全部知识文档正文 + 所有候选草稿正文。
import fs from 'node:fs';
import path from 'node:path';
import { loadDocs } from './scan.mjs';
import { loadCandidates } from './wework/store.mjs';

const IMG_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);
// markdown 图片引用：![alt](/assets/xxx.png) 或 ![alt](assets/xxx.png)
const IMG_REF_RE = /!\[[^\]]*\]\(\s*\/?(assets\/[^)\s]+?)\s*\)/g;

// 从一段文本里提取引用的 assets 相对路径（统一去掉开头的 /）
export function imageRefsOf(text) {
  const out = new Set();
  const re = new RegExp(IMG_REF_RE.source, 'g');
  let m;
  while ((m = re.exec(String(text || '')))) {
    out.add(m[1].replace(/^\/+/, ''));
  }
  return out;
}

// 全库引用集合：所有知识文档 + 所有候选草稿（含已起草正文）
export function allReferencedAssets(root) {
  const refs = new Set();
  for (const d of loadDocs(root)) {
    for (const r of imageRefsOf(d.body || '')) refs.add(r);
  }
  for (const c of loadCandidates()) {
    for (const r of imageRefsOf(c.draft || '')) refs.add(r);
  }
  return refs;
}

// 某次内容变更"不再引用"的图片里，全库也确实零引用的（可以安全删除）
export function findOrphanedByChange(root, prevText, nextText) {
  const prev = imageRefsOf(prevText);
  const next = imageRefsOf(nextText);
  const lost = [...prev].filter((p) => !next.has(p));
  if (!lost.length) return [];
  const all = allReferencedAssets(root);
  return lost.filter((p) => !all.has(p) && fs.existsSync(path.join(root, p)));
}

// 编辑器粘贴产生的图片（paste- 前缀，只可能来自 Ctrl+V，不会来自 iWiki 导入）中全库零引用的。
// 用于候选"入库/丢弃"后的兜底：贴了又删、贴了但整条丢弃的图，在这两个时点清掉。
export function findOrphanedPastes(root) {
  const dir = path.join(root, 'assets');
  if (!fs.existsSync(dir)) return [];
  const all = allReferencedAssets(root);
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    const ext = f.split('.').pop().toLowerCase();
    if (!f.startsWith('paste-') || !IMG_EXTS.has(ext)) continue;
    const rel = `assets/${f}`;
    if (!all.has(rel)) out.push(rel);
  }
  return out;
}

// 物理删除，返回成功删除的相对路径
export function deleteAssets(root, relPaths) {
  const deleted = [];
  for (const rel of relPaths || []) {
    const abs = path.join(root, rel);
    // 防穿越：只允许删 assets/ 下的图片文件
    if (!rel.startsWith('assets/') || !IMG_EXTS.has(rel.split('.').pop().toLowerCase())) continue;
    try {
      if (fs.existsSync(abs) && !fs.statSync(abs).isDirectory()) {
        fs.rmSync(abs);
        deleted.push(rel);
      }
    } catch { /* 单个失败不阻断 */ }
  }
  return deleted;
}
