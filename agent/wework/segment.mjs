// 话题分段：把会话里"未处理"的消息整体交给模型，由它判断这里面有几个问答、边界在哪。
//
// 为什么不用固定时间窗切分：真实聊天可能隔半小时继续同一话题，也可能一分钟内切三个话题，
// 任何固定阈值都会切错。识别话题边界正是模型擅长的事，时间只作为它的参考信号（消息带时间戳）。
//
// 三个机制保证增量处理的正确性：
//   - 只处理 seq > cursor 的消息（含上轮结转），永不重复加工
//   - 只读背景：附带游标之前最近若干条，供模型理解"追问/指代"，但不允许在背景里产出候选
//   - 未闭合结转：批次末尾话题还没结束的消息不推进游标，留给下一批重新参与分段
//
// 没有配置 LLM 时不做任何猜测式切分——宁可不产出，也不用假规则往知识库里灌东西。
import { chat, llmAvailable } from '../llm.mjs';
import {
  readSession, pendingMessages, getSessionState, setCursor, listSessions,
  loadCandidates, upsertCandidate, newCandidateId, loadState,
} from './store.mjs';

// 单批送入模型的消息条数上限（一个大群的全部消息一次塞进去会撑爆上下文）
const BATCH = Number(process.env.WEWORK_BATCH || 120);
// 只读背景条数
const BACKGROUND = Number(process.env.WEWORK_BACKGROUND || 15);
// 单次加工最多跑几批，避免一次请求跑太久
const MAX_BATCHES = Number(process.env.WEWORK_MAX_BATCHES || 20);

function extractJson(text) {
  const block = String(text).match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = block ? block[1] : String(text).slice(String(text).indexOf('{'), String(text).lastIndexOf('}') + 1);
  return JSON.parse(raw);
}

const hhmm = (sec) => {
  const d = new Date((Number(sec) || 0) * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

// 一条消息渲染成模型可读的一行；非文本类型给出占位，转发/图文混排展开子消息
export function renderMessage(m) {
  const who = m.sender || (m.type === 'single' ? m.chatId : '未知');
  let body;
  switch (m.msgType) {
    case 'text':
      body = m.content || '';
      break;
    case 'image':
      body = '[图片]';
      break;
    case 'file':
      body = `[文件${m.fileName ? ` ${m.fileName}` : ''}]`;
      break;
    case 'voice':
      body = '[语音]';
      break;
    case 'emotion':
      body = '[表情]';
      break;
    case 'mixed':
    case 'forward': {
      const items = (m.items || []).map((it) => {
        const t = it.msgType === 'text' ? it.content : `[${it.msgType}]`;
        return `    · ${it.sender || ''}${it.sender ? '：' : ''}${t}`;
      });
      const head = m.msgType === 'forward' ? `[转发记录${m.title ? `：${m.title}` : ''}]` : '[图文混排]';
      body = items.length ? `${head}\n${items.join('\n')}` : head;
      break;
    }
    default:
      body = m.content || `[${m.msgType}]`;
  }
  return `[#${m.seq}] ${hhmm(m.createTime)} ${who}：${body}`;
}

// 最粗的本地初筛：纯表情、单字应答这类不可能承载知识的消息。
// 只用于判断"这批是不是全是噪音"（全是就直接推进游标、省一次模型调用），不参与切分决策。
const TRIVIAL_TEXT = /^[\s。，,.!！?？~、]*(好|好的|收到|谢谢|多谢|感谢|ok|OK|嗯|哦|是|对|在|👌|👍)[\s。，,.!！?？~、]*$/;
function isTrivial(m) {
  if (m.msgType === 'emotion') return true;
  if (m.msgType !== 'text') return false;
  const t = String(m.content || '').trim();
  return !t || t.length <= 2 || TRIVIAL_TEXT.test(t);
}

const SYSTEM = `你是团队知识库的运营助手，负责从企业微信聊天记录里识别"值得沉淀成知识文档的技术问答"。

判断标准：
- 有价值：有人提出具体的技术问题，并且对话里给出了可复用的答案、结论或做法。
- 无价值：闲聊、寒暄、纯附和、任务协调、通知播报、答案缺失或仅"我看看/稍等"。

严格遵守：
1. 只能在【待分析消息】范围内划分问答段落，【背景消息】仅供你理解上下文，不得作为段落成员。
2. 一段问答可能由多人接力回答，也可能跨越较长时间，按语义判断边界，不要按时间硬切。
3. 若【待分析消息】末尾的讨论还没结束（问题刚提出、答案还没出现），把这些消息编号放进 openTail，留待下次分析，不要勉强成段。
4. 只输出有价值的段落；无价值的消息直接忽略，不要列出。
5. 如果这段问答与【已沉淀文档】中的某篇明显是同一主题（例如后续补充、纠正），把该文档路径填进 relatedDoc。

只输出 JSON，不要任何解释文字：
{
  "segments": [
    {
      "seqs": [消息编号数组，按时间升序],
      "title": "该问答的知识点标题（不超过 30 字）",
      "question": "把提问归纳成一句完整的问题",
      "answer": "把对话里的答案归纳成结论（保留关键数值、命令、路径）",
      "confidence": 0.0到 1.0 的把握程度,
      "relatedDoc": "已沉淀文档路径或 null",
      "reason": "为什么值得沉淀（一句话）"
    }
  ],
  "openTail": [尚未结束的消息编号数组]
}`;

// 该会话此前已沉淀出去的文档，作为"这可能是延续/补充"的提示给模型
function publishedDocsOf(sessionKey) {
  return loadCandidates({ sessionKey })
    .filter((c) => (c.status === 'published' || c.status === 'merged') && c.publishedPath)
    .map((c) => `- /${c.publishedPath}（${c.title || ''}）`)
    .slice(0, 20);
}

function buildPrompt(sessionInfo, background, batch, publishedDocs) {
  const L = [];
  L.push(`【会话】${sessionInfo.type === 'group' ? '群聊' : '单聊'}：${sessionInfo.name || sessionInfo.chatId || sessionInfo.key}`);
  if (publishedDocs.length) {
    L.push('', '【已沉淀文档】', ...publishedDocs);
  }
  if (background.length) {
    L.push('', '【背景消息】（仅供理解，不得作为段落成员）', ...background.map(renderMessage));
  }
  L.push('', '【待分析消息】', ...batch.map(renderMessage));
  return L.join('\n');
}

// 对一个会话做增量分段：返回本轮生成的候选与游标变化
export async function segmentSession(key, { batchSize = BATCH, maxBatches = MAX_BATCHES } = {}) {
  const state = loadState();
  const info = { key, ...getSessionState(key, state) };
  const all = readSession(key);
  let pending = pendingMessages(key, state);
  if (!pending.length) return { key, skipped: 'empty', created: 0, batches: 0 };

  // 整批都是"好的/收到/表情"这类消息：没有调用模型的必要，直接推进游标
  if (pending.every(isTrivial)) {
    const maxSeq = Math.max(...pending.map((m) => m.seq));
    setCursor(key, Math.max(info.cursor, maxSeq), []);
    return { key, skipped: 'trivial', created: 0, batches: 0, cursor: Math.max(info.cursor, maxSeq) };
  }

  if (!llmAvailable()) return { key, skipped: 'no-llm', created: 0, batches: 0 };

  const publishedDocs = publishedDocsOf(key);
  const created = [];
  let batches = 0;
  let cursor = info.cursor;
  let carryOver = [];

  for (let i = 0; i < maxBatches; i += 1) {
    if (!pending.length) break;
    const batch = pending.slice(0, batchSize);
    const firstSeq = batch[0].seq;
    const background = all.filter((m) => m.seq < firstSeq).slice(-BACKGROUND);

    let parsed;
    try {
      const out = await chat(
        [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: buildPrompt(info, background, batch, publishedDocs) },
        ],
        { temperature: 0.1 },
      );
      parsed = extractJson(out);
    } catch (e) {
      // 单批失败不推进游标：这批消息下次还会被重新分析，不会丢
      return { key, created: created.length, candidates: created, batches, error: e.message, cursor };
    }
    batches += 1;

    const inBatch = new Set(batch.map((m) => m.seq));
    const openTail = (Array.isArray(parsed.openTail) ? parsed.openTail : [])
      .map((n) => Number(n))
      .filter((n) => inBatch.has(n));

    for (const seg of Array.isArray(parsed.segments) ? parsed.segments : []) {
      const seqs = (Array.isArray(seg.seqs) ? seg.seqs : []).map((n) => Number(n)).filter((n) => inBatch.has(n)).sort((a, b) => a - b);
      if (!seqs.length || !String(seg.title || '').trim()) continue;
      const segMsgs = batch.filter((m) => seqs.includes(m.seq));
      const rec = upsertCandidate({
        id: newCandidateId(),
        sessionKey: key,
        sessionName: info.name || info.chatId || key,
        sessionType: info.type,
        seqs,
        asker: (segMsgs.find((m) => m.sender) || {}).sender || '', // 提问人：段落里第一个发言的人
        title: String(seg.title).trim().slice(0, 60),
        question: String(seg.question || '').trim(),
        answer: String(seg.answer || '').trim(),
        confidence: Math.max(0, Math.min(1, Number(seg.confidence) || 0)),
        relatedDoc: seg.relatedDoc ? String(seg.relatedDoc).replace(/^\/+/, '') : '',
        reason: String(seg.reason || '').trim(),
        participants: [...new Set(segMsgs.map((m) => m.sender).filter(Boolean))],
        status: 'pending',
        createdAt: new Date().toISOString(),
      });
      created.push(rec);
    }

    // 游标只推进到"已闭合"的位置：openTail 里的消息留待下批重新分析
    const closed = batch.map((m) => m.seq).filter((s) => !openTail.includes(s));
    if (closed.length) cursor = Math.max(cursor, Math.max(...closed));
    carryOver = openTail;
    setCursor(key, cursor, carryOver);

    // 下一批：去掉本批已闭合的
    pending = pending.filter((m) => !inBatch.has(m.seq) || openTail.includes(m.seq));
    // 结转的消息若已是最后一批，避免死循环：本轮不再重复处理它们
    if (pending.length && pending.every((m) => openTail.includes(m.seq))) break;
  }

  return { key, created: created.length, candidates: created, batches, cursor, carryOver };
}

// 全量加工：对所有有未处理消息的会话依次分段
export async function segmentAll(opts = {}) {
  const results = [];
  for (const s of listSessions()) {
    if (!s.pending) continue;
    results.push(await segmentSession(s.key, opts));
  }
  return {
    sessions: results.length,
    created: results.reduce((n, r) => n + (r.created || 0), 0),
    results,
  };
}
