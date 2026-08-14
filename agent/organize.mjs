// 整理 Agent：把上传的原始文档（word/pdf/md/txt）整理为 OKF 知识文档。
// 两阶段：planImport 出整理方案（诊断 + 规划 + 查重）→ executeImport 逐篇起草并发布。
import fs from 'node:fs';
import path from 'node:path';
import { chat, llmAvailable } from './llm.mjs';
import { loadDocs, parseFrontmatter } from './scan.mjs';
import { publish } from './add.mjs';

const DOMAIN_LABELS = {
  metrics: '指标与度量(Metric)',
  product: '系统与工具(Feature)',
  team: '组织与协作(Context)',
  guides: '流程指南(Guide)',
  references: '公开资料(Reference)',
};
const DOMAIN_TYPES = Object.fromEntries(Object.entries(DOMAIN_LABELS).map(([d, l]) => [d, l.match(/\((\w+)\)/)[1]]));

function kebab(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '') || 'untitled';
}

function extractJson(text) {
  const block = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = block ? block[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  return JSON.parse(raw);
}

function readGlossary(root) {
  try {
    return fs.readFileSync(path.join(root, 'team', 'glossary.md'), 'utf8').slice(0, 3000);
  } catch {
    return '';
  }
}

function existingDocsSummary(root) {
  return loadDocs(root)
    .filter((d) => !d.path.endsWith('index.md') && !d.path.startsWith('templates/'))
    .map((d) => `- /${d.path} | ${d.type} | ${d.title} | ${d.fm.description || ''}`)
    .join('\n')
    .slice(0, 4000);
}

function fallbackPlan(filename, text, hints) {
  const stem = kebab(String(filename).replace(/\.[^.]+$/, ''));
  const domain = hints.domain && DOMAIN_TYPES[hints.domain] ? hints.domain : 'references';
  return {
    notes: '未配置 LLM，无法智能诊断；按单篇原样归档。',
    items: [{
      action: 'create', domain, type: DOMAIN_TYPES[domain],
      title: hints.title || stem, filename: stem,
      points: [text.replace(/\s+/g, ' ').slice(0, 100)],
    }],
  };
}

function sanitizePlan(plan, hints) {
  if (!plan || !Array.isArray(plan.items) || !plan.items.length) throw new Error('整理方案为空');
  for (const item of plan.items) {
    if (!DOMAIN_TYPES[item.domain]) item.domain = hints.domain && DOMAIN_TYPES[hints.domain] ? hints.domain : 'references';
    item.type = DOMAIN_TYPES[item.domain];
    item.action = item.action === 'update' && item.target ? 'update' : 'create';
    item.filename = kebab(item.filename || item.title);
    item.title = String(item.title || item.filename);
    item.points = Array.isArray(item.points) ? item.points.map(String) : [];
  }
  return plan;
}

/* ================= 阶段一：诊断规划 ================= */
export async function planImport(root, { filename, text }, hints = {}) {
  if (!text || !String(text).trim()) throw new Error('未能从文件中提取到文本内容');
  if (!llmAvailable()) return fallbackPlan(filename, String(text), hints);

  const sys = `你是团队知识库的"文档整理 Agent"。用户上传了一份原始文档（可能是 Word/PDF 提取的纯文本，格式杂乱）。你的任务是先输出"整理方案"，不要写正文。
知识库分类（domain -> 说明）：${Object.entries(DOMAIN_LABELS).map(([d, l]) => `${d} ${l}`).join('；')}。
规则：
1. 通读内容，按主题把文档拆成 1~N 篇知识文档（单一主题就只出 1 篇，不要硬拆）；
2. 与"现有文档清单"比对：主题明显重复的，action 用 "update" 并给出 target 路径（将合并更新该文档）；否则 "create"；
3. 术语必须严格采用《团队术语表》的口径，禁止自造词、禁止近义替换；
4. 只输出 JSON（不要输出其他内容）：
{"notes":"一句话说明这份文档的内容与你的整理思路","items":[{"action":"create|update","domain":"...","title":"...","filename":"小写 kebab-case 不带.md","target":"update 时为已有文档路径","points":["这篇要覆盖的要点1","要点2"]}]}`;
  const user = `原始文件名：${filename}
附加要求：${JSON.stringify(hints)}

《团队术语表》摘录：
${readGlossary(root) || '（暂无术语表）'}

现有文档清单：
${existingDocsSummary(root) || '（知识库为空）'}

原始内容（截断至 1 万字）：
${String(text).slice(0, 10000)}`;

  const out = await chat([
    { role: 'system', content: sys },
    { role: 'user', content: user },
  ], { temperature: 0.15 });
  return sanitizePlan(extractJson(out), hints);
}

/* ================= 阶段二：逐篇起草 ================= */
async function draftItem(root, filename, text, item, hints) {
  let existing = '';
  if (item.action === 'update' && item.target) {
    const abs = path.join(root, item.target);
    if (fs.existsSync(abs)) existing = fs.readFileSync(abs, 'utf8').slice(0, 4000);
  }
  const sys = `你是 OKF v0.1 知识库的文档撰写助手。根据"整理方案中的单篇规划"和原始文档内容，撰写一篇规范的中文知识文档。
术语必须严格采用《团队术语表》；外部来源放文末 # Citations。
只输出 JSON：{"frontmatter":{"type":"${item.type}","title":"...","description":"一句话摘要","tags":["..."],"owner":"..."},"body":"Markdown 正文（不含 frontmatter），结构化标题/列表/表格"}${existing ? '\n这是一篇更新：需在保留原文档有效内容的基础上，用新材料补充/修正，输出合并后的完整文档。' : ''}`;
  const user = `单篇规划：${JSON.stringify(item)}
原始文件名：${filename}
《团队术语表》摘录：
${readGlossary(root) || '（暂无）'}
${existing ? `\n被更新的现有文档内容：\n${existing}\n` : ''}
原始文档内容（摘取相关部分）：
${String(text).slice(0, 8000)}`;
  const out = await chat([
    { role: 'system', content: sys },
    { role: 'user', content: user },
  ], { temperature: 0.2 });
  const drafted = extractJson(out);
  return {
    domain: item.domain,
    filename: item.filename,
    frontmatter: { ...drafted.frontmatter, type: item.type, title: item.title },
    body: drafted.body,
  };
}

function fallbackItemDoc(text, item, hints) {
  return {
    domain: item.domain,
    filename: item.filename,
    frontmatter: {
      type: item.type,
      title: item.title,
      description: String(text).replace(/[#*`\[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80),
      tags: [],
      owner: hints.owner || '',
    },
    body: `# 概述\n\n${String(text).replace(/\s+/g, ' ').slice(0, 300)}\n\n# 详细内容\n\n${String(text).slice(0, 8000)}\n`,
  };
}

export async function executeImport(root, { filename, text }, plan, hints = {}, flags = {}) {
  sanitizePlan(plan, hints);
  const results = [];
  for (const item of plan.items) {
    if (item.skip) {
      results.push({ title: item.title, skipped: true });
      continue;
    }
    let doc;
    if (llmAvailable()) {
      try {
        doc = await draftItem(root, filename, String(text), item, hints);
      } catch (e) {
        console.warn(`LLM 起草「${item.title}」失败（${e.message}），原样归档。`);
        doc = fallbackItemDoc(text, item, hints);
      }
    } else {
      doc = fallbackItemDoc(text, item, hints);
    }
    if (hints.owner) doc.frontmatter.owner = hints.owner;
    // 准入门禁：新建文档默认"待确认"；更新已有文档则保留其已确认状态，避免把已转正文档拉回待确认
    if (item.action === 'update' && item.target) {
      const tAbs = path.join(root, item.target);
      if (fs.existsSync(tAbs)) {
        const { fm: tFm } = parseFrontmatter(fs.readFileSync(tAbs, 'utf8'));
        doc.frontmatter.status = tFm.status || 'ready';
      } else {
        doc.frontmatter.status = llmAvailable() ? 'review' : 'ready';
      }
    } else {
      doc.frontmatter.status = llmAvailable() ? 'review' : 'ready';
    }
    // update：发布到原路径（允许覆盖）；create：新文件
    const targetHints = item.action === 'update' && item.target
      ? { ...hints, domain: item.target.split('/')[0] }
      : hints;
    if (item.action === 'update' && item.target) doc.filename = item.target.split('/').pop().replace(/\.md$/, '');
    const r = await publish(root, doc, targetHints, { ...flags, force: item.action === 'update' || flags.force });
    results.push({ ...r, title: doc.frontmatter.title, action: item.action });
  }
  return { results };
}
