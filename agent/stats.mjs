// 本地运营数据（消费热度/发布来源/知识缺口/答出率打点）：统一 append-only 流水，并发写不丢数。
// 读取时在内存聚合；兼容旧版 .stats.json / .authorship.json 快照格式（作为基数合并）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = (name) => path.join(HERE, name);
const nowIso = () => new Date().toISOString();

function appendLine(file, obj) {
  try {
    fs.appendFileSync(FILE(file), JSON.stringify(obj) + '\n');
  } catch { /* 忽略 */ }
}

function readJsonl(file) {
  const f = FILE(file);
  if (!fs.existsSync(f)) return [];
  const out = [];
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return out;
}

/* ============ 消费热度（检索/问答命中计数） ============ */
export function bumpUsage(docs) {
  const ts = nowIso();
  for (const d of docs || []) {
    if (d && d.path) appendLine('.stats.jsonl', { p: d.path, ts });
  }
}

export function loadUsage() {
  const usage = {};
  // 旧快照格式：.stats.json { path: count }
  const legacy = FILE('.stats.json');
  if (fs.existsSync(legacy)) {
    try {
      for (const [p, n] of Object.entries(JSON.parse(fs.readFileSync(legacy, 'utf8')))) {
        usage[p] = (usage[p] || 0) + (Number(n) || 0);
      }
    } catch { /* skip */ }
  }
  for (const r of readJsonl('.stats.jsonl')) {
    if (r.p) usage[r.p] = (usage[r.p] || 0) + 1;
  }
  return usage;
}

/* ============ 发布来源（AI 起草 vs 人工发起） ============ */
export function bumpAuthorship(kind) {
  appendLine('.authorship.jsonl', { k: kind, ts: nowIso() });
}

export function loadAuthorship() {
  let ai = 0;
  let human = 0;
  const legacy = FILE('.authorship.json');
  if (fs.existsSync(legacy)) {
    try {
      const a = JSON.parse(fs.readFileSync(legacy, 'utf8'));
      ai += Number(a.ai) || 0;
      human += Number(a.human) || 0;
    } catch { /* skip */ }
  }
  for (const r of readJsonl('.authorship.jsonl')) {
    if (r.k === 'ai') ai += 1;
    else if (r.k === 'human') human += 1;
  }
  return { ai, human };
}

/* ============ 知识缺口（问答未命中登记） ============ */
export function appendGap(question) {
  appendLine('.gaps.jsonl', { q: question, ts: nowIso() });
}

// 闭环：不再整文件重写，改为追加一条 resolved 标记，读取时按时间序应用。
// 语义与原"删除该问题全部记录"一致：标记之后若再有人问相同问题，会重新计数。
export function resolveGap(question) {
  appendLine('.gaps.jsonl', { q: question, resolved: true, ts: nowIso() });
}

// 读取 .gaps.jsonl，按问题聚合计数，返回 [{q, n, lastTs}] 降序
export function loadGaps() {
  const count = new Map();
  const lastTs = new Map();
  for (const r of readJsonl('.gaps.jsonl')) {
    if (!r.q) continue;
    if (r.resolved) {
      count.delete(r.q);
      lastTs.delete(r.q);
      continue;
    }
    count.set(r.q, (count.get(r.q) || 0) + 1);
    if (r.ts) lastTs.set(r.q, r.ts);
  }
  return [...count.entries()]
    .map(([q, n]) => ({ q, n, lastTs: lastTs.get(q) || '' }))
    .sort((a, b) => b.n - a.n);
}

/* ============ 知识答出率（命中/未命中打点） ============ */
export function bumpAsk(hit) {
  appendLine('.asklog.jsonl', { hit, ts: nowIso() });
}

export function loadAskLog() {
  const out = [];
  for (const r of readJsonl('.asklog.jsonl')) out.push(r.hit);
  return out;
}
