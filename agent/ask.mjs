// ask：检索相关文档 → 喂给 LLM → 带引用出处的回答。
import { loadDocs, searchDocs, isAgentReady } from './scan.mjs';
import { chat, llmAvailable } from './llm.mjs';
import { hybridRetrieve } from './retrieve.mjs';

const MAX_EXCERPT = 1500;
const MAX_CHUNK_EXCERPT = 2500;

// 检索（chat 与 ask 共用）：混合检索（向量∪关键词→RRF→重排），不可用时自动退化关键词。
export function retrieve(root, question, topK = 5) {
  return hybridRetrieve(root, question, topK);
}

// 指代消解：短追问（"相关的优化链接"）缺乏关键词时，拼接上一轮问题做扩展检索
export function expandQuery(history, question) {
  if (!Array.isArray(history) || !history.length) return question;
  if (question.length >= 30) return question; // 长问题自带上下文，无需扩展
  const lastUser = [...history].reverse().find((m) => m.role === 'user' && m.content);
  if (!lastUser) return question;
  // 避免重复拼接相同内容
  if (question === lastUser.content) return question;
  return `${lastUser.content} ${question}`;
}

// 从文档 # Citations 中提取摘录里实际引用到的脚注链接，一起喂给 LLM
function resolveFootnotes(docBody, excerpt) {
  const ids = [...new Set([...excerpt.matchAll(/\[\^(\d+)\]/g)].map((m) => m[1]))];
  if (!ids.length) return '';
  const citeMatch = docBody.match(/^#\s*Citations\s*$/m);
  if (!citeMatch) return '';
  const citeText = docBody.slice(citeMatch.index);
  const lines = citeText.split('\n').filter((l) => ids.some((id) => l.includes(`[^${id}]`)));
  return lines.length ? lines.join('\n').slice(0, 1200) : '';
}

function formatContext(hits) {
  if (!hits.length) return '（知识库中未检索到相关资料）';
  return hits
    .map(({ doc, chunks }, i) => {
      // 优先喂命中度最高的章节块（长文档的关键），否则退回开头摘录
      const excerpt = chunks && chunks.length
        ? chunks.map((c) => `### ${c.heading}\n${c.text}`).join('\n\n').slice(0, MAX_CHUNK_EXCERPT)
        : doc.body.slice(0, MAX_EXCERPT);
      const links = resolveFootnotes(doc.body, excerpt);
      return `【资料 ${i + 1}】路径: /${doc.path}\n类型: ${doc.type}\n标题: ${doc.title}\n摘要: ${doc.fm.description || ''}\n相关内容:\n${excerpt}${links ? `\n引用链接:\n${links}` : ''}`;
    })
    .join('\n\n---\n\n');
}

const CHAT_SYSTEM = `你是 内部知识库 知识库的智能问答助手，支持多轮对话，并且可以主动使用工具查阅知识库。

【可用工具】
当你需要更多信息才能回答时，输出一个 action 代码块调用工具（每轮最多一个）：
- \`\`\`action\n{"tool":"read_doc","path":"guides/knowledge-base-usage.md"}\n\`\`\` 读取某篇文档的完整内容（路径来自知识库地图或检索结果）
- \`\`\`action\n{"tool":"search_kb","query":"关键词"}\n\`\`\` 在知识库中按关键词检索
- \`\`\`action\n{"tool":"list_docs"}\n\`\`\` 列出知识库全部文档
规则：已掌握足够信息就直接回答，不要调用工具；同一文档不要重复读取；工具结果回来后继续回答。


【你所在的知识库】
内部知识库 是团队内部知识库，按 5 个知识域组织：metrics/ 指标与度量（指标含义与口径）、product/ 系统与工具（官网文档与功能清单）、team/ 组织与协作（成员分工/术语/常用网站/周报/需求）、guides/ 流程指南（SOP/值班/排查记录/报告纪要）、references/ 公开资料（行业文章与资源索引的笔记）。
每次对话给你的【资料 N】就摘自这个知识库中的某篇文档，资料的"路径"即该文档在库中的位置。

【回答规则】
1. 仅依据给定资料与本对话上下文回答，用简体中文，条理清晰；
2. 每个关键结论后用 [/路径] 标注出处；
3. 当用户问"这些出自哪个文档/知识库"、"知识库里有什么"、"某某记录在哪"这类关于知识库本身的问题时：依据【资料】的路径如实回答——它们来自哪篇知识库文档；注意区分"知识库收录的文档"与"文档中引用/整理的外部文章"，后者正文不在库中，但其索引或笔记在库中；
4. 资料不足以回答时，明确说明"知识库暂无相关内容"，不要编造；此时建议提问者：补充文档到知识库，或查阅 已获授权的资料来源；
5. 术语以团队术语表为准，禁止自造词；
6. 资料中若包含与问题相关的图片（markdown 形式：![描述](/assets/…)），在答案对应位置**原样保留该图片链接**——不要只用文字描述，也不要改写或省略路径，前端会把它渲染成图片展示；但不得虚构资料里不存在的图片。`;

// 组装多轮对话消息（system + 知识库地图 + 早期对话摘要 + 最近若干轮历史 + 带检索资料的当前问题）
export function buildChatMessages(hits, history, question, kbMap = '', summary = '') {
  const trimmed = Array.isArray(history) ? history.slice(-16) : [];
  return [
    { role: 'system', content: CHAT_SYSTEM + (kbMap ? `\n\n【知识库现有文档】\n${kbMap}` : '') },
    ...(summary ? [{ role: 'system', content: `【早期对话摘要】（8 轮前的对话已被压缩，供你理解上下文）：\n${summary}` }] : []),
    ...trimmed.filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content),
    { role: 'user', content: `问题：${question}\n\n以下是检索到的资料：\n\n${formatContext(hits)}` },
  ];
}

// 压缩对话历史为摘要（保留关键问题、结论、涉及的文档路径）
export async function summarizeHistory(messages, prevSummary = '') {
  const text = messages
    .filter((m) => m && m.content)
    .map((m) => `${m.role === 'user' ? '用户' : '助手'}: ${String(m.content).slice(0, 800)}`)
    .join('\n');
  return chat([
    {
      role: 'system',
      content: `你是对话摘要器。把用户与知识库助手的对话压缩成一段简洁中文摘要（200 字内），必须保留：讨论过的核心问题、得出的关键结论、涉及的文档路径与术语。${prevSummary ? '已有更早的摘要，请把它与新对话合并为一段连贯摘要。' : ''}只输出摘要正文。`,
    },
    { role: 'user', content: `${prevSummary ? `【已有摘要】\n${prevSummary}\n\n` : ''}【新对话内容】\n${text}` },
  ], { temperature: 0.1 });
}

// 编程接口：返回 { answer, hits }；无结果或无 LLM 时 answer 为 null。
export async function askAnswer(root, question, { topK = 5 } = {}) {
  const hits = await retrieve(root, question, topK);
  if (!hits.length || !llmAvailable()) return { answer: null, hits };
  const answer = await chat(buildChatMessages(hits, [], question));
  return { answer, hits };
}

/* ================= Agent 工具循环 ================= */
import fs from 'node:fs';
import path from 'node:path';

// 解析 LLM 输出中的 action 代码块；返回 null 表示这是最终回答
function parseAction(text) {
  const m = text.match(/```action\s*([\s\S]*?)```/);
  const raw = m ? m[1] : (text.trim().startsWith('{') ? text.trim() : null);
  if (!raw) return null;
  try {
    const a = JSON.parse(raw);
    return a && a.tool ? a : null;
  } catch {
    return null;
  }
}

const DOC_READ_CAP = 6000;

async function execTool(root, action, docs) {
  if (action.tool === 'list_docs') {
    return docs
      .filter((d) => d.type)
      .map((d) => `- /${d.path}（${d.title}）`)
      .join('\n') || '（空库）';
  }
  if (action.tool === 'read_doc') {
    const rel = String(action.path || '').replace(/^\/+/, '');
    const abs = path.join(root, rel);
    if (!rel.endsWith('.md') || rel.includes('..') || !fs.existsSync(abs)) {
      return `文档不存在或不可读: ${action.path}（可用 list_docs 查看现有文档）`;
    }
    return fs.readFileSync(abs, 'utf8').slice(0, DOC_READ_CAP);
  }
  if (action.tool === 'search_kb') {
    // 与首轮检索同口径：混合检索（向量∪关键词→RRF→重排），失败自动退化关键词
    let hits;
    try {
      hits = await hybridRetrieve(root, String(action.query || ''), 5);
    } catch {
      hits = searchDocs(docs, String(action.query || ''), 5);
    }
    if (!hits.length) return '（未检索到相关内容）';
    return hits.map(({ doc, chunks }) => {
      const excerpt = chunks && chunks.length
        ? chunks.map((c) => `  〔${c.heading}〕${c.text.slice(0, 400)}`).join('\n')
        : `  ${doc.body.slice(0, 300)}`;
      return `/ ${doc.path}（${doc.title}）\n${excerpt}`;
    }).join('\n\n');
  }
  return `未知工具: ${action.tool}`;
}

// Agent 主循环：LLM 可反复调用工具（read_doc/search_kb/list_docs），直到给出最终回答
export async function runAgentLoop(root, hits, history, question, kbMap, { maxSteps = 3, onStep, summary = '' } = {}) {
  const docs = loadDocs(root).filter(isAgentReady);
  const messages = buildChatMessages(hits, history, question, kbMap, summary);
  const usedDocs = new Map(hits.map((h) => [h.doc.path, h.doc]));

  for (let step = 0; step < maxSteps; step += 1) {
    const out = await chat(messages, { temperature: 0.15 });
    const action = parseAction(out);
    if (!action) return { answer: out, usedDocs: [...usedDocs.values()] };

    onStep?.(action);
    const result = await execTool(root, action, docs);
    if (action.tool === 'read_doc') {
      const rel = String(action.path || '').replace(/^\/+/, '');
      const d = docs.find((x) => x.path === rel);
      if (d) usedDocs.set(d.path, d);
    }
    messages.push(
      { role: 'assistant', content: out },
      { role: 'user', content: `工具返回：\n${result}\n\n请继续：若信息已足够请直接回答用户的问题；否则可再调用一个工具。` },
    );
  }
  // 步数用尽：强制总结
  const finalOut = await chat([...messages, { role: 'user', content: '请基于已获取的信息，直接给出最终回答。' }], { temperature: 0.15 });
  return { answer: finalOut, usedDocs: [...usedDocs.values()] };
}

// CLI 入口
export async function ask(root, question, opts = {}) {
  const { answer, hits } = await askAnswer(root, question, opts);
  if (!hits.length) {
    console.log('知识库中没有检索到相关内容。');
    return;
  }
  if (!answer) {
    console.warn('未配置 LLM_API_KEY，仅返回检索结果：\n');
    printHits(hits);
    return;
  }
  console.log(answer);
  console.log('\n参考文档：');
  for (const { doc } of hits) console.log(`  - /${doc.path} (${doc.title})`);
}

export function printHits(hits) {
  hits.forEach(({ doc, score }, i) => {
    console.log(`${i + 1}. [${doc.type || 'N/A'}] ${doc.title}  (/${doc.path}, score=${score})`);
    if (doc.fm.description) console.log(`   ${doc.fm.description}`);
  });
}
