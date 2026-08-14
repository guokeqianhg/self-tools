// 候选起草与发布：把一段聊天问答提炼成 OKF 规范文档，并与存量查重决定"新建"还是"补充进已有文档"。
//
// 起草只产出正文 markdown；frontmatter 由结构化字段（标题/知识域/描述/标签/责任人）承载，
// 最终交给 add.mjs 的 publish/updateDoc 渲染写入——避免在这里手写 YAML 渲染器造成口径不一致。
import fs from 'node:fs';
import path from 'node:path';
import { chat, llmAvailable } from '../llm.mjs';
import { loadDocs, parseFrontmatter } from '../scan.mjs';
import { publish, updateDoc, gitCommitAndPush } from '../add.mjs';
import { findOrphanedPastes, deleteAssets } from '../assets.mjs';
import { resolveGap, bumpAuthorship } from '../stats.mjs';
import { candidateMessages, upsertCandidate } from './store.mjs';
import { renderMessage } from './segment.mjs';

const DOMAINS = ['metrics', 'product', 'team', 'guides', 'references'];
const DOMAIN_LABELS = {
  metrics: '指标与度量(Metric)',
  product: '系统与工具(Feature)',
  team: '组织与协作(Context)',
  guides: '流程指南(Guide)',
  references: '公开资料(Reference)',
};

// 入库必脱敏：文档只保留会话名（群名），不写任何成员姓名与具体时间——
// 名字和时间留在本地原料区供审核回查，不随文档进仓库。

function kebab(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'untitled';
}

function extractJson(text) {
  const block = String(text).match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = block ? block[1] : String(text).slice(String(text).indexOf('{'), String(text).lastIndexOf('}') + 1);
  return JSON.parse(raw);
}

const today = () => new Date().toISOString().slice(0, 10);

// 存量文档清单（供查重判断"新建还是补充"）
function existingDocsSummary(root) {
  return loadDocs(root)
    .filter((d) => d.type && !d.path.endsWith('index.md') && !d.path.startsWith('templates/'))
    .map((d) => `- /${d.path} | ${d.type} | ${d.title} | ${d.fm.description || ''}`)
    .join('\n')
    .slice(0, 4000);
}

const SYSTEM = `你是团队知识库的编辑，负责把一段企业微信聊天问答整理成规范的知识文档。

要求：
1. 先判断这条知识应该新建文档，还是补充进已有文档：
   - 库里已有同主题文档 → mode="append"，targetPath 填该文档路径；
   - 库里没有覆盖该主题的文档 → mode="create"。
2. 正文用Markdown，一级标题（# 标题）作为章节。写成面向他人查阅的说明文，不要保留聊天口气、不要出现"某某说"。
3. 只写聊天里真实出现的信息，不要编造原理、参数或结论。信息不足的地方直接不写。
4. 保留关键数值、命令、路径、报错原文。
5. mode="append" 时，正文只写"要追加的那一节内容"（含它自己的一级标题），不要重复已有文档的其他内容。

知识域可选：${DOMAINS.map((d) => `${d}（${DOMAIN_LABELS[d]}）`).join('、')}

只输出 JSON，不要解释文字：
{
  "mode": "create" 或 "append",
  "targetPath": "append 时填已有文档路径，create 时为 null",
  "domain": "create 时填知识域，append 时为 null",
  "title": "文档标题（create）或追加章节的标题（append）",
  "description": "一句话摘要（不超过 60 字）",
  "tags": ["标签", "不超过 4 个"],
  "body": "Markdown 正文",
  "reason": "为什么这样处理（一句话）"
}`;

// 起草：调用模型生成正文与元信息，结果写回候选（status=drafted）
export async function draftCandidate(root, cand) {
  if (!llmAvailable()) throw new Error('未配置 LLM_API_KEY，无法起草');
  const msgs = candidateMessages(cand);
  if (!msgs.length) throw new Error('候选引用的原始消息已不存在（可能已被清理）');

  const user = [
    `【会话】${cand.sessionType === 'group' ? '群聊' : '单聊'}：${cand.sessionName || cand.sessionKey}`,
    `【模型归纳的问题】${cand.question || '（无）'}`,
    `【模型归纳的答案】${cand.answer || '（无）'}`,
    cand.relatedDoc ? `【疑似相关文档】/${cand.relatedDoc}` : '',
    '',
    '【原始对话】',
    ...msgs.map(renderMessage),
    '',
    '【知识库现有文档】',
    existingDocsSummary(root) || '（空库）',
  ].filter(Boolean).join('\n');

  const out = await chat([
    { role: 'system', content: SYSTEM },
    { role: 'user', content: user },
  ], { temperature: 0.2 });
  const plan = extractJson(out);

  const mode = plan.mode === 'append' ? 'append' : 'create';
  const targetPath = mode === 'append' ? String(plan.targetPath || '').replace(/^\/+/, '') : '';
  if (mode === 'append' && !fs.existsSync(path.join(root, targetPath))) {
    // 模型给了不存在的路径：退化为新建，避免发布时直接失败
    plan.mode = 'create';
  }
  const domain = DOMAINS.includes(plan.domain) ? plan.domain : (mode === 'append' && targetPath.includes('/') ? targetPath.split('/')[0] : 'guides');

  const rec = upsertCandidate({
    ...cand,
    status: 'drafted',
    mode: fs.existsSync(path.join(root, targetPath)) && mode === 'append' ? 'append' : 'create',
    targetPath: fs.existsSync(path.join(root, targetPath)) ? targetPath : '',
    domain: DOMAINS.includes(domain) ? domain : 'guides',
    title: String(plan.title || cand.title || '').trim().slice(0, 60),
    description: String(plan.description || '').trim().slice(0, 120),
    tags: (Array.isArray(plan.tags) ? plan.tags : []).map((t) => String(t).trim()).filter(Boolean).slice(0, 4),
    draft: String(plan.body || '').trim(),
    draftReason: String(plan.reason || '').trim(),
    draftedAt: new Date().toISOString(),
  });
  return rec;
}

// 入库/丢弃后兜底：清理"贴了图又删掉、或贴了图但整条没入库"的粘贴图片（全库零引用才删）
export function cleanupOrphanPastes(root) {
  try {
    const orphans = findOrphanedPastes(root);
    if (!orphans.length) return [];
    const deleted = deleteAssets(root, orphans);
    if (deleted.length) {
      gitCommitAndPush(root, `chore: 清理未被引用的粘贴图片 ${deleted.length} 张 [agent]`, {}, deleted);
      console.log(`[wework] 清理孤儿粘贴图片：${deleted.join('、')}`);
    }
    return deleted;
  } catch (e) {
    console.warn(`[wework] 清理孤儿图片失败（不影响主流程）：${e.message}`);
    return [];
  }
}

// 来源块：沉淀文档必须能回溯"这条知识哪来的"，但不写成员姓名与时间（脱敏）
function sourceBlock(cand) {
  return `# 来源\n\n本文由企业微信会话「${cand.sessionName || cand.sessionKey}」中的问答整理，经人工审核后入库。\n`;
}

// 发布：create 走 publish 新建文档；append 走 updateDoc 追加章节
// opts.dryRun=true 时只返回将要写入的内容，不落盘、不提交（前端"预览"用）
export async function publishCandidate(root, cand, opts = {}) {
  const mode = opts.mode === 'append' || opts.mode === 'create' ? opts.mode : (cand.mode || 'create');
  const title = String(opts.title || cand.title || '').trim();
  if (!title) throw new Error('标题不能为空');
  const body = String(opts.content ?? cand.draft ?? '').trim();
  if (!body) throw new Error('正文不能为空，请先起草');
  const who = String(opts.who || '').trim();
  const dryRun = Boolean(opts.dryRun);

  if (mode === 'append') {
    const rel = String(opts.targetPath || cand.targetPath || '').replace(/^\/+/, '');
    if (!rel) throw new Error('补充模式需要指定目标文档');
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) throw new Error(`目标文档不存在: ${rel}`);
    const original = fs.readFileSync(abs, 'utf8');
    const section = /^#\s/m.test(body) ? body : `# ${title}\n\n${body}`;
    let next = `${original.replace(/\s*$/, '')}\n\n${section.replace(/\s*$/, '')}\n`;
    // 补充了内容就刷新 timestamp，否则保鲜机制会把刚更新的文档判为过期
    next = next.replace(/^timestamp:.*$/m, `timestamp: ${today()}`);
    if (dryRun) return { rel, mode: 'append', pushed: false, dryRun: true, preview: next };
    const r = await updateDoc(root, rel, next);
    const rec = upsertCandidate({
      ...cand,
      status: 'merged',
      mode: 'append',
      targetPath: rel,
      title,
      draft: body,
      publishedPath: rel,
      publishedBy: who,
      publishedAt: new Date().toISOString(),
    });
    if (cand.question) resolveGap(cand.question);
    bumpAuthorship('ai');
    const cleaned = cleanupOrphanPastes(root);
    return { ...r, mode: 'append', candidate: rec, cleanedImages: cleaned };
  }

  const domain = DOMAINS.includes(opts.domain) ? opts.domain : (DOMAINS.includes(cand.domain) ? cand.domain : 'guides');
  const tags = (Array.isArray(opts.tags) ? opts.tags : cand.tags || []).map((t) => String(t).trim()).filter(Boolean);
  const frontmatter = {
    title,
    description: String(opts.description ?? cand.description ?? '').trim(),
    tags: [...new Set([...tags, '企微沉淀'])],
    owner: String(opts.owner || who || '').trim(),
    timestamp: today(),
    status: 'ready', // 已经人工审核过，直接可用
    source: 'wework',
  };
  const doc = {
    domain,
    filename: kebab(title),
    frontmatter,
    body: `${body.replace(/\s*$/, '')}\n\n${sourceBlock(cand)}`,
  };
  if (dryRun) {
    const r = await publish(root, doc, { domain, title, owner: frontmatter.owner || undefined }, { dryRun: true });
    return { ...r, mode: 'create', dryRun: true };
  }
  const r = await publish(root, doc, { domain, title, owner: frontmatter.owner || undefined });
  const rec = upsertCandidate({
    ...cand,
    status: 'published',
    mode: 'create',
    domain,
    title,
    description: frontmatter.description,
    tags,
    draft: body,
    publishedPath: r.rel,
    publishedBy: who,
    publishedAt: new Date().toISOString(),
  });
  if (cand.question) resolveGap(cand.question);
  bumpAuthorship('ai');
  const cleaned = cleanupOrphanPastes(root);
  return { ...r, mode: 'create', candidate: rec, cleanedImages: cleaned };
}
