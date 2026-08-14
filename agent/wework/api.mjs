// 企微聊天沉淀的 HTTP 接口层，由 serve.mjs 挂载。
// 上游归档服务通过共享持久盘落盘；知识库不提供回调或消息注入接口。
import fs from 'node:fs';
import path from 'node:path';
import {
  stats, listSessions, readSession, loadCandidates, getCandidate,
  candidateMessages, candidateContext, upsertCandidate, prune, RETAIN_DAYS,
} from './store.mjs';
import { readReadyMedia, sourceStatus, syncArchive } from './source.mjs';
import { segmentSession, segmentAll, renderMessage } from './segment.mjs';
import { draftCandidate, publishCandidate, cleanupOrphanPastes } from './distill.mjs';

const withText = (m) => ({ ...m, text: renderMessage(m) });

export async function handleWeworkApi(req, res, u, ctx) {
  const { ROOT, json, readBody, enqueue } = ctx;
  const p = u.pathname;
  if (!p.startsWith('/api/wework/')) return false;

  /* ---- 概览 ---- */
  if (req.method === 'GET' && p === '/api/wework/stats') {
    json(res, 200, stats());
    return true;
  }

  /* ---- 共享归档源：手动触发只读扫描，自动扫描由 serve.mjs 定时执行 ---- */
  if (req.method === 'GET' && p === '/api/wework/source') {
    json(res, 200, sourceStatus());
    return true;
  }
  if (req.method === 'POST' && p === '/api/wework/sync') {
    try {
      json(res, 200, syncArchive());
    } catch (e) {
      json(res, 500, { error: e.message });
    }
    return true;
  }
  if (req.method === 'GET' && p === '/api/wework/media') {
    try {
      const recordId = String(u.searchParams.get('recordId') || '');
      const media = readReadyMedia(recordId);
      res.writeHead(200, {
        'Content-Type': media.mimeType,
        'Cache-Control': 'private, max-age=60',
        'X-Content-Type-Options': 'nosniff',
      });
      fs.createReadStream(media.file).on('error', () => res.destroy()).pipe(res);
    } catch (e) {
      json(res, 404, { error: e.message });
    }
    return true;
  }

  /* ---- 原料浏览 ---- */
  if (req.method === 'GET' && p === '/api/wework/sessions') {
    json(res, 200, { sessions: listSessions() });
    return true;
  }
  if (req.method === 'GET' && p === '/api/wework/messages') {
    const key = String(u.searchParams.get('session') || '');
    if (!key) {
      json(res, 400, { error: 'missing session' });
      return true;
    }
    const limit = Math.min(Number(u.searchParams.get('limit')) || 200, 1000);
    const all = readSession(key);
    json(res, 200, { session: key, total: all.length, messages: all.slice(-limit).map(withText) });
    return true;
  }

  /* ---- 加工：话题分段 → 候选（识别出候选后自动提炼成文档草稿，WEWORK_AUTO_DRAFT=0 关闭） ---- */
  if (req.method === 'POST' && p === '/api/wework/distill') {
    const { session } = await readBody(req);
    try {
      const r = session ? await segmentSession(session) : await segmentAll();
      // 自动提炼：让"整理聊天记录"一步到位，审核人看到的就是可直接入库的草稿
      let drafted = 0;
      const draftErrors = [];
      if (process.env.WEWORK_AUTO_DRAFT !== '0') {
        for (const res1 of r.results || [r]) {
          for (const cand of res1.candidates || []) {
            try {
              await draftCandidate(ROOT, cand);
              drafted += 1;
            } catch (e) {
              draftErrors.push({ id: cand.id, error: e.message });
            }
          }
        }
      }
      json(res, 200, { ...r, drafted, draftErrors });
    } catch (e) {
      json(res, 500, { error: e.message });
    }
    return true;
  }

  /* ---- 候选列表 / 详情 ---- */
  if (req.method === 'GET' && p === '/api/wework/candidates') {
    const status = u.searchParams.get('status') || '';
    const session = u.searchParams.get('session') || '';
    const filter = {};
    if (status) filter.status = status;
    if (session) filter.sessionKey = session;
    const list = loadCandidates(filter).map((c) => ({
      id: c.id,
      title: c.title,
      status: c.status,
      mode: c.mode || '',
      domain: c.domain || '',
      targetPath: c.targetPath || '',
      confidence: c.confidence ?? null,
      sessionKey: c.sessionKey,
      sessionName: c.sessionName || '',
      sessionType: c.sessionType || '',
      participants: c.participants || [],
      asker: c.asker || (c.participants || [])[0] || '',
      seqs: c.seqs || [],
      msgCount: (c.seqs || []).length,
      question: c.question || '',
      reason: c.reason || '',
      claimedBy: c.claimedBy || '',
      publishedPath: c.publishedPath || '',
      createdAt: c.createdAt || '',
      updatedAt: c.updatedAt || '',
    }));
    json(res, 200, { candidates: list });
    return true;
  }
  if (req.method === 'GET' && p === '/api/wework/candidate') {
    const c = getCandidate(String(u.searchParams.get('id') || ''));
    if (!c) {
      json(res, 404, { error: '候选不存在' });
      return true;
    }
    // 已入库的目标文档可能后来在文档库被删掉，前端需要知道才能给出"已被删除/重新入库"而不是 404
    const targetExists = c.publishedPath ? fs.existsSync(path.join(ROOT, c.publishedPath)) : null;
    json(res, 200, {
      candidate: c,
      targetExists,
      messages: candidateMessages(c).map(withText),
      context: candidateContext(c).map((m) => ({ ...withText(m), inSegment: (c.seqs || []).includes(m.seq) })),
    });
    return true;
  }

  /* ---- 恢复：已丢弃 → 回到待审/已提炼（草稿保留，可再次入库） ---- */
  if (req.method === 'POST' && p === '/api/wework/restore') {
    const { id } = await readBody(req);
    const c = getCandidate(String(id || ''));
    if (!c) {
      json(res, 404, { error: '候选不存在' });
      return true;
    }
    // 允许两种恢复：已丢弃反悔；或已入库但目标文档后来被删（此时它实际已不在库里）
    const targetMissing = c.publishedPath && !fs.existsSync(path.join(ROOT, c.publishedPath));
    const allowed = c.status === 'rejected' || ((c.status === 'published' || c.status === 'merged') && targetMissing);
    if (!allowed) {
      json(res, 400, { error: '该候选当前状态不能恢复（仅已丢弃、或已入库但文档已被删除的可以）' });
      return true;
    }
    const rec = upsertCandidate({
      ...c,
      status: c.draft && String(c.draft).trim() ? 'drafted' : 'pending',
      restoredAt: new Date().toISOString(),
    });
    json(res, 200, { ok: true, candidate: rec });
    return true;
  }

  /* ---- 认领（软锁，避免两人同时处理同一条） ---- */
  if (req.method === 'POST' && p === '/api/wework/claim') {
    const { id, who = '' } = await readBody(req);
    const c = getCandidate(String(id || ''));
    if (!c) {
      json(res, 404, { error: '候选不存在' });
      return true;
    }
    const rec = upsertCandidate({ ...c, claimedBy: String(who || '').trim(), claimedAt: new Date().toISOString() });
    json(res, 200, { ok: true, claimedBy: rec.claimedBy });
    return true;
  }

  /* ---- 起草（LLM） ---- */
  if (req.method === 'POST' && p === '/api/wework/draft') {
    const { id } = await readBody(req);
    const c = getCandidate(String(id || ''));
    if (!c) {
      json(res, 404, { error: '候选不存在' });
      return true;
    }
    try {
      json(res, 200, { candidate: await draftCandidate(ROOT, c) });
    } catch (e) {
      json(res, 500, { error: e.message });
    }
    return true;
  }

  /* ---- 发布 / 补充入库（写仓库，走串行队列） ---- */
  if (req.method === 'POST' && p === '/api/wework/publish') {
    const body = await readBody(req);
    const c = getCandidate(String(body.id || ''));
    if (!c) {
      json(res, 404, { error: '候选不存在' });
      return true;
    }
    try {
      const r = await enqueue(() => publishCandidate(ROOT, c, body));
      json(res, 200, r);
    } catch (e) {
      json(res, 500, { error: e.message });
    }
    return true;
  }

  /* ---- 丢弃 ---- */
  if (req.method === 'POST' && p === '/api/wework/reject') {
    const { id, reason = '', who = '' } = await readBody(req);
    const c = getCandidate(String(id || ''));
    if (!c) {
      json(res, 404, { error: '候选不存在' });
      return true;
    }
    const rec = upsertCandidate({
      ...c,
      status: 'rejected',
      rejectReason: String(reason || '').trim(),
      rejectedBy: String(who || '').trim(),
      rejectedAt: new Date().toISOString(),
    });
    // 丢弃后：这条草稿里贴过的图如果全库零引用，一并清掉（方案 A）
    const cleaned = await enqueue(async () => cleanupOrphanPastes(ROOT));
    json(res, 200, { ok: true, candidate: rec, cleanedImages: cleaned });
    return true;
  }

  /* ---- 清理原料（默认保留期，两条硬保护见 store.prune） ---- */
  if (req.method === 'POST' && p === '/api/wework/prune') {
    const { days } = await readBody(req);
    try {
      json(res, 200, prune({ days: Number(days) || RETAIN_DAYS }));
    } catch (e) {
      json(res, 500, { error: e.message });
    }
    return true;
  }

  json(res, 404, { error: 'unknown wework api' });
  return true;
}
