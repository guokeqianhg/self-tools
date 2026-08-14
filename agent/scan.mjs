// 知识库扫描与关键词检索：解析 frontmatter，按字段加权打分。
import fs from 'node:fs';
import path from 'node:path';

const SKIP_DIRS = new Set(['.git', '.github', 'node_modules', 'site', 'tools', 'agent', '__pycache__', 'templates', 'assets']);
// 导航页（index.md）不是知识文档，不进入检索/向量池
const SKIP_FILES = new Set(['index.md']);

export function parseFrontmatter(text) {
  const m = text.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/);
  if (!m) return { fm: {}, body: text };
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v.startsWith('[') && v.endsWith(']')) {
      v = v.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    } else {
      v = v.replace(/^["']|["']$/g, '');
    }
    fm[kv[1]] = v;
  }
  return { fm, body: text.slice(m[0].length) };
}

// 准入门禁：只有"可直接用"(ready)或旧文档(无 status)才进入 Agent 检索池；
// "待确认"(review) / "待验证"(verify) 默认不进池，避免未审 AI 草稿污染回答。
export function isAgentReady(d) {
  const s = d.fm.status;
  return s === undefined || s === null || s === '' || s === 'ready';
}

// loadDocs 结果缓存：每次请求都全量重扫仓库（含 500+ 文件）会阻塞事件循环。
// 写操作（add.mjs 各发布函数）与 git pull 后显式失效；TTL 作为直接改文件系统的兜底。
const docsCache = new Map(); // root -> { ts, docs }
const DOCS_CACHE_TTL = Number(process.env.DOCS_CACHE_TTL || 5000);

export function invalidateDocsCache(root) {
  if (root) docsCache.delete(root);
  else docsCache.clear();
}

export function loadDocs(root) {
  const hit = docsCache.get(root);
  if (hit && Date.now() - hit.ts < DOCS_CACHE_TTL) return hit.docs;
  const docs = loadDocsUncached(root);
  docsCache.set(root, { ts: Date.now(), docs });
  return docs;
}

function loadDocsUncached(root) {
  const docs = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(full);
        continue;
      }
      if (!e.name.endsWith('.md') || e.name === 'log.md') continue;
      if (SKIP_FILES.has(e.name)) continue;
      const text = fs.readFileSync(full, 'utf8');
      const { fm, body } = parseFrontmatter(text);
      const rel = path.relative(root, full).replace(/\\/g, '/');
      docs.push({
        path: rel,
        title: String(fm.title || path.basename(e.name, '.md')),
        type: String(fm.type || ''),
        fm,
        body,
      });
    }
  })(root);
  return docs;
}

function count(haystack, needle) {
  let n = 0;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) {
    n += 1;
    i += needle.length;
  }
  return n;
}

// 连续短语匹配：找出 query（清洗后）在 text 中出现的最长连续子串长度。
// 用于奖励"内存上限 / 掉帧率"这类连续短语命中——二元组打分对标题/正文里的精确短语很迟钝，
// 导致"明明标题就写着内存上限、却因标题/摘要没提内存而排名靠后"。返回 0 表示无 >=minLen 的命中。
const SPAN_MAX = 12; // 最长只查到 12 字，够用且控制开销
function longestSpan(query, text, minLen = 3) {
  const q = query.toLowerCase().replace(/[\s,，、。？?!！;；：:""'（）()【】[\]]+/g, '');
  if (q.length < minLen || !text) return 0;
  const t = text.toLowerCase();
  for (let n = Math.min(q.length, SPAN_MAX); n >= minLen; n--) {
    for (let i = 0; i + n <= q.length; i++) {
      const sub = q.slice(i, i + n);
      if (STOPWORDS.has(sub)) continue;
      if (t.includes(sub)) return n;
    }
  }
  return 0;
}

// 把正文按 1~3 级标题切为章节块（保留父级标题路径，子块继承父块关键词），
// 大段细分上限：标题块往往过长（如"安装及运行"1700+字，混入登录/USB/WIFI/步骤），
// 既稀释关键词信号，也会被 bge-reranker 截断丢掉相关句。把超长按空行细分成聚焦小块。
const MAX_BLOCK_CHARS = 700;
function pushBlocks(parts, heading, text) {
  if (text.length <= MAX_BLOCK_CHARS) { parts.push({ heading, text }); return; }
  let buf = '';
  for (const para of text.split(/\n{2,}/)) {
    if (buf && buf.length + para.length + 2 > MAX_BLOCK_CHARS) {
      parts.push({ heading, text: buf.trim() });
      buf = '';
    }
    buf += (buf ? '\n\n' : '') + para;
  }
  if (buf.trim()) parts.push({ heading, text: buf.trim() });
}

// Citations 块除外（链接由 resolveFootnotes 单独处理）
export function splitChunks(body) {
  const parts = [];
  const stack = []; // [{level, title}]
  let cur = [];
  const flush = () => {
    const text = cur.join('\n').trim();
    const heading = stack.map((s) => s.title).join(' > ') || '（开头）';
    if (text && !/^Citations$/i.test(stack[stack.length - 1]?.title || '')) {
      pushBlocks(parts, heading, text);
    }
  };
  for (const line of body.split('\n')) {
    const h = line.match(/^(#{1,3})\s+(.+)/);
    if (h) {
      flush();
      const level = h[1].length;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, title: h[2].trim() });
      cur = [];
    } else {
      cur.push(line);
    }
  }
  flush();
  return parts;
}

// 中文噪音词（二元组级别），避免稀释评分
const STOPWORDS = new Set([
  '这个', '那个', '什么', '怎么', '怎样', '哪里', '哪些', '没有', '有关', '关于',
  '我们', '你们', '他们', '可以', '是不是', '有没有', '请问', '告诉', '一下',
  '是什么', '为什么', '当中', '其中', '里面', '出自', '来自', '出自', '个文',
]);

// 查询分词：先按标点粗分，再按 中文/拉丁 边界切段；中文段拆二元组，拉丁/路径整段保留
function terms(query) {
  const out = new Set();
  const raw = query.toLowerCase().split(/[\s,，、。？?!！;；：:""'（）()【】[\]]+/).filter(Boolean);
  for (const t of raw) {
    const segs = t.match(/[\u4e00-\u9fa5]+|[a-z0-9]+(?:[./_-][a-z0-9]+)*/g) || [];
    for (const seg of segs) {
      const tok = seg.replace(/^\/+|\/+$/g, '');
      if (!tok || STOPWORDS.has(tok)) continue;
      out.add(tok);
      if (/^[\u4e00-\u9fa5]+$/.test(tok) && tok.length > 2) {
        for (let i = 0; i < tok.length - 1; i += 1) {
          const bg = tok.slice(i, i + 2);
          if (!STOPWORDS.has(bg)) out.add(bg);
        }
      }
    }
  }
  return [...out];
}

export function searchDocs(docs, query, limit = 8) {
  const qs = terms(query);
  // IDF 权重：罕见词（fps）加权，常见词（性能/优化）降权
  const allText = docs.map((d) => `${d.title} ${Array.isArray(d.fm.tags) ? d.fm.tags.join(' ') : d.fm.tags || ''} ${d.fm.description || ''} ${d.path} ${d.body}`.toLowerCase());
  const idf = new Map(qs.map((q) => {
    const df = allText.reduce((n, t) => n + (t.includes(q) ? 1 : 0), 0);
    return [q, Math.log(1 + docs.length / (1 + df))];
  }));
  const scored = [];
  for (const d of docs) {
    const tags = Array.isArray(d.fm.tags) ? d.fm.tags.join(' ') : String(d.fm.tags || '');
    const fields = [
      [d.title.toLowerCase(), 5],
      [tags.toLowerCase(), 4],
      [String(d.fm.description || '').toLowerCase(), 3],
      [d.type.toLowerCase(), 2],
      [d.path.toLowerCase(), 2],
      [d.body.toLowerCase(), 1],
    ];
    let score = 0;
    for (const q of qs) {
      const idfW = idf.get(q) || 1;
      for (const [text, w] of fields) score += idfW * w * count(text, q);
    }
    // 连续短语奖励：标题命中权重最高，正文次之（长度平方放大，越长的精确短语越相关）
    const tSpan = longestSpan(query, d.title);
    const bSpan = longestSpan(query, d.body);
    score += (tSpan >= 3 ? tSpan * tSpan * 8 : 0) + (bSpan >= 3 ? bSpan * bSpan * 4 : 0);
    if (score > 0) {
      // 章节切块：显著词（拉丁/长中文段）权重 2，二元组权重 0.5 辅助
      const salient = qs.filter((q) => /^[a-z0-9]/.test(q) || q.length >= 3);
      const bigrams = qs.filter((q) => q.length === 2 && /^[\u4e00-\u9fa5]+$/.test(q));
      const chunks = splitChunks(d.body)
        .map((c) => {
          let cs = 0;
          const hay = `${c.heading}\n${c.text}`.toLowerCase();
          for (const q of salient) cs += 2 * count(hay, q);
          for (const q of bigrams) cs += 0.5 * count(hay, q);
          const cSpan = longestSpan(query, `${c.heading}\n${c.text}`);
          cs += cSpan >= 3 ? cSpan * cSpan * 2 : 0;
          return { ...c, score: cs };
        })
        .filter((c) => c.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);
      scored.push({ doc: d, score, chunks });
    }
  }
  // 文档定向：问题中明确提到某篇文档的路径或完整标题时，强制置顶该文档
  const normQ = query.toLowerCase();
  for (const d of docs) {
    const pinned = normQ.includes(d.path.toLowerCase())
      || (d.title.length >= 2 && normQ.includes(d.title.toLowerCase()));
    if (pinned && !scored.find((s) => s.doc === d)) {
      const chunks = splitChunks(d.body)
        .map((c) => {
          let cs = 0;
          const hay = `${c.heading}\n${c.text}`.toLowerCase();
          for (const q of qs) cs += count(hay, q);
          return { ...c, score: cs };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, 2);
      scored.push({ doc: d, score: (scored[0]?.score || 0) + 100, chunks });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
