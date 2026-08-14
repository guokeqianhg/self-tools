// 企微聊天原料与候选的本地存储层（不进 git，见 .gitignore 的 agent/.wework/）。
//
// 目录结构：
//   agent/.wework/sessions/<sessionKey>.jsonl   每个聊天窗口一个文件，按"到达顺序"追加
//   agent/.wework/state.json                    全局 seq 计数器 + 每会话游标/结转/元信息
//   agent/.wework/candidates.jsonl              候选（append-覆盖：同 id 以最后一条为准）
//   agent/.wework/media/                媒体临时区（上游把 MediaId 换成文件后放这里）
//
// 三个关键设计（都是为了增量处理的正确性）：
//   1)游标用"入库序号 seq"，不用时间也不用行号。
//      - 不用时间：企微重试会让消息迟到/乱序，时间游标会静默漏掉迟到消息；
//        按入库序号，迟到消息 seq 更大，一定会被处理到。
//      - 不用行号：30 天清理会重写文件删掉旧行，行号会全部错位；seq 与文件内容无关。
//   2) 会话分文件（不按月切）：同一个人跨天的问答天然连续，清理也不会腰斩话题。
//   3) 结转（carryOver）：批次末尾话题没结束的消息不推进游标，留待下批重新参与分段。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // agent/wework
const DATA = path.join(HERE, '..', '.wework'); // agent/.wework
const SESS_DIR = path.join(DATA, 'sessions');
const MEDIA_DIR = path.join(DATA, 'media');
const STATE_FILE = path.join(DATA, 'state.json');
const CAND_FILE = path.join(DATA, 'candidates.jsonl');

// 原料保留天数（按消息自身发生时间判断；老消息超期即可删）
export const RETAIN_DAYS = Number(process.env.WEWORK_RETAIN_DAYS || 30);

export const PATHS = { DATA, SESS_DIR, MEDIA_DIR, STATE_FILE, CAND_FILE };

// 候选状态机：pending 待审 → drafted 已起草 → published/merged 已入库；rejected 已丢弃
export const CANDIDATE_STATUS = ['pending', 'drafted', 'published', 'merged', 'rejected'];
// 处理中（被人认领）的候选与待审候选一样，其引用的原始消息不允许被清理
const HOLD_STATUS = new Set(['pending', 'drafted']);

export function ensureDirs() {
  for (const d of [DATA, SESS_DIR, MEDIA_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

function readJson(file, dflt) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return dflt;
  }
}

// 原子写：先写临时文件再 rename，避免进程中断留下半个文件
function writeAtomic(file, text) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

/* ================= state（seq 计数器 + 每会话游标） ================= */
// 只读不建目录：govern.mjs 等模块会静态引入本文件做统计，未启用该功能时不应留下空目录
export function loadState() {
  const s = readJson(STATE_FILE, null);
  if (s && typeof s === 'object') {
    s.seq = Number(s.seq) || 0;
    s.sessions = s.sessions && typeof s.sessions === 'object' ? s.sessions : {};
    return s;
  }
  return { seq: 0, sessions: {} };
}

export function saveState(state) {
  ensureDirs();
  writeAtomic(STATE_FILE, JSON.stringify(state, null, 2));
}

// 会话文件名：type + 会话 id（单聊是 userid，群聊是 chatid），非法字符替换为下划线
export function sessionKey(type, chatId) {
  const t = type === 'group' ? 'group' : 'single';
  const id = String(chatId ||'unknown').replace(/[^\w.-]/g, '_') || 'unknown';
  return `${t}-${id}`;
}

const sessionFile = (key) => path.join(SESS_DIR, `${String(key).replace(/[^\w.-]/g, '_')}.jsonl`);

/* ================= 会话消息读写 ================= */
// 读缓存：按 mtime+size 判断失效，避免每次请求都全量解析
const sessCache = new Map();

export function readSession(key) {
  const f = sessionFile(key);
  if (!fs.existsSync(f)) return [];
  const st = fs.statSync(f);
  const hit = sessCache.get(key);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.msgs;
  const msgs = [];
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      msgs.push(JSON.parse(line));
    } catch { /* 跳过坏行，不因单行损坏丢整个会话 */ }
  }
  msgs.sort((a, b) => (a.seq || 0) - (b.seq || 0));
  sessCache.set(key, { mtimeMs: st.mtimeMs, size: st.size, msgs });
  return msgs;
}

export function invalidateSessionCache(key) {
  if (key) sessCache.delete(key);
  else sessCache.clear();
}

// 上游（回调服务）消息 → 存储结构。字段命名对齐企微回调明文，便于对照排查。
function normalize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const type = raw.type === 'group' ? 'group' : 'single';
  const chatId = String(raw.chatId ?? raw.id ?? '').trim();
  const msgId = String(raw.msgId ?? raw.MsgId ?? '').trim();
  if (!chatId || !msgId) return null;
  const msgType = String(raw.msgType || 'text').trim() || 'text';
  const createTime = Number(raw.createTime) || Math.floor(Date.now() / 1000);
  const out = {
    msgId,
    type,
    chatId,
    chatName: String(raw.chatName || '').trim(),
    sender: String(raw.sender || (type === 'single' ? chatId : '')).trim(),
    senderCorpId: String(raw.senderCorpId || '').trim(),
    msgType,
    content: typeof raw.content === 'string' ? raw.content : '',
    mediaId: String(raw.mediaId || '').trim(),
    picUrl: String(raw.picUrl || '').trim(),
    fileName: String(raw.fileName || '').trim(),
    format: String(raw.format || '').trim(),
    mentioned: Number(raw.mentioned) || 0,
    createTime,
    source: String(raw.source || '').trim(),
    sourceRecordId: String(raw.sourceRecordId || '').trim(),
    sourceRecordPath: String(raw.sourceRecordPath || '').trim(),
    sourceMediaPath: String(raw.sourceMediaPath || '').trim(),
    mediaStatus: String(raw.mediaStatus || '').trim(),
    mediaMimeType: String(raw.mediaMimeType || '').trim(),
    mediaSha256: String(raw.mediaSha256 || '').trim(),
    mediaSize: Number(raw.mediaSize) || 0,
  };
  // 转发消息 / 图文混排的子消息列表：原样保留，分段时会展开给模型看
  if (Array.isArray(raw.items) && raw.items.length) {
    out.items = raw.items.map((it) => ({
      sender: String(it.sender || '').trim(),
      time: Number(it.time) || 0,
      msgType: String(it.msgType || 'text').trim(),
      content: typeof it.content === 'string' ? it.content : '',
      mediaId: String(it.mediaId || '').trim(),
      picUrl: String(it.picUrl || '').trim(),
      fileName: String(it.fileName || '').trim(),
    }));
  }
  if (raw.title) out.title = String(raw.title);
  // 已由上游下载到media/ 的文件：[{ file: 'xxx.png', ext: 'png' }]
  if (Array.isArray(raw.media) && raw.media.length) {
    out.media = raw.media
      .map((m) => (typeof m === 'string' ? { file: path.basename(m) } : { file: path.basename(String(m.file || '')), ext: String(m.ext || '') }))
      .filter((m) => m.file);
  }
  return out;
}

// 消息入库（幂等）：按 MsgId 去重，分配全局递增 seq
export function ingest(messages = []) {
  ensureDirs();
  const state = loadState();
  let accepted = 0;
  let duplicated = 0;
  let invalid = 0;
  const touched = new Set();

  // 先按会话分组，避免逐条重复读会话文件
  const groups = new Map();
  for (const raw of Array.isArray(messages) ? messages : [messages]) {
    const m = normalize(raw);
    if (!m) {
      invalid += 1;
      continue;
    }
    const key = sessionKey(m.type, m.chatId);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }

  for (const [key, list] of groups) {
    const existing = new Set(readSession(key).map((x) => x.msgId));
    const lines = [];
    for (const m of list) {
      if (existing.has(m.msgId)) {
        duplicated += 1;
        continue;
      }
      existing.add(m.msgId);
      state.seq += 1;
      lines.push(JSON.stringify({ seq: state.seq, ...m, ingestAt: new Date().toISOString() }));
      accepted += 1;
    }
    if (!lines.length) continue;
    fs.appendFileSync(sessionFile(key), `${lines.join('\n')}\n`, 'utf8');
    invalidateSessionCache(key);
    const s = state.sessions[key] || (state.sessions[key] = { type: list[0].type, chatId: list[0].chatId, cursor: 0, carryOver: [] });
    const named = list.find((x) => x.chatName);
    if (named) s.name = named.chatName;
    s.lastActive = new Date().toISOString();
    s.lastSeq = state.seq;
    touched.add(key);
  }

  saveState(state);
  return { accepted, duplicated, invalid, sessions: [...touched] };
}

// 共享归档源按 recordId（兼容旧数据时退化为 MsgId）更新同一条本地会话消息；
// 不改变 seq，避免媒体状态就绪后被当作一条新聊天消息再次分段。
export function upsertSourceMessage(raw) {
  const message = normalize(raw);
  if (!message || !message.sourceRecordId) return { accepted: 0, updated: 0, invalid: 1, sessions: [] };
  ensureDirs();
  const key = sessionKey(message.type, message.chatId);
  const messages = readSession(key);
  const index = messages.findIndex((item) => item.sourceRecordId === message.sourceRecordId || item.msgId === message.msgId);
  const now = new Date().toISOString();

  if (index >= 0) {
    const previous = messages[index];
    const next = { ...previous, ...message, seq: previous.seq, ingestAt: previous.ingestAt, sourceUpdatedAt: now };
    if (JSON.stringify(previous) !== JSON.stringify(next)) {
      messages[index] = next;
      writeAtomic(sessionFile(key), `${messages.map((item) => JSON.stringify(item)).join('\n')}\n`);
      invalidateSessionCache(key);
      return { accepted: 0, updated: 1, invalid: 0, sessions: [key] };
    }
    return { accepted: 0, updated: 0, invalid: 0, sessions: [key] };
  }

  const result = ingest(message);
  return { ...result, updated: 0 };
}

export function findSourceMessage(recordId) {
  const wanted = String(recordId || '').trim();
  if (!wanted) return null;
  for (const key of Object.keys(loadState().sessions)) {
    const message = readSession(key).find((item) => item.sourceRecordId === wanted);
    if (message) return { key, message };
  }
  return null;
}

/* ================= 游标 / 未处理消息 ================= */
export function getSessionState(key, state = loadState()) {
  const s = state.sessions[key] || {};
  return { cursor: Number(s.cursor) || 0, carryOver: Array.isArray(s.carryOver) ? s.carryOver : [], type: s.type, chatId: s.chatId, name: s.name || '', lastActive: s.lastActive || '' };
}

// 未处理 = seq 大于游标，或上一轮标记为"话题未结束"被结转回来的
export function pendingMessages(key, state = loadState()) {
  const { cursor, carryOver } = getSessionState(key, state);
  const carry = new Set(carryOver);
  return readSession(key).filter((m) => m.seq > cursor || carry.has(m.seq));
}

export function setCursor(key, cursor, carryOver = []) {
  const state = loadState();
  const s = state.sessions[key] || (state.sessions[key] = { cursor: 0, carryOver: [] });
  s.cursor = Number(cursor) || 0;
  s.carryOver = [...new Set(carryOver.map((x) => Number(x)).filter(Boolean))].sort((a, b) => a - b);
  saveState(state);
  return { cursor: s.cursor, carryOver: s.carryOver };
}

export function listSessions() {
  const state = loadState();
  return Object.keys(state.sessions)
    .map((key) => {
      const s = getSessionState(key, state);
      const msgs = readSession(key);
      const carry = new Set(s.carryOver);
      return {
        key,
        type: s.type || (key.startsWith('group-') ? 'group' : 'single'),
        chatId: s.chatId || '',
        name: s.name || '',
        count: msgs.length,
        pending: msgs.filter((m) => m.seq > s.cursor || carry.has(m.seq)).length,
        cursor: s.cursor,
        lastActive: s.lastActive,
      };
    })
    .sort((a, b) => String(b.lastActive).localeCompare(String(a.lastActive)));
}

/* ================= 候选（append-覆盖状态机） ================= */
export const newCandidateId = () => randomUUID().slice(0, 8);

export function upsertCandidate(c) {
  ensureDirs();
  const rec = { ...c, updatedAt: new Date().toISOString() };
  fs.appendFileSync(CAND_FILE, `${JSON.stringify(rec)}\n`, 'utf8');
  return rec;
}

// 读取全部候选：同 id 以最后一条为准（这样"更新状态"也只是追加，并发写不丢数）
export function loadCandidates({ status, sessionKey: sk } = {}) {
  if (!fs.existsSync(CAND_FILE)) return [];
  const byId = new Map();
  for (const line of fs.readFileSync(CAND_FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && r.id) byId.set(r.id, { ...(byId.get(r.id) || {}), ...r });
    } catch { /* 跳过坏行 */ }
  }
  let out = [...byId.values()];
  if (status) {
    const want = new Set(String(status).split(',').map((s) => s.trim()).filter(Boolean));
    out = out.filter((c) => want.has(c.status));
  }
  if (sk) out = out.filter((c) => c.sessionKey === sk);
  return out.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

export const getCandidate = (id) => loadCandidates().find((c) => c.id === id) || null;

// 候选引用的原始消息（供审核时查看上下文）
export function candidateMessages(c) {
  if (!c || !c.sessionKey) return [];
  const want = new Set(c.seqs || []);
  return readSession(c.sessionKey).filter((m) => want.has(m.seq));
}

// 候选前后的上下文消息（审核人需要看到"这段话前后在聊什么"）
export function candidateContext(c, around = 8) {
  if (!c || !c.sessionKey) return [];
  const msgs = readSession(c.sessionKey);
  const seqs = (c.seqs || []).slice().sort((a, b) => a - b);
  if (!seqs.length) return [];
  const lo = seqs[0];
  const hi = seqs[seqs.length - 1];
  const before = msgs.filter((m) => m.seq < lo).slice(-around);
  const inside = msgs.filter((m) => m.seq >= lo && m.seq <= hi);
  const after = msgs.filter((m) => m.seq > hi).slice(0, around);
  return [...before, ...inside, ...after];
}

/* ================= 清理（保留期 + 两条硬保护） ================= */
// 删除超期的老消息，但两类消息永不删：
//   1) 未处理的（seq > cursor 或在结转里）——超期只说明加工没跑，删了就是永久丢失，改为告警
//   2) 被待审/已起草候选引用的——否则审核时看不到原始对话，无法判断答案对不对
export function prune({ days = RETAIN_DAYS } = {}) {
  ensureDirs();
  const cutoff = Math.floor(Date.now() / 1000) - Number(days) * 86400;
  const state = loadState();
  const held = new Set();
  for (const c of loadCandidates()) {
    if (!HOLD_STATUS.has(c.status)) continue;
    for (const s of c.seqs || []) held.add(`${c.sessionKey}#${s}`);
  }

  let removed = 0;
  let overdueUnprocessed = 0;
  let keptByCandidate = 0;
  const keepMedia = new Set();

  for (const key of Object.keys(state.sessions)) {
    const { cursor, carryOver } = getSessionState(key, state);
    const carry = new Set(carryOver);
    const msgs = readSession(key);
    const kept = [];
    for (const m of msgs) {
      const isOld = Number(m.createTime || 0) < cutoff;
      const unprocessed = m.seq > cursor || carry.has(m.seq);
      const isHeld = held.has(`${key}#${m.seq}`);
      if (isOld && unprocessed) overdueUnprocessed += 1;
      if (!isOld || unprocessed || isHeld) {
        kept.push(m);
        if (isOld && isHeld && !unprocessed) keptByCandidate += 1;
      } else {
        removed += 1;
      }
    }
    if (kept.length !== msgs.length) {
      writeAtomic(sessionFile(key), kept.map((m) => JSON.stringify(m)).join('\n') + (kept.length ? '\n' : ''));
      invalidateSessionCache(key);
    }
    for (const m of kept) for (const md of m.media || []) keepMedia.add(md.file);
  }

  // 媒体临时区：不再被任何保留消息引用的文件一并清掉
  let mediaRemoved = 0;
  if (fs.existsSync(MEDIA_DIR)) {
    for (const f of fs.readdirSync(MEDIA_DIR)) {
      if (keepMedia.has(f)) continue;
      try {
        fs.rmSync(path.join(MEDIA_DIR, f));
        mediaRemoved += 1;
      } catch { /* 忽略 */ }
    }
  }
  return { days: Number(days), removed, overdueUnprocessed, keptByCandidate, mediaRemoved };
}

/* ================= 概览 ================= */
function dirBytes(dir) {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) n += dirBytes(full);
    else {
      try {
        n += fs.statSync(full).size;
      } catch { /* 忽略 */ }
    }
  }
  return n;
}

export function stats() {
  const sessions = listSessions();
  const cands = loadCandidates();
  const byStatus = {};
  for (const s of CANDIDATE_STATUS) byStatus[s] = 0;
  for (const c of cands) byStatus[c.status] = (byStatus[c.status] || 0) + 1;

  // 超期未处理：原料保留期已过但还没加工过，删不得也留不久，必须让人看见
  const cutoff = Math.floor(Date.now() / 1000) - RETAIN_DAYS * 86400;
  const state = loadState();
  let overdueUnprocessed = 0;
  for (const key of Object.keys(state.sessions)) {
    const { cursor, carryOver } = getSessionState(key, state);
    const carry = new Set(carryOver);
    for (const m of readSession(key)) {
      if ((m.seq > cursor || carry.has(m.seq)) && Number(m.createTime || 0) < cutoff) overdueUnprocessed += 1;
    }
  }

  return {
    sessions: sessions.length,
    messages: sessions.reduce((n, s) => n + s.count, 0),
    unprocessed: sessions.reduce((n, s) => n + s.pending, 0),
    candidates: byStatus,
    candidateTotal: cands.length,
    published: cands.filter((c) => c.status === 'published' || c.status === 'merged').length,
    diskBytes: dirBytes(DATA),
    retainDays: RETAIN_DAYS,
    overdueUnprocessed,
    seq: state.seq,
  };
}
