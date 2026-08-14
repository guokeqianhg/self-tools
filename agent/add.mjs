// add：三种方式生成 OKF 文档（描述生成 / 上传整理 / 模板填空），统一走 校验 → commit → push 发布管线。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chat, llmAvailable } from './llm.mjs';
import { parseFrontmatter, invalidateDocsCache } from './scan.mjs';
import { findOrphanedByChange, deleteAssets } from './assets.mjs';

const DOMAIN_TYPES = {
  metrics: 'Metric',
  product: 'Feature',
  team: 'Context',
  guides: 'Guide',
  references: 'Reference',
};
const TYPE_DOMAINS = Object.fromEntries(Object.entries(DOMAIN_TYPES).map(([d, t]) => [t, d]));
const TEMPLATE_DIR = 'templates';

const today = () => new Date().toISOString().slice(0, 10);

function kebab(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'untitled';
}

function extractJson(text) {
  const block = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = block ? block[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  return JSON.parse(raw);
}

const SCHEMA_HINT = `只输出一个 JSON 对象（不要输出其他内容），结构：
{
  "domain": "上述目录之一（不带斜杠）",
  "filename": "小写 kebab-case 文件名，不带 .md",
  "frontmatter": { "type": "...", "title": "...", "description": "一句话摘要", "tags": ["..."], "owner": "..." },
  "body": "Markdown 正文（不含 frontmatter），用结构化标题/列表/表格，外部来源放文末 # Citations"
}`;
const DOMAIN_HINT = `知识域目录与默认 type 的对应关系：${Object.entries(DOMAIN_TYPES).map(([d, t]) => `${d}/ -> ${t}`).join('；')}。`;

/* ================= 方式一：描述生成 ================= */
async function draftDescribe(input, hints) {
  const sys = `你是 OKF v0.1 知识库的文档撰写助手。根据用户描述生成一篇中文知识文档。\n${DOMAIN_HINT}\n${SCHEMA_HINT}`;
  const out = await chat([
    { role: 'system', content: sys },
    { role: 'user', content: `文档描述：${input}\n附加要求：${JSON.stringify(hints)}` },
  ]);
  return out ? extractJson(out) : null;
}

function fallbackDescribe(input, hints) {
  const domain = hints.domain && DOMAIN_TYPES[hints.domain] ? hints.domain : 'references';
  const title = hints.title || input.slice(0, 30);
  return {
    domain,
    filename: kebab(title),
    frontmatter: { type: DOMAIN_TYPES[domain], title, description: input.slice(0, 80), tags: [], owner: hints.owner || '' },
    body: `# 概述\n\n${input}\n\n# 详细内容\n\n（待补充）\n`,
  };
}

/* ================= 方式二：上传整理 ================= */
async function draftImport(text, filename, hints) {
  const sys = `你是 OKF v0.1 知识库的文档整理助手。用户上传了一份原始文档（可能是 Word/PDF 提取出的纯文本，格式杂乱）。
请识别其中的核心知识，提炼并重新整理为一篇规范的中文知识文档：去掉页眉页脚/目录等噪音，重排为结构化 Markdown，保留原文关键信息与数据。
${DOMAIN_HINT}\n${SCHEMA_HINT}`;
  const out = await chat([
    { role: 'system', content: sys },
    { role: 'user', content: `原始文件名：${filename}\n附加要求：${JSON.stringify(hints)}\n\n原始内容：\n${text.slice(0, 12000)}` },
  ]);
  return out ? extractJson(out) : null;
}

function fallbackImport(text, filename, hints) {
  const stem = kebab(String(filename).replace(/\.[^.]+$/, ''));
  const domain = hints.domain && DOMAIN_TYPES[hints.domain] ? hints.domain : 'references';
  return {
    domain,
    filename: stem,
    frontmatter: {
      type: DOMAIN_TYPES[domain],
      title: hints.title || stem,
      description: text.replace(/[#*`\[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80),
      tags: [],
      owner: hints.owner || '',
    },
    body: `# 概述\n\n${text.replace(/\s+/g, ' ').slice(0, 300)}\n\n# 详细内容\n\n${text.slice(0, 8000)}\n`,
  };
}

/* ================= 方式三：模板填空 ================= */
export function listTemplates(root) {
  const dir = path.join(root, TEMPLATE_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== 'index.md')
    .sort()
    .map((f) => {
      const { fm, body } = parseFrontmatter(fs.readFileSync(path.join(dir, f), 'utf8'));
      const sections = [...body.matchAll(/^# (.+)$/gm)].map((m) => m[1].trim());
      const fields = Object.keys(fm).filter((k) => !['type', 'timestamp'].includes(k) && !k.startsWith('template_'));
      return {
        file: f,
        name: fm.template_name || f.replace(/\.md$/, ''),
        desc: fm.template_desc || '',
        type: fm.type || '',
        title: fm.title || '',
        fields,
        sections,
      };
    });
}

export function docFromTemplate(root, { template, frontmatter = {}, sections = {} }) {
  const abs = path.join(root, TEMPLATE_DIR, path.basename(String(template)));
  if (!fs.existsSync(abs)) throw new Error(`模板不存在: ${template}`);
  const { fm, body } = parseFrontmatter(fs.readFileSync(abs, 'utf8'));
  const type = fm.type || 'Reference';
  const domain = TYPE_DOMAINS[type] || 'references';
  const title = String(frontmatter.title || '').trim();
  if (!title) throw new Error('模板填空至少需要填写 title（标题）');

  const fmOut = { ...fm, ...frontmatter, type, title, timestamp: today() };
  fmOut.status = 'ready'; // 模板填空是人工发起，直接可用
  for (const k of Object.keys(fmOut)) {
    if (k.startsWith('template_')) delete fmOut[k]; // 模板自身的中文名/说明不写入正式文档
  }
  if (typeof fmOut.tags === 'string') {
    fmOut.tags = fmOut.tags.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  }
  // 每个章节：用户填写优先，未填则保留模板自带的指引文字（比干巴巴的"待补充"友好）
  const heads = [];
  const placeholders = {};
  {
    const re = /^# (.+)$/gm;
    let m;
    let last = null;
    let lastEnd = 0;
    while ((m = re.exec(body))) {
      if (last) placeholders[last] = body.slice(lastEnd, m.index).trim();
      last = m[1].trim();
      heads.push(last);
      lastEnd = re.lastIndex;
    }
    if (last) placeholders[last] = body.slice(lastEnd).trim();
  }
  const bodyOut = heads.length
    ? heads.map((h) => `# ${h}\n\n${String(sections[h] || '').trim() || placeholders[h] || '（待补充）'}`).join('\n\n') + '\n'
    : `# 概述\n\n${String(sections['概述'] || '').trim() || '（待补充）'}\n`;
  return { domain, filename: kebab(title), frontmatter: fmOut, body: bodyOut };
}

/* ================= 统一渲染与发布 ================= */
function yamlScalar(v) {
  const s = String(v).replace(/\s*\r?\n\s*/g, ' ');
  if (s === '') return "''";
  if (/[:#\[\]{},&*!|>'"%@`]/.test(s) || /^[-?\s]|\s$/.test(s) || /^(true|false|null|yes|no|~)$|\d/.test(s)) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return s;
}

function render(doc) {
  const fm = doc.frontmatter || {};
  const ordered = ['type', 'title', 'description', 'resource', 'tags', 'owner', 'timestamp', 'status'];
  const keys = [...ordered.filter((k) => k in fm), ...Object.keys(fm).filter((k) => !ordered.includes(k))];
  const lines = ['---'];
  for (const k of keys) {
    const v = fm[k];
    if (v === undefined || v === null) continue;
    lines.push(`${k}: ${Array.isArray(v) ? `[${v.map(yamlScalar).join(', ')}]` : yamlScalar(v)}`);
  }
  lines.push('---', '', String(doc.body).replace(/\s*$/, ''));
  return lines.join('\n') + '\n';
}

// 发布身份：优先系统 git 配置，其次环境变量 GIT_USER_NAME / GIT_USER_EMAIL（可写在 .env）
function gitIdentityArgs() {
  const name = process.env.GIT_USER_NAME || '';
  const email = process.env.GIT_USER_EMAIL || '';
  return name ? ['-c', `user.name=${name}`, '-c', `user.email=${email}`] : null;
}

function run(cmd, args, cwd, { allowFail = false } = {}) {
  try {
    return { ok: true, out: execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    if (allowFail) return { ok: false, out: String(e.stdout || ''), err: String(e.stderr || e.message) };
    throw e;
  }
}

function runValidate(root) {
  for (const py of ['python', 'python3', 'py']) {
    const r = run(py, ['tools/validate.py'], root, { allowFail: true });
    if (r.ok || /error/i.test(r.out + (r.err || ''))) return r;
  }
  return null; // 本机无 python
}

function updateLog(root, title, rel, verb = 'Creation', action = '新增') {
  const logPath = path.join(root, 'log.md');
  if (!fs.existsSync(logPath)) return;
  const date = today();
  const entry = `* **${verb}**: ${action} [${title}](/${rel})（Agent 生成）。`;
  let text = fs.readFileSync(logPath, 'utf8');
  const heading = `## ${date}`;
  if (text.includes(heading)) {
    text = text.replace(heading, `${heading}\n\n${entry}`);
  } else {
    text = text.replace(/^(# .*\n)/, `$1\n${heading}\n\n${entry}\n`);
  }
  fs.writeFileSync(logPath, text, 'utf8');
}

export async function publish(root, doc, hints = {}, flags = {}) {
  // 人工指定优先
  if (hints.domain && DOMAIN_TYPES[hints.domain]) {
    doc.domain = hints.domain;
    doc.frontmatter.type = DOMAIN_TYPES[hints.domain];
  }
  if (hints.title) doc.frontmatter.title = hints.title;
  if (hints.owner) doc.frontmatter.owner = hints.owner;
  if (!DOMAIN_TYPES[doc.domain]) throw new Error(`未知知识域: ${doc.domain}（可选：${Object.keys(DOMAIN_TYPES).join('/')}）`);
  if (!doc.frontmatter.timestamp) doc.frontmatter.timestamp = today();

  const filename = `${kebab(doc.filename || doc.frontmatter.title)}.md`;
  const rel = `${doc.domain}/${filename}`;
  const abs = path.join(root, rel);
  if (fs.existsSync(abs) && !flags.force) throw new Error(`文件已存在: ${rel}（--force 可覆盖）`);
  const content = render(doc);

  if (flags.dryRun) return { rel, pushed: false, preview: content };

  fs.writeFileSync(abs, content, 'utf8');
  invalidateDocsCache(root);
  console.log(`已写入 ${rel}`);

  updateLog(root, doc.frontmatter.title, rel);
  for (const py of ['python', 'python3', 'py']) {
    if (run(py, ['tools/build_index.py'], root, { allowFail: true }).ok) break;
  }

  const v = runValidate(root);
  if (v && !v.ok) {
    fs.rmSync(abs);
    throw new Error(`校验未通过，已回滚新文件：\n${v.out}${v.err || ''}`);
  }
  if (!v) console.warn('本机未找到 python，跳过 tools/validate.py（合入前请手动校验）。');
  else process.stdout.write(v.out);

  const identity = gitIdentityArgs();
  const name = run('git', ['config', 'user.name'], root, { allowFail: true }).out?.trim();
  if (!name && !identity) throw new Error('未配置 git user.name/user.email，请执行 git config --global 设置，或在 .env 中配置 GIT_USER_NAME / GIT_USER_EMAIL。');
  run('git', ['add', rel, 'log.md'], root);
  run('git', ['-c', 'core.quotepath=false', ...(identity || []), 'commit', '-m', `docs: add ${doc.frontmatter.title} [agent]`], root);
  await syncRagIndex(root);
  if (flags.noPush) {
    console.log('已提交本地（--no-push），未推送。');
    return { rel, pushed: false };
  }
  const p = run('git', ['push', 'origin', 'HEAD:main'], root, { allowFail: true });
  if (!p.ok) throw new Error(`push 失败：${p.err || p.out}`);
  console.log('已推送到 origin/main。');
  return { rel, pushed: true };
}

/* ================= 编辑 / 删除 ================= */
const EDITABLE_RE = /^(metrics|product|team|guides|references)\/[^/]+\.md$/;

function assertEditable(rel) {
  if (!EDITABLE_RE.test(rel) || rel.endsWith('index.md')) {
    throw new Error('仅允许操作知识域目录（metrics/product/team/guides/references）下的文档');
  }
}

// files: 本次要提交的路径清单（相对仓库根，可含目录、可含已删除的文件）。
// 必须显式传：早期实现固定用 `git add -A`，会把服务器工作区里无关的临时改动一起提交推送
// （曾把临时提取文件误推到 main）。仅在确实无法预知文件集合时才退回 -A。
export function gitCommitAndPush(root, message, flags = {}, files = null) {
  const identity = gitIdentityArgs();
  const name = run('git', ['config', 'user.name'], root, { allowFail: true }).out?.trim();
  if (!name && !identity) throw new Error('未配置 git user.name/user.email，请执行 git config --global 设置，或在 .env 中配置 GIT_USER_NAME / GIT_USER_EMAIL。');
  if (Array.isArray(files) && files.length) {
    // 逐个add：不存在且未跟踪的路径（如本次没产生图片的 assets/）会失败，忽略即可；
    // 已删除的文件 add 会正确 stage 成删除
    for (const f of files) run('git', ['add', '--', f], root, { allowFail: true });
  } else {
    run('git', ['add', '-A'], root);
  }
  run('git', ['-c', 'core.quotepath=false', ...(identity || []), 'commit', '-m', message], root);
  if (flags.noPush) return false;
  const p = run('git', ['push', 'origin', 'HEAD:main'], root, { allowFail: true });
  if (!p.ok) throw new Error(`push 失败：${p.err || p.out}`);
  return true;
}

function rebuildIndexAndValidate(root, rollback) {
  for (const py of ['python', 'python3', 'py']) {
    if (run(py, ['tools/build_index.py'], root, { allowFail: true }).ok) break;
  }
  const v = runValidate(root);
  if (v && !v.ok) {
    rollback();
    throw new Error(`校验未通过，已回滚：\n${v.out}${v.err || ''}`);
  }
  return v;
}

// 发布/变更后增量重建 RAG 向量索引；失败不阻塞发布（依赖缺失时检索自动退化为关键词）。
async function syncRagIndex(root) {
  try {
    const { reindex } = await import('./embed.mjs');
    const r = await reindex(root);
    if (r.embedded) console.log(`RAG 索引已更新：本次 embed ${r.embedded} 块，共 ${r.total} 块。`);
  } catch (e) {
    console.warn(`RAG 索引更新跳过（${e.message}）。可稍后运行 node agent/cli.mjs reindex 手动重建。`);
  }
}

export async function updateDoc(root, rel, content, flags = {}) {
  rel = String(rel || '').replace(/^\/+/, '');
  assertEditable(rel);
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) throw new Error(`文档不存在: ${rel}`);
  if (!String(content || '').trim()) throw new Error('内容不能为空');
  const backup = fs.readFileSync(abs, 'utf8');
  if (backup === content) return { rel, pushed: false, unchanged: true };

  fs.writeFileSync(abs, content, 'utf8');
  invalidateDocsCache(root);
  const { fm } = parseFrontmatter(content);
  updateLog(root, fm.title || rel, rel, 'Update', '更新');
  rebuildIndexAndValidate(root, () => {
    fs.writeFileSync(abs, backup, 'utf8');
    run('git', ['checkout', '--', 'log.md'], root, { allowFail: true });
  });
  // 方案 A：本次编辑中失去引用、且全库零引用的图片，随这次提交一并删除
  const orphans = findOrphanedByChange(root, backup, content);
  const deletedImgs = orphans.length ? deleteAssets(root, orphans) : [];
  if (deletedImgs.length) console.log(`同步删除失去引用的图片：${deletedImgs.join('、')}`);
  const pushed = gitCommitAndPush(root, `docs: update ${fm.title || rel} [agent]`, flags, [rel, 'log.md', ...deletedImgs]);
  await syncRagIndex(root);
  return { rel, pushed, deletedImages: deletedImgs };
}

export async function deleteDoc(root, rel, flags = {}) {
  rel = String(rel || '').replace(/^\/+/, '');
  assertEditable(rel);
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) throw new Error(`文档不存在: ${rel}`);
  const backup = fs.readFileSync(abs, 'utf8');
  const { fm } = parseFrontmatter(backup);

  fs.rmSync(abs);
  invalidateDocsCache(root);
  updateLog(root, fm.title || rel, rel, 'Delete', '删除');
  rebuildIndexAndValidate(root, () => {
    fs.writeFileSync(abs, backup, 'utf8');
    run('git', ['checkout', '--', 'log.md'], root, { allowFail: true });
  });
  // 方案 A：文档删除后，它引用过且全库零引用的图片一并删除
  const orphans = findOrphanedByChange(root, backup, '');
  const deletedImgs = orphans.length ? deleteAssets(root, orphans) : [];
  if (deletedImgs.length) console.log(`同步删除失去引用的图片：${deletedImgs.join('、')}`);
  const pushed = gitCommitAndPush(root, `docs: delete ${fm.title || rel} [agent]`, flags, [rel, 'log.md', ...deletedImgs]);
  await syncRagIndex(root);
  return { rel, pushed, deletedImages: deletedImgs };
}

// 准入门禁：切换文档质量状态（ready 可直接用 / review 待确认 / verify 待验证）
export async function setStatus(root, rel, status, flags = {}) {
  rel = String(rel || '').replace(/^\/+/, '');
  assertEditable(rel);
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) throw new Error(`文档不存在: ${rel}`);
  if (!['ready', 'review', 'verify'].includes(status)) throw new Error(`未知状态: ${status}`);
  const backup = fs.readFileSync(abs, 'utf8');
  const { fm, body } = parseFrontmatter(backup);
  const label = { ready: '确认发布', verify: '标记待验证', review: '撤回待确认' }[status] || status;
  fm.status = status;
  const content = render({ frontmatter: fm, body });
  if (flags.dryRun) return { rel, pushed: false, preview: content };
  fs.writeFileSync(abs, content, 'utf8');
  invalidateDocsCache(root);
  updateLog(root, fm.title || rel, rel, 'Update', label);
  rebuildIndexAndValidate(root, () => fs.writeFileSync(abs, backup));
  const pushed = gitCommitAndPush(root, `docs: ${label} ${fm.title || rel} [agent]`, flags, [rel, 'log.md']);
  await syncRagIndex(root);
  return { rel, pushed, status };
}

/* ================= 对外入口 ================= */
export async function addDoc(root, input, hints = {}, flags = {}) {
  let doc = null;
  if (llmAvailable()) {
    try {
      doc = await draftDescribe(input, hints);
    } catch (e) {
      console.warn(`LLM 起草失败（${e.message}），改用确定性模板。`);
    }
  } else {
    console.warn('未配置 LLM_API_KEY，使用确定性模板（可用 --domain/--title 指定）。');
  }
  if (!doc) doc = fallbackDescribe(input, hints);
  // 准入门禁：AI 起草默认"待确认"，人工确定性兜底算"可直接用"
  doc.frontmatter.status = llmAvailable() ? 'review' : 'ready';
  return publish(root, doc, hints, flags);
}

export async function importDoc(root, { filename, text }, hints = {}, flags = {}) {
  if (!text || !String(text).trim()) throw new Error('未能从文件中提取到文本内容');
  let doc = null;
  if (llmAvailable()) {
    try {
      doc = await draftImport(String(text), filename, hints);
    } catch (e) {
      console.warn(`LLM 整理失败（${e.message}），改用原样归档。`);
    }
  } else {
    console.warn('未配置 LLM_API_KEY，上传内容将按原样归档（建议配置后重试以获得 AI 整理）。');
  }
  if (!doc) doc = fallbackImport(String(text), filename, hints);
  // 准入门禁：AI 整理默认"待确认"，原样归档算"可直接用"
  doc.frontmatter.status = llmAvailable() ? 'review' : 'ready';
  return publish(root, doc, hints, flags);
}

export async function templateDoc(root, payload, flags = {}) {
  const doc = docFromTemplate(root, payload);
  return publish(root, doc, {}, flags);
}

/* ================= 方式五：iWiki 导入（忠实照搬，非 AI 重写） ================= */
// 从 Markdown 正文提取一句话摘要（取第一段非标题/非图片的有效文本）
function deriveDescription(markdown) {
  for (const line of markdown.split('\n')) {
    const t = line
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接只留文字
      .replace(/https?:\/\/\S+/g, '')
      .replace(/[#>*`|]/g, '')
      .replace(/^[\s\-+•·\d.、）)]+/, '') // 剥离列表符/序号前缀（避免 YAML 块指示符）
      .replace(/\s+/g, ' ')
      .trim();
    if (t.length >= 8) return t.slice(0, 120);
  }
  return '';
}

// fetched（iwikiFetchForImport 的结果）→ 标准文档对象（忠实照搬 + frontmatter + 文末出处）
function iwikiDocFromFetched(fetched, { domain = 'references', title, owner, extraTags = [], filename } = {}) {
  const t = title || fetched.title;
  return {
    domain,
    filename: filename || kebab(t),
    frontmatter: {
      type: DOMAIN_TYPES[domain],
      title: t,
      description: deriveDescription(fetched.markdown) || `导入自 iWiki（文档 ID ${fetched.docid}）`,
      resource: fetched.sourceUrl,
      tags: [...new Set(['iwiki', ...extraTags])],
      owner: owner || fetched.author || '',
      timestamp: today(),
      // 人工发起的忠实照搬（非 AI 草稿）：直接 ready，发布后即可被智能问答检索
      status: 'ready',
    },
    // 忠实照搬原文，文末附 iWiki 出处链接，便于检索后快速定位原文
    body: `${fetched.markdown.trim()}\n\n---\n\n> 原文出处：[${t}（iWiki）](${fetched.sourceUrl})\n`,
  };
}

export async function importIwikiDoc(root, { url }, hints = {}, flags = {}) {
  const { iwikiAvailable, iwikiFetchForImport } = await import('./iwiki.mjs');
  if (!iwikiAvailable()) throw new Error('未配置 IWIKI_PAT（iWiki 个人 Token，见 .env.example），无法读取 iWiki。');
  const fetched = await iwikiFetchForImport(root, url, { downloadImages: !flags.dryRun });

  const domain = hints.domain && DOMAIN_TYPES[hints.domain] ? hints.domain : 'references';
  const doc = iwikiDocFromFetched(fetched, { domain, title: hints.title, owner: hints.owner });

  if (flags.dryRun) return publish(root, doc, hints, flags);
  // 图片先入库（publish 只提交文档本身），若随后校验失败会留下少量孤立图片（无害，可手动清理）
  if (fetched.images.length) gitCommitAndPush(root, `docs: add iwiki images for ${doc.frontmatter.title} [agent]`, {}, ['assets']);
  return publish(root, doc, hints, flags);
}

/* ============ 方式五扩展：iWiki 整树导入（一级索引 + 二级平铺，方案 B） ============ */
// 贴一个一级页面链接 → 展开全部二级子页面逐篇导入（文件名加父前缀消歧），
// 一级页面本身生成「索引文档」（概述 + 库内子文档链接列表）。
// 全部写盘后：一次校验（失败整批回滚）→ 单次 commit+push → 一次增量重建 RAG。
export async function importIwikiTree(root, { url }, hints = {}, flags = {}) {
  const { iwikiAvailable, iwikiFetchForImport, iwikiGetPageTree, iwikiMetadata, parseDocid, iwikiPageUrl } = await import('./iwiki.mjs');
  if (!iwikiAvailable()) throw new Error('未配置 IWIKI_PAT（iWiki 个人 Token，见 .env.example），无法读取 iWiki。');
  const parentId = parseDocid(url);
  if (!parentId) throw new Error('无法从输入解析 iWiki 文档 ID（支持完整链接 / p/xxxx / 纯数字）');

  const parentMeta = await iwikiMetadata(parentId);
  const parentTitle = hints.title || String(parentMeta.title || '').trim() || `iWiki ${parentId}`;
  const children = await iwikiGetPageTree(parentId);
  if (!children.length) throw new Error('该页面下没有子页面，请改用「单篇导入」');

  const domain = hints.domain && DOMAIN_TYPES[hints.domain] ? hints.domain : 'product';
  // 文件名使用父页面标题作为前缀，避免同名子页面相互覆盖。
  const prefix = kebab(parentTitle);
  const parentTag = kebab(parentTitle);
  const extraTags = ['官方文档', parentTag];

  if (flags.dryRun) {
    return {
      parentTitle,
      domain,
      planned: children.map((c) => ({ docid: c.docid, title: c.title, rel: `${domain}/${prefix}-${kebab(c.title)}.md` })),
    };
  }

  // 逐篇导入二级子页面（单篇失败不阻断整批）
  const results = [];
  const written = [];
  for (const child of children) {
    const rel = `${domain}/${prefix}-${kebab(child.title)}.md`;
    const abs = path.join(root, rel);
    if (fs.existsSync(abs)) { results.push({ title: child.title, rel, skipped: true }); continue; }
    try {
      const fetched = await iwikiFetchForImport(root, String(child.docid), { downloadImages: true });
      const doc = iwikiDocFromFetched(fetched, {
        domain,
        title: fetched.title || child.title,
        owner: hints.owner,
        extraTags,
        filename: `${prefix}-${kebab(child.title)}`,
      });
      fs.writeFileSync(abs, render(doc), 'utf8');
      written.push(rel);
      results.push({ title: doc.frontmatter.title, rel, ok: true });
      console.log(`已导入 ${rel}`);
    } catch (e) {
      results.push({ title: child.title, rel, error: e.message });
      console.warn(`导入失败 ${child.title}：${e.message}`);
    }
  }
  const okDocs = results.filter((r) => r.ok);
  const skipped = results.filter((r) => r.skipped);
  if (!okDocs.length && !skipped.length) {
    throw new Error(`所有子页面导入失败（共 ${children.length} 篇），首个错误：${results[0]?.error || '未知'}`);
  }

  // 一级索引文档：概述（一级页面自身正文）+ 库内子文档链接列表
  const indexRel = `${domain}/${kebab(parentTitle)}.md`;
  const indexAbs = path.join(root, indexRel);
  let indexWritten = false;
  if (!fs.existsSync(indexAbs)) {
    let parentBody = '';
    try {
      const pf = await iwikiFetchForImport(root, parentId, { downloadImages: true });
      parentBody = pf.markdown.trim();
    } catch { /* 一级页面无正文或读取失败不阻断 */ }
    const listed = results.filter((r) => r.ok || r.skipped);
    const listMd = listed.map((r) => `- [${r.title}](/${r.rel})`).join('\n');
    const indexDoc = {
      domain,
      filename: kebab(parentTitle),
      frontmatter: {
        type: DOMAIN_TYPES[domain],
        title: parentTitle,
        description: `${parentTitle} 官方文档索引，收录 ${listed.length} 篇子文档`,
        resource: iwikiPageUrl(parentId),
        tags: [...new Set(['iwiki', '官方文档', '索引', parentTag])],
        owner: hints.owner || String(parentMeta.content_last_modifier_cn || parentMeta.creator_cn || '').trim(),
        timestamp: today(),
        status: 'ready',
      },
      body: `${parentBody ? `${parentBody}\n\n---\n\n` : ''}# 子文档目录（${listed.length} 篇）\n\n${listMd}\n\n---\n\n> 原文出处：[${parentTitle}（iWiki）](${iwikiPageUrl(parentId)})\n`,
    };
    fs.writeFileSync(indexAbs, render(indexDoc), 'utf8');
    written.push(indexRel);
    indexWritten = true;
  }

  invalidateDocsCache(root);
  updateLog(root, `${parentTitle}（iWiki 整树导入 ${okDocs.length} 篇${indexWritten ? ' + 索引' : ''}）`, indexRel);
  for (const py of ['python', 'python3', 'py']) {
    if (run(py, ['tools/build_index.py'], root, { allowFail: true }).ok) break;
  }
  const v = runValidate(root);
  if (v && !v.ok) {
    for (const r of written) fs.rmSync(path.join(root, r), { force: true });
    run('git', ['checkout', '--', 'log.md'], root, { allowFail: true });
    throw new Error(`校验未通过，已回滚本批 ${written.length} 篇文档：\n${v.out}${v.err || ''}`);
  }
  if (v) process.stdout.write(v.out);

  const pushed = gitCommitAndPush(root, `docs: import iwiki tree ${parentTitle} (${okDocs.length} docs) [agent]`, flags, [...written, 'log.md', 'assets']);
  await syncRagIndex(root);
  return {
    parentTitle,
    indexRel,
    imported: okDocs.length,
    skipped: skipped.length,
    failed: results.filter((r) => r.error),
    results,
    pushed,
  };
}
