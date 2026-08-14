#!/usr/bin/env node
// 内部知识库 Web 管理台服务（零依赖，Node 18+）。
// 部署：在内部服务器 clone 本仓库，配置 git 推送权限与 LLM_API_KEY 后：
//   node agent/serve.mjs        （PORT 环境变量可改端口，默认 8080）
// 服务会每 60 秒 git pull 保持与 main 同步。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadDocs, searchDocs, invalidateDocsCache } from './scan.mjs';
import { askAnswer, retrieve, expandQuery, runAgentLoop, summarizeHistory } from './ask.mjs';
import { addDoc, importDoc, templateDoc, listTemplates, updateDoc, deleteDoc, publish, setStatus, gitCommitAndPush, importIwikiDoc, importIwikiTree } from './add.mjs';
import { planImport, executeImport } from './organize.mjs';
import { runGovernCycle } from './govern.mjs';
import { llmAvailable, chat } from './llm.mjs';
import { randomUUID } from 'node:crypto';
import { bumpUsage, loadUsage, bumpAuthorship, loadAuthorship, appendGap, resolveGap, loadGaps, bumpAsk, loadAskLog } from './stats.mjs';
import { pollSeconds, sourceStatus, syncArchive } from './wework/source.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 允许上传的图片格式（/api/upload-image 用）
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);
const ROOT = process.env.HANDBOOK_ROOT
  || execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const PORT = Number(process.env.PORT || 8080);

// 写操作串行化队列（见下方 enqueue 的调用方）：避免并发写仓库
let queue = Promise.resolve();
const enqueue = (fn) => {
  const p = queue.then(fn);
  queue = p.catch(() => {});
  return p;
};

// 后台 git pull 与前台写共用同一队列：pull 永远不与 add/commit/push 并发，
// 否则前台 commit 后 push 前被 pull 抢先 fast-forward，会导致 push 被拒、本地提交丢失同步
function gitPull() {
  try {
    execFileSync('git', ['pull', '--ff-only'], { cwd: ROOT, stdio: 'ignore' });
    invalidateDocsCache(ROOT); // pull 可能带来远端变更
  } catch { /* 离线或冲突时保持现状 */ }
}
gitPull();
setInterval(() => { enqueue(async () => gitPull()); }, 60_000).unref();

// 企微归档由 上游归档服务 写入共享盘；Handbook 只读同步，绝不接收回调或持有企微密钥。
function syncWecomArchive() {
  try {
    const result = syncArchive();
    if (!result.skipped && (result.imported || result.updated || result.invalid)) {
      console.log(`[wework] 归档同步：新增 ${result.imported}，更新 ${result.updated}，异常 ${result.invalid}`);
    }
  } catch (error) {
    console.error(`[wework] 归档同步失败：${error.message}`);
  }
}
syncWecomArchive();
setInterval(syncWecomArchive, pollSeconds() * 1000).unref();

// 体检自动化（功能 C）：默认每周一 09:00 后跑一次保鲜复审 + 企微推送；GOVERN_OFF=1 关闭
let lastGovernRun = null;
let lastGovernWeek = '';
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yr = t.getUTCFullYear();
  const wk = Math.ceil((((t - new Date(Date.UTC(yr, 0, 1))) / 86400000) + 1) / 7);
  return `${yr}-W${wk}`;
}
async function governTick() {
  if (process.env.GOVERN_OFF === '1') return;
  const now = new Date();
  if (now.getDay() === 1 && now.getHours() >= 9) {
    const wk = isoWeek(now);
    if (wk !== lastGovernWeek) {
      lastGovernWeek = wk;
      try {
        const r = await runGovernCycle(ROOT);
        lastGovernRun = { at: now.toISOString(), marked: r.marked.length, pushed: !r.push.skipped };
        console.log(`[govern] 自动体检完成：标记 ${r.marked.length} 篇待复审，推送 ${JSON.stringify(r.push)}`);
      } catch (e) {
        console.error('[govern] 自动体检失败:', e.message);
      }
    }
  }
}
setInterval(governTick, 60 * 60 * 1000).unref();

// 整理 Agent 的上传缓存（planId -> {filename, text, ts}）
const importCache = new Map();

// 问答式填入的临时会话存储（sessionId -> { messages, owner, ts }）
const interviewSessions = new Map();

// ---- 流程自动沉淀：缺口登记 + 消费记账 + 答出率/发布来源打点 ----
// 实现已统一到 stats.mjs（append-only 流水，并发写不丢数），此处仅保留引用。

const FRESH_DAYS = 90;
function parseTs(v) {
  const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
}

// 数据看板：从 stats.mjs 的运营流水 + 文档 frontmatter 实时汇总六个健康度指标
function loadMetrics() {
  const docs = loadDocs(ROOT).filter((d) => d.type);
  const stock = docs.length;
  const pending = docs.filter((d) => d.fm.status === 'review' || d.fm.status === 'verify').length;
  const reviewOnly = docs.filter((d) => d.fm.status === 'review').length;

  // 内容鲜活度：90 天未更新占比的反面
  const today = new Date();
  let stale = 0;
  for (const d of docs) {
    const ts = parseTs(d.fm.timestamp);
    if (ts && (today - ts) / 86400000 > FRESH_DAYS) stale += 1;
  }
  const freshness = stock ? Math.round((stock - stale) / stock * 100) : 0;

  // 知识盲区数：已登记且未解决的待补问题数 + 累计出现次数
  const gaps = loadGaps();
  const blindSpots = gaps.length;
  const gapOccurrences = gaps.reduce((s, g) => s + (g.n || 0), 0);

  // 查阅热度：累计被检索/问答命中的次数 + Top5 文档
  const usage = loadUsage();
  const viewHeat = Object.values(usage).reduce((s, n) => s + (n || 0), 0);
  const topDocs = Object.entries(usage).sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([p, n]) => ({ path: p, n }));

  // 知识答出率：命中 / (命中 + 未命中)
  const asks = loadAskLog();
  const askHits = asks.filter((h) => h === true).length;
  const askMisses = asks.length - askHits;
  const answerRate = asks.length ? Math.round(askHits / asks.length * 100) : null;

  // 自动沉淀率：AI 起草发布 / 总发布
  const { ai, human } = loadAuthorship();
  const autoRate = (ai + human) ? Math.round(ai / (ai + human) * 100) : null;

  return {
    stock, freshness, stale, pending, reviewOnly,
    blindSpots, gapOccurrences,
    viewHeat, topDocs,
    answerRate, askHits, askMisses, askTotal: asks.length,
    autoRate, ai, human,
    freshDays: FRESH_DAYS,
    lastGovern: lastGovernRun,
  };
}

// 问答式填入 system prompt（自然、口语化，避免机械话术）
const INTERVIEW_SYSTEM = `你是 内部知识库 知识库的"问答式录入助手"，像一个对知识沉淀充满好奇、又很会聊天的同事。你的目标是通过自然闲聊，帮团队成员把脑子里零散的知识讲出来，最后整理成一篇规范文档。

【沟通风格】
- 口语化、轻松，像真人聊天。不要列点式、不要加序号、不要使用"第一轮/后续轮次"这类机械话术。
- 每次只抛 1 个（最多 2 个）小问题，顺着对方刚说的话往下聊，别像审问或填表。
- 多接话、多确认，比如"哦明白了""这个挺关键的""那后来呢"，让对方愿意继续说。
- 能聊清楚就别追问太多；当信息差不多够写文档了，自然地提示一句："感觉已经讲得挺全了，我帮你整理成文档看看？"

【开场】
先热情打个招呼，再随口问一句"你今天想聊点哪方面的知识？"引导对方开口。如果对方一时说不清，给一两个常见例子帮他想（比如某个指标、系统用法、踩过的坑、流程经验或协作约定），但别列清单。

【其它】
- 用简体中文，每轮 1-3 句话。
- 对话阶段只引导、只追问，绝对不要直接写出文档内容（那是生成阶段的事）。
- 如果用户主动说"可以了""差不多了""生成吧"，就准备生成。`;

const INTERVIEW_FALLBACK_FIRST = `你好！你想录入什么类型的知识？比如：
- 指标与度量
- 系统或工具用法
- 已获授权的公开资料
- 踩坑经验
- 协作约定（术语/资源/决策）
- 公开资料
- 其他（直接描述即可）`;

// 问答式填入：基于对话生成文档 JSON
async function interviewGenerate(messages, owner) {
  const DOMAIN_HINT = `知识域目录与默认 type 的对应关系：metrics/ -> Metric；product/ -> Feature；team/ -> Context；guides/ -> Guide；references/ -> Reference。`;
  const SCHEMA_HINT = `只输出一个 JSON 对象（不要输出其他内容），结构：
{
  "domain": "上述目录之一（不带斜杠）",
  "filename": "小写 kebab-case 文件名，不带 .md",
  "frontmatter": { "type": "...", "title": "...", "description": "一句话摘要", "tags": ["..."], "owner": "..." },
  "body": "Markdown 正文（不含 frontmatter），用结构化标题/列表/表格，外部来源放文末 # Citations"
}`;
  const sys = `你是 OKF v0.1 知识库的文档撰写助手。以下是你与团队成员的问答对话记录。请基于对话内容，生成一篇规范的中文知识文档。
${DOMAIN_HINT}
${SCHEMA_HINT}
要求：
- 提取对话中的关键信息，组织成结构化文档
- 对话中未提及的内容用"（待补充）"标注，不要编造
- owner 字段填："${owner || ''}"
- 如果对话内容不足以生成有意义的文档，返回 {"error": "信息不足"}`;

  const out = await chat([
    { role: 'system', content: sys },
    ...messages.slice(1), // 去掉第一个 system（已是 interview 的）
  ], { temperature: 0.15 });
  if (!out) return null;
  try {
    // 提取 JSON
    const block = out.match(/```(?:json)?\s*([\s\S]*?)```/);
    const raw = block ? block[1] : out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1);
    const doc = JSON.parse(raw);
    if (doc.error) return null;
    return doc;
  } catch {
    return null;
  }
}

// 缺口闭环：基于高频缺口问题起草文档
async function gapDraftDoc(root, question) {
  const DOMAIN_HINT = `知识域目录与默认 type 的对应关系：metrics/ -> Metric；product/ -> Feature；team/ -> Context；guides/ -> Guide；references/ -> Reference。`;
  const SCHEMA_HINT = `只输出一个 JSON 对象（不要输出其他内容），结构：
{
  "domain": "上述目录之一（不带斜杠）",
  "filename": "小写 kebab-case 文件名，不带 .md",
  "frontmatter": { "type": "...", "title": "...", "description": "一句话摘要", "tags": ["..."] },
  "body": "Markdown 正文（不含 frontmatter），用结构化标题/列表/表格"
}`;
  const sys = `你是 OKF v0.1 知识库的文档撰写助手。团队知识库的智能问答中，有用户问了以下问题但知识库无法回答。请根据这个问题，起草一篇知识文档的草稿，填补这个知识缺口。
${DOMAIN_HINT}
${SCHEMA_HINT}
要求：
- 根据问题判断这属于什么知识，选择合适的知识域和 type
- 文档标题要能概括这个问题的主题
- 正文用结构化格式，已知的部分写出来，未知的部分标注"（待补充）"
- 这是草稿，后续由团队成员确认和补充`;

  const out = await chat([
    { role: 'system', content: sys },
    { role: 'user', content: `知识库无法回答的问题：${question}` },
  ], { temperature: 0.2 });
  if (!out) return null;
  try {
    const block = out.match(/```(?:json)?\s*([\s\S]*?)```/);
    const raw = block ? block[1] : out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const json = (res, code, data) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
};

const docSummary = ({ doc, score }) => ({
  path: doc.path,
  title: doc.title,
  type: doc.type,
  description: doc.fm.description || '',
  status: doc.fm.status || 'ready',
  score,
});

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    return {};
  }
}

// 按扩展名提取上传文件文本：md/txt 直读，docx 用 mammoth，pdf 用 pdf-parse（动态加载，缺依赖时给出安装提示）
async function extractText(filename, buf) {
  const ext = String(filename).split('.').pop().toLowerCase();
  if (['md', 'markdown', 'txt'].includes(ext)) return buf.toString('utf8');
  try {
    if (ext === 'docx') {
      const mammoth = (await import('mammoth')).default;
      return (await mammoth.extractRawText({ buffer: buf })).value;
    }
    if (ext === 'pdf') {
      // 直接引内部入口，规避 pdf-parse v1 在 ESM 下误判 debug 模式的已知问题
      const pdfParse = (await import('pdf-parse/lib/pdf-parse.js')).default;
      return (await pdfParse(buf)).text;
    }
  } catch (e) {
    if (e.code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error(`解析 .${ext} 需要额外依赖，请在 agent/ 目录执行 npm install 后重启服务`);
    }
    throw e;
  }
  throw new Error(`不支持的文件类型: .${ext}（支持 md / txt / docx / pdf）`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function handleApi(req, res, u) {
  // 企微聊天沉淀：路由集中在 agent/wework/api.mjs，动态载入避免影响未启用时的启动开销
  if (u.pathname.startsWith('/api/wework/')) {
    const { handleWeworkApi } = await import('./wework/api.mjs');
    return handleWeworkApi(req, res, u, { ROOT, json, readBody, enqueue });
  }
  if (req.method === 'GET' && u.pathname === '/api/status') {
    return json(res, 200, { ok: true, llm: llmAvailable(), wecomArchiveSource: sourceStatus(), root: path.basename(ROOT) });
  }
  if (req.method === 'GET' && u.pathname === '/api/docs') {
    const docs = loadDocs(ROOT)
      .filter((d) => d.type)
      .map((d) => docSummary({ doc: d }));
    return json(res, 200, { docs });
  }
  if (req.method === 'GET' && u.pathname === '/api/doc') {
    const rel = String(u.searchParams.get('path') || '').replace(/^\/+/, '');
    const abs = path.join(ROOT, rel);
    if (!rel.endsWith('.md') || rel.includes('..') || !fs.existsSync(abs)) {
      return json(res, 404, { error: 'not found' });
    }
    return json(res, 200, { path: rel, content: fs.readFileSync(abs, 'utf8') });
  }
  if (req.method === 'GET' && u.pathname === '/api/search') {
    const q = String(u.searchParams.get('q') || '').trim();
    if (!q) return json(res, 400, { error: 'missing q' });
    const hits = searchDocs(loadDocs(ROOT), q, 10).map(docSummary);
    return json(res, 200, { hits });
  }
  if (req.method === 'POST' && u.pathname === '/api/ask') {
    const { question } = await readBody(req);
    if (!question) return json(res, 400, { error: 'missing question' });
    const { answer, hits } = await askAnswer(ROOT, question, { topK: 5 });
    const missed = !hits || hits.length === 0;
    bumpAsk(!missed);
    if (missed) appendGap(question);
    return json(res, 200, { answer, hits: hits.map(docSummary) });
  }
  // 对话历史摘要压缩（前端滑窗溢出时调用）
  if (req.method === 'POST' && u.pathname === '/api/summarize') {
    const { messages = [], prevSummary = '' } = await readBody(req);
    if (!messages.length) return json(res, 400, { error: 'missing messages' });
    if (!llmAvailable()) return json(res, 200, { summary: prevSummary });
    try {
      const summary = await summarizeHistory(messages, prevSummary);
      return json(res, 200, { summary });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }
  // 多轮对话 + SSE 流式输出
  if (req.method === 'POST' && u.pathname === '/api/chat') {
    const { history = [], question, summary = '' } = await readBody(req);
    if (!question) return json(res, 400, { error: 'missing question' });
    const hits = await retrieve(ROOT, expandQuery(history, question), 5);
    // 知识库地图：全量文档清单（路径+标题），供元问题与导航
    const kbMap = loadDocs(ROOT)
      .filter((d) => d.type)
      .map((d) => `- /${d.path}（${d.title}）`)
      .join('\n')
      .slice(0, 2500);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    try {
      if (!llmAvailable()) {
        send({ done: true, fallback: true, hits: hits.map(docSummary) });
        return res.end();
      }
      // Agent 循环（LLM 可主动调用 read_doc/search_kb/list_docs），完成后分段推送答案
      const { answer, usedDocs } = await runAgentLoop(ROOT, hits, history, question, kbMap, {
        onStep: (action) => send({ step: action }),
        summary,
      });
      const text = answer || '';
      const SLICE = 24;
      for (let i = 0; i < text.length; i += SLICE) {
        send({ delta: text.slice(i, i + SLICE) });
        await new Promise((r) => setTimeout(r, 12));
      }
      const finalDocs = (usedDocs && usedDocs.length ? usedDocs : hits.map((h) => h.doc))
        .map((d) => docSummary({ doc: d }));
      // 流程自动沉淀：消费记账 + 答不出来时登记知识缺口 + 命中打点
      // 正则需容许 LLM 在"暂无/未检索到"与"相关内容/资料"之间插入查询词（如"暂无关于 xxx 的相关内容"）
      const missed = /知识库暂无[\s\S]{0,20}?相关内容|未检索到[\s\S]{0,20}?相关资料|知识库中不存在|无法回答.*问题|没有.*相关信息/.test(text);
      if (missed) {
        appendGap(question);
        bumpAsk(false);
      } else {
        bumpUsage(usedDocs && usedDocs.length ? usedDocs : hits.map((h) => h.doc));
        bumpAsk(true);
      }
      send({ done: true, hits: finalDocs });
    } catch (e) {
      send({ error: e.message });
    }
    return res.end();
  }
  if (req.method === 'POST' && u.pathname === '/api/add') {
    const { description, domain, title, owner, dryRun } = await readBody(req);
    if (!description) return json(res, 400, { error: 'missing description' });
    try {
      const r = await enqueue(() => addDoc(ROOT, description, { domain, title, owner }, { dryRun }));
      if (!dryRun) bumpAuthorship(llmAvailable() ? 'ai' : 'human');
      return json(res, 200, r);
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }
  if (req.method === 'GET' && u.pathname === '/api/templates') {
    return json(res, 200, { templates: listTemplates(ROOT) });
  }
  if (req.method === 'POST' && u.pathname === '/api/add-template') {
    const { template, frontmatter, sections, dryRun } = await readBody(req);
    if (!template) return json(res, 400, { error: 'missing template' });
    try {
      const r = await enqueue(() => templateDoc(ROOT, { template, frontmatter, sections }, { dryRun }));
      if (!dryRun) bumpAuthorship('human');
      return json(res, 200, r);
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }
  // 整理 Agent：阶段一出方案
  if (req.method === 'POST' && u.pathname === '/api/organize/plan') {
    const { filename, data, domain, title, owner } = await readBody(req);
    if (!filename || !data) return json(res, 400, { error: 'missing filename or data' });
    try {
      const text = await extractText(filename, Buffer.from(data, 'base64'));
      const plan = await planImport(ROOT, { filename, text }, { domain, title, owner });
      const planId = randomUUID();
      importCache.set(planId, { filename, text, ts: Date.now() });
      // 简单清理 30 分钟前的缓存
      for (const [k, v] of importCache) if (Date.now() - v.ts > 30 * 60 * 1000) importCache.delete(k);
      return json(res, 200, { planId, plan });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }
  // 整理 Agent：阶段二按确认的方案执行
  if (req.method === 'POST' && u.pathname === '/api/organize/execute') {
    const { planId, plan, owner, dryRun } = await readBody(req);
    const cached = importCache.get(planId);
    if (!cached) return json(res, 400, { error: '整理方案已过期，请重新上传生成' });
    if (!plan) return json(res, 400, { error: 'missing plan' });
    try {
      const r = await enqueue(() => executeImport(ROOT, cached, plan, { owner }, { dryRun }));
      if (!dryRun) bumpAuthorship(llmAvailable() ? 'ai' : 'human');
      return json(res, 200, r);
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }
  if (req.method === 'POST' && u.pathname === '/api/import') {
    const { filename, data, domain, title, owner, dryRun } = await readBody(req);
    if (!filename || !data) return json(res, 400, { error: 'missing filename or data' });
    try {
      const text = await extractText(filename, Buffer.from(data, 'base64'));
      const r = await enqueue(() => importDoc(ROOT, { filename, text }, { domain, title, owner }, { dryRun }));
      if (!dryRun) bumpAuthorship(llmAvailable() ? 'ai' : 'human');
      return json(res, 200, r);
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }
  // iWiki 导入：忠实照搬 iWiki 原文（含图片附件下载到 assets/），文末附原文链接，发布后即刻入检索池
  if (req.method === 'POST' && u.pathname === '/api/import-iwiki') {
    const { url, domain, title, owner, dryRun } = await readBody(req);
    if (!url) return json(res, 400, { error: 'missing url' });
    try {
      const r = await enqueue(() => importIwikiDoc(ROOT, { url }, { domain, title, owner }, { dryRun }));
      if (!dryRun) bumpAuthorship('human');
      return json(res, 200, r);
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }
  // iWiki 整树导入（方案 B）：一级页面 → 索引文档，二级子页面 → 平铺导入（父前缀消歧），单次提交推送
  if (req.method === 'POST' && u.pathname === '/api/import-iwiki-tree') {
    const { url, domain, title, owner, dryRun } = await readBody(req);
    if (!url) return json(res, 400, { error: 'missing url' });
    try {
      const r = await enqueue(() => importIwikiTree(ROOT, { url }, { domain, title, owner }, { dryRun }));
      if (!dryRun) bumpAuthorship('human');
      return json(res, 200, r);
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }
  if (req.method === 'POST' && u.pathname === '/api/update') {
    const { path: rel, content } = await readBody(req);
    if (!rel || content === undefined) return json(res, 400, { error: 'missing path or content' });
    try {
      const r = await enqueue(() => updateDoc(ROOT, rel, content));
      return json(res, 200, r);
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }
  if (req.method === 'POST' && u.pathname === '/api/delete') {
    const { path: rel } = await readBody(req);
    if (!rel) return json(res, 400, { error: 'missing path' });
    try {
      const r = await enqueue(() => deleteDoc(ROOT, rel));
      return json(res, 200, r);
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  /* ============ 图片上传（独立链路，与文档导入管线无关）============ */
  // 编辑器"插入图片"用：base64 图片落盘到仓库 assets/ 并提交推送，返回可引用的 /assets/ 路径。
  if (req.method === 'POST' && u.pathname === '/api/upload-image') {
    const { filename, data } = await readBody(req);
    if (!filename || !data) return json(res, 400, { error: 'missing filename or data' });
    try {
      const ext = String(filename).split('.').pop().toLowerCase();
      if (!IMAGE_EXTS.has(ext)) return json(res, 400, { error: `仅支持图片格式：${[...IMAGE_EXTS].join('/')}` });
      const buf = Buffer.from(data, 'base64');
      if (!buf.length) return json(res, 400, { error: '图片内容为空' });
      if (buf.length > 10 * 1024 * 1024) return json(res, 400, { error: '图片超过 10MB，请压缩后再传' });
      const assetsDir = path.join(ROOT, 'assets');
      fs.mkdirSync(assetsDir, { recursive: true });
      const stem = String(filename).replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '') || 'img';
      const name = `${Date.now().toString(36)}-${stem}.${ext}`;
      fs.writeFileSync(path.join(assetsDir, name), buf);
      const pushed = await enqueue(() => gitCommitAndPush(ROOT, `docs: add image assets/${name} [agent]`, {}, [`assets/${name}`]));
      return json(res, 200, { path: `/assets/${name}`, pushed });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  /* ============ 问答式填入（第四种新增方式）============ */
  // interviewSessions 在模块作用域声明（见文件顶部 importCache 附近）

  // 问答式填入：开启会话 / 继续对话 / 生成文档
  if (req.method === 'POST' && u.pathname === '/api/interview/start') {
    const { owner } = await readBody(req);
    const sessionId = randomUUID();
    const messages = [{ role: 'system', content: INTERVIEW_SYSTEM }];
    interviewSessions.set(sessionId, { messages, owner: owner || '', ts: Date.now() });
    // 清理 1 小时前的会话
    for (const [k, v] of interviewSessions) if (Date.now() - v.ts > 3600000) interviewSessions.delete(k);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    send({ sessionId });

    let firstMsg;
    if (llmAvailable()) {
      firstMsg = await chat([...messages, { role: 'user', content: '你好，我想录入一条知识。' }], { temperature: 0.3 });
    }
    firstMsg = firstMsg || INTERVIEW_FALLBACK_FIRST;
    messages.push(
      { role: 'user', content: '你好，我想录入一条知识。' },
      { role: 'assistant', content: firstMsg },
    );
    const SLICE = 24;
    for (let i = 0; i < firstMsg.length; i += SLICE) {
      send({ delta: firstMsg.slice(i, i + SLICE) });
      await sleep(14);
    }
    send({ done: true });
    return res.end();
  }

  if (req.method === 'POST' && u.pathname === '/api/interview/chat') {
    const { sessionId, message, done } = await readBody(req);
    const session = interviewSessions.get(sessionId);
    if (!session) return json(res, 400, { error: '会话已过期，请重新开始' });
    if (!message) return json(res, 400, { error: 'missing message' });

    // 如果用户说"生成文档"或 done=true，进入生成阶段
    const wantGenerate = done || /(可以了|差不多了|好了|就这样|生成文档|生成吧|你生成)/.test(message);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);

    if (wantGenerate) {
      // 让 AI 基于对话内容生成文档 JSON
      session.messages.push({ role: 'user', content: message || '信息已补充完毕，请生成文档。' });
      send({ generate: true, done: true });
      return res.end();
    }

    // 普通对话轮：AI 追问（流式输出）
    session.messages.push({ role: 'user', content: message });
    session.ts = Date.now();
    if (!llmAvailable()) {
      send({ error: 'AI 未配置，无法继续追问。' });
      return res.end();
    }
    try {
      const reply = await chat(session.messages, { temperature: 0.3 });
      session.messages.push({ role: 'assistant', content: reply });
      const SLICE = 24;
      for (let i = 0; i < reply.length; i += SLICE) {
        send({ delta: reply.slice(i, i + SLICE) });
        await sleep(14);
      }
      send({ done: true });
    } catch (e) {
      send({ error: e.message });
    }
    return res.end();
  }

  if (req.method === 'POST' && u.pathname === '/api/interview/generate') {
    const { sessionId, owner } = await readBody(req);
    const session = interviewSessions.get(sessionId);
    if (!session) return json(res, 400, { error: '会话已过期，请重新开始' });

    try {
      const doc = await interviewGenerate(session.messages, owner || session.owner);
      if (!doc) return json(res, 500, { error: 'AI 生成文档失败，请补充更多信息后重试' });
      return json(res, 200, { doc });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  if (req.method === 'POST' && u.pathname === '/api/interview/publish') {
    const { sessionId, doc, dryRun } = await readBody(req);
    if (!doc) return json(res, 400, { error: 'missing doc' });
    const session = sessionId ? interviewSessions.get(sessionId) : null;
    const owner = session ? session.owner : '';
    doc.frontmatter.status = 'review'; // 准入门禁：AI 问答式草稿默认待确认
    try {
      const r = await enqueue(() => publish(ROOT, doc, { owner }, { dryRun }));
      if (sessionId) interviewSessions.delete(sessionId);
      if (!dryRun) bumpAuthorship('ai');
      return json(res, 200, r);
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  /* ============ 缺口闭环：高频缺口 → AI 起草草稿 ============ */
  if (req.method === 'GET' && u.pathname === '/api/gaps') {
    const gaps = loadGaps();
    return json(res, 200, { gaps: gaps.slice(0, 30) });
  }

  if (req.method === 'POST' && u.pathname === '/api/gaps/draft') {
    const { question } = await readBody(req);
    if (!question) return json(res, 400, { error: 'missing question' });
    try {
      const doc = await gapDraftDoc(ROOT, question);
      if (!doc) return json(res, 200, { error: 'AI 无法根据此问题生成草稿，请手动新增' });
      return json(res, 200, { doc });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  if (req.method === 'POST' && u.pathname === '/api/gaps/publish') {
    const { doc, owner, question, dryRun } = await readBody(req);
    if (!doc) return json(res, 400, { error: 'missing doc' });
    doc.frontmatter.status = 'review'; // 准入门禁：AI 起草草稿默认待确认
    try {
      const r = await enqueue(() => publish(ROOT, doc, { owner }, { dryRun }));
      if (question) resolveGap(question); // 闭环：发布即消除该缺口
      if (!dryRun) bumpAuthorship('ai');
      return json(res, 200, r);
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  if (req.method === 'POST' && u.pathname === '/api/gaps/resolve') {
    const { question } = await readBody(req);
    if (!question) return json(res, 400, { error: 'missing question' });
    resolveGap(question);
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && u.pathname === '/api/doc/status') {
    const { path: rel, status, dryRun } = await readBody(req);
    if (!rel || !status) return json(res, 400, { error: 'missing path or status' });
    try {
      const r = await enqueue(() => setStatus(ROOT, rel, status, { dryRun }));
      return json(res, 200, r);
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  if (req.method === 'GET' && u.pathname === '/api/metrics') {
    return json(res, 200, loadMetrics());
  }

  // 体检自动化（功能 C）：手动触发保鲜复审 + 企微推送
  if (req.method === 'POST' && u.pathname === '/api/govern/run') {
    try {
      const r = await enqueue(() => runGovernCycle(ROOT));
      lastGovernRun = { at: new Date().toISOString(), marked: r.marked.length, pushed: !r.push.skipped };
      return json(res, 200, { ok: true, marked: r.marked, push: r.push });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  return json(res, 404, { error: 'unknown api' });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (u.pathname.startsWith('/api/')) return await handleApi(req, res, u);
    // 仓库图片资源：/assets/<file> → 仓库根 assets/（编辑器插入的图片存这里）
    if (u.pathname.startsWith('/assets/')) {
      const rel = decodeURIComponent(u.pathname.slice('/assets/'.length));
      const assetsRoot = path.join(ROOT, 'assets');
      const abs = path.join(assetsRoot, rel);
      if (!abs.startsWith(assetsRoot) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
        res.writeHead(404);
        return res.end('not found');
      }
      const ext = path.extname(abs).slice(1).toLowerCase();
      const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' }[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
      return fs.createReadStream(abs).pipe(res);
    }
    const file = u.pathname === '/' ? 'index.html' : u.pathname.slice(1);
    const abs = path.join(HERE, 'public', file);
    if (!abs.startsWith(path.join(HERE, 'public')) || !fs.existsSync(abs)) {
      res.writeHead(404);
      return res.end('not found');
    }
    const ext = path.extname(abs).slice(1);
    const mime = { html: 'text/html; charset=utf-8', js: 'application/javascript; charset=utf-8', css: 'text/css; charset=utf-8', json: 'application/json; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', ico: 'image/x-icon' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
    fs.createReadStream(abs).pipe(res);
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

// iWiki 整树导入（几十篇 + 图片下载）可能超过默认 5 分钟请求超时，放宽到 30 分钟
server.requestTimeout = 30 * 60 * 1000;
server.headersTimeout = 31 * 60 * 1000;

server.listen(PORT, () => {
  console.log(`内部知识库 管理台: http://localhost:${PORT}  (仓库: ${ROOT}, LLM: ${llmAvailable() ? '已配置' : '未配置，问答降级为检索'})`);
  // 后台预热检索模型（embedding + reranker 冷加载合计可达 2 分钟，会拖垮新窗口首问）
  setTimeout(async () => {
    const t0 = Date.now();
    try {
      const { embed, reindex, indexExists } = await import('./embed.mjs');
      const { rerank } = await import('./rerank.mjs');
      await embed(['预热'], { isQuery: true });
      await rerank('预热', [{ text: '预热文本' }], 1);
      console.log(`检索模型预热完成（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
      // 启动自检：.rag 被 gitignore、不会随部署包上传，全新部署后→首次写操作前会退化为纯关键词而漏检。
      // 这里检测无索引则后台全量建一次，消除该空窗期（异步、不阻塞启动）。
      if (!indexExists(ROOT)) {
        console.log('未检测到向量索引，后台自动全量构建中…');
        const r = await reindex(ROOT, { full: true });
        console.log(`向量索引构建完成：共 ${r.total} 块，本次 embed ${r.embedded} 块。`);
      }
    } catch (e) {
      console.warn(`检索模型预热失败（将在首问时退化为关键词检索）：${e.message}`);
    }
  }, 500);
});
