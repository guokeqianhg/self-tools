#!/usr/bin/env node
// 知识库体检报告 + 保鲜复审闭环 + 企微推送（功能 C）。
// 用法:
//   node agent/govern.mjs                  # 打印体检报告（默认）
//   node agent/govern.mjs --out 报告.md     # 写入报告文件
//   node agent/govern.mjs --review          # 保鲜复审：超 90 天未更新的"可直接用"文档自动标记"待复审"
//   node agent/govern.mjs --push            # 把六项指标摘要推送到企微机器人（需 WECOM_WEBHOOK）
//   node agent/govern.mjs --auto            # 体检自动化：保鲜复审 + 企微推送 一起跑
// 也可被 serve.mjs 引入，提供 runGovernCycle / runFreshnessReview / pushWeCom（无顶层副作用）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadDocs, parseFrontmatter } from './scan.mjs';
import { setStatus } from './add.mjs';
import { loadGaps, loadUsage, loadAuthorship } from './stats.mjs';
import { stats as weworkStats, PATHS as WEWORK_PATHS } from './wework/store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const FRESH_DAYS = 90;

function parseTs(v) {
  const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
}

// 正式文档集合（与 serve.mjs loadMetrics 口径一致：有 type、排除 index 与模板）
function formalDocs() {
  return loadDocs(ROOT).filter((d) => d.type && !d.path.endsWith('index.md') && !d.path.startsWith('templates/'));
}

/* ============ 体检报告（markup 文本） ============ */
export function buildReport() {
  const docs = formalDocs();
  const today = new Date();

  /* 1. 规模 */
  const byDomain = {};
  for (const d of docs) {
    const domain = d.path.includes('/') ? d.path.split('/')[0] : '(根目录)';
    byDomain[domain] = (byDomain[domain] || 0) + 1;
  }

  /* 2. 待补充（空壳） */
  const shells = docs
    .map((d) => ({ path: d.path, title: d.title, n: (d.body.match(/待补充/g) || []).length }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n);

  /* 3. 断链 */
  const broken = [];
  for (const d of docs) {
    for (const m of d.body.matchAll(/\[[^\]]*\]\(([^)\s]+)[^)]*\)/g)) {
      const t = m[1].split('#')[0].trim();
      if (!t || t.includes('://') || !t.endsWith('.md')) continue;
      const abs = t.startsWith('/') ? path.join(ROOT, t) : path.join(ROOT, path.dirname(d.path), t);
      if (!fs.existsSync(abs)) broken.push({ from: d.path, to: t });
    }
  }

  /* 4. 保鲜 */
  const stale = docs
    .map((d) => ({ path: d.path, title: d.title, ts: parseTs(d.fm.timestamp) }))
    .filter((x) => x.ts && (today - x.ts) / 86400000 > FRESH_DAYS)
    .sort((a, b) => a.ts - b.ts);

  /* 5. 缺口 */
  const gaps = loadGaps();

  /* 6. 消费热度 */
  const usage = loadUsage();
  const hot = Object.entries(usage).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const zeroUse = docs.filter((d) => !usage[d.path]);

  const L = [];
  L.push(`# 知识库体检报告（${today.toISOString().slice(0, 10)}）`, '');
  L.push(`## 规模：共 ${docs.length} 篇`, '');
  for (const [k, v] of Object.entries(byDomain)) L.push(`- ${k}/：${v} 篇`);
  L.push('', `## 待补充（${shells.length} 篇含占位）`, '');
  for (const s of shells.slice(0, 15)) L.push(`- /${s.path}（${s.title}）：${s.n} 处待补充`);
  L.push('', `## 断链（${broken.length} 处，可为"尚未编写的知识"）`, '');
  for (const b of broken.slice(0, 15)) L.push(`- /${b.from} → ${b.to}`);
  L.push('', `## 保鲜（>${FRESH_DAYS} 天未更新，${stale.length} 篇）`, '');
  for (const s of stale.slice(0, 15)) L.push(`- /${s.path}（${s.title}）：最后更新 ${s.ts.toISOString().slice(0, 10)}`);
  L.push('', `## 知识缺口（问答未命中，${gaps.length} 个）`, '');
  if (!gaps.length) L.push('- 暂无记录');
  for (const [q, n] of gaps.slice(0, 15)) L.push(`- 「${q}」（出现 ${n} 次）→ 建议补充文档`);
  L.push('', '## 消费热度（问答/检索命中 Top10）', '');
  if (!hot.length) L.push('- 暂无记录');
  for (const [p, n] of hot) L.push(`- /${p}：${n} 次`);
  L.push('', `## 零消费文档（${zeroUse.length} 篇，考虑复审或归档）`, '');
  for (const d of zeroUse.slice(0, 15)) L.push(`- /${d.path}（${d.title}）`);

  return { text: L.join('\n'), stale, byDomain, shells, broken, gaps, hot, zeroUse };
}

/* ============ 六项指标（推送摘要用，口径与 /api/metrics 一致） ============ */
export function buildMetrics() {
  const docs = formalDocs();
  const stock = docs.length;
  const pending = docs.filter((d) => d.fm.status === 'review' || d.fm.status === 'verify').length;
  const reviewOnly = docs.filter((d) => d.fm.status === 'review').length;

  const today = new Date();
  let stale = 0;
  for (const d of docs) {
    const ts = parseTs(d.fm.timestamp);
    if (ts && (today - ts) / 86400000 > FRESH_DAYS) stale += 1;
  }
  const freshness = stock ? Math.round((stock - stale) / stock * 100) : 0;

  const gaps = loadGaps();
  const blindSpots = gaps.length;
  const gapOccurrences = gaps.reduce((s, g) => s + (g.n || 0), 0);

  const usage = loadUsage();
  const viewHeat = Object.values(usage).reduce((s, n) => s + (n || 0), 0);

  const askFile = path.join(HERE, '.asklog.jsonl');
  const asks = fs.existsSync(askFile)
    ? fs.readFileSync(askFile, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l).hit; } catch { return null; } }).filter((x) => x !== null)
    : [];
  const askHits = asks.filter((h) => h === true).length;
  const askMisses = asks.length - askHits;
  const answerRate = asks.length ? Math.round(askHits / asks.length * 100) : null;

  const { ai, human } = loadAuthorship();
  const autoRate = (ai + human) ? Math.round(ai / (ai + human) * 100) : null;

  return {
    stock, freshness, stale, pending, reviewOnly,
    blindSpots, gapOccurrences, viewHeat,
    answerRate, askHits, askMisses, askTotal: asks.length,
    autoRate, ai, human, freshDays: FRESH_DAYS,
    wework: weworkSummary(),
  };
}

// 聊天原料区：只有启用过企微沉淀（目录存在）才统计，未启用时返回 null
function weworkSummary() {
  try {
    if (!fs.existsSync(WEWORK_PATHS.DATA)) return null;
    const w = weworkStats();
    return {
      sessions: w.sessions,
      messages: w.messages,
      unprocessed: w.unprocessed,
      pendingReview: (w.candidates.pending || 0) + (w.candidates.drafted || 0),
      published: w.published,
      diskMB: Math.round((w.diskBytes / 1048576) * 10) / 10,
      retainDays: w.retainDays,
      overdueUnprocessed: w.overdueUnprocessed,
    };
  } catch {
    return null;
  }
}

/* ============ 保鲜复审闭环：超期"可直接用"文档自动标记"待复审" ============ */
// 只动 status 为 ready/未设置 的文档；"待确认"(review) 与已"待复审"(verify) 不动，避免覆盖人工进度。
export async function runFreshnessReview(root = ROOT, flags = {}) {
  const docs = formalDocs();
  const today = new Date();
  const marked = [];
  for (const d of docs) {
    const ts = parseTs(d.fm.timestamp);
    const st = d.fm.status || 'ready';
    const isStale = ts && (today - ts) / 86400000 > FRESH_DAYS;
    const editable = st === 'ready' || st === '' || st === undefined || st === null;
    if (isStale && editable) {
      try {
        const r = await setStatus(root, d.path, 'verify', flags);
        marked.push({ path: d.path, title: d.title, lastUpdate: ts.toISOString().slice(0, 10), pushed: r.pushed });
      } catch (e) {
        // 校验未过等个别失败不阻断其余文档
        console.warn(`[govern] 标记失败 /${d.path}: ${e.message}`);
      }
    }
  }
  return marked;
}

/* ============ 企微推送 ============ */
const WECOM_BASE = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send';

function buildWeComSummary(m, marked) {
  const pct = (x) => (x === null || x === undefined ? '—' : `${x}%`);
  const lines = [];
  lines.push(`📚 **内部知识库 · 每周体检**`);
  lines.push(`🗓 ${new Date().toISOString().slice(0, 10)}`);
  lines.push('');
  lines.push(`- 知识存量：**${m.stock}** 篇（其中 **${m.pending}** 篇待确认/待复审）`);
  lines.push(`- 内容鲜活度：**${pct(m.freshness)}**（超 ${m.freshDays} 天 **${m.stale}** 篇）`);
  lines.push(`- 知识盲区数：**${m.blindSpots}** 个（累计被问 **${m.gapOccurrences}** 次）`);
  lines.push(`- 查阅热度：累计 **${m.viewHeat}** 次命中`);
  lines.push(`- 知识答出率：**${pct(m.answerRate)}**（命中 ${m.askHits} / 未命中 ${m.askMisses}）`);
  lines.push(`- 自动沉淀率：**${pct(m.autoRate)}**（AI 起草 ${m.ai} / 人工 ${m.human}）`);
  if (m.wework) {
    const w = m.wework;
    lines.push(`- 企微聊天原料：**${w.messages}** 条 / ${w.sessions} 个会话，待加工 **${w.unprocessed}** 条，待审候选 **${w.pendingReview}** 条，已沉淀 ${w.published} 篇（占用 ${w.diskMB} MB）`);
    if (w.overdueUnprocessed) {
      lines.push(`  ⚠️ 有 **${w.overdueUnprocessed}** 条消息已超过保留期 ${w.retainDays} 天但仍未加工，请尽快在管理台点「开始加工」`);
    }
  }
  lines.push('');
  lines.push(`🔁 本轮保鲜复审：自动标记 **${marked.length}** 篇「待复审」`);
  if (marked.length) {
    for (const x of marked.slice(0, 5)) lines.push(`> /${x.path}（${x.title}）最后更新 ${x.lastUpdate}`);
    if (marked.length > 5) lines.push(`> …共 ${marked.length} 篇`);
  }
  lines.push('');
  lines.push('> 待确认/待复审文档请在管理台一键「确认发布」');
  return lines.join('\n');
}

export async function pushWeCom(summary, webhook) {
  const url = webhook || process.env.WECOM_WEBHOOK;
  if (!url) {
    console.log('[govern] 未配置 WECOM_WEBHOOK，跳过企微推送');
    return { skipped: true };
  }
  const body = { msgtype: 'markdown', markdown: { content: summary } };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (j.errcode && j.errcode !== 0) throw new Error(`企微推送失败: ${JSON.stringify(j)}`);
  return { ok: true, errcode: j.errcode ?? 0 };
}

/* ============ 自动周期：复审 + 推送 ============ */
export async function runGovernCycle(root = ROOT, { webhook } = {}) {
  const metrics = buildMetrics();
  const marked = await runFreshnessReview(root);
  const summary = buildWeComSummary(metrics, marked);
  const push = await pushWeCom(summary, webhook);
  return { metrics, marked, push, summary };
}

/* ============ CLI ============ */
async function main() {
  const argv = process.argv.slice(2);
  const has = (f) => argv.includes(f);

  if (has('--review')) {
    const marked = await runFreshnessReview(ROOT);
    console.log(`保鲜复审：标记 ${marked.length} 篇「待复审」`);
    for (const m of marked) console.log(`- /${m.path}（${m.title}）最后更新 ${m.lastUpdate}${m.pushed ? '（已推送）' : ''}`);
    return;
  }
  if (has('--push')) {
    const m = buildMetrics();
    const r = await pushWeCom(buildWeComSummary(m, []));
    console.log(JSON.stringify(r));
    return;
  }
  if (has('--auto')) {
    const r = await runGovernCycle(ROOT);
    console.log(`保鲜复审：标记 ${r.marked.length} 篇；推送：${JSON.stringify(r.push)}`);
    return;
  }
  // 默认：打印报告（或 --out 写入）
  const outIdx = argv.indexOf('--out');
  const report = buildReport();
  if (outIdx > 0 && argv[outIdx + 1]) {
    fs.writeFileSync(path.resolve(argv[outIdx + 1]), report.text + '\n', 'utf8');
    console.log(`已写入 ${argv[outIdx + 1]}`);
  } else {
    console.log(report.text);
  }
}

// 仅当作为脚本直接运行时执行 CLI；被 serve.mjs 引入时不触发
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
