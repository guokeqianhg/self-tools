// 混合检索编排：向量召回 ∪ 关键词召回 → RRF 融合 → bge-reranker 重排 → 按文档分组返回。
// 返回结构与现有关键词检索一致 [{ doc, score, chunks:[{heading,text,score}] }]，供 buildChatMessages/runAgentLoop/docSummary 复用。
// 任一环节不可用（未建索引 / 未装 @xenova/transformers / 模型加载失败）自动退化为纯关键词检索。
import { loadDocs, searchDocs, isAgentReady } from './scan.mjs';
import { vectorRecall } from './vectorSearch.mjs';
import { rerank } from './rerank.mjs';
import { indexExists } from './embed.mjs';

const K_RECALL = 24; // 每路召回的 chunk 候选数（切块变细后 chunk 更多，适当放大召回）
const K_FUSE = 18; // 融合后送重排的候选数（重排是 CPU 瓶颈；给重排更多候选，降低相关块被提前挤掉的概率）
const K_FINAL = 8; // 重排后保留的 chunk 数（再按文档聚合成 topK 篇）
const RRF_K = 60; // RRF 常数

// 关键词召回 → chunk 级候选（保持 searchDocs 的文档序、文档内 chunk 序作为排名）
function kwCandidates(docs, query, topK) {
  const hits = searchDocs(docs, query, topK);
  const out = [];
  for (const h of hits) {
    const chunks = h.chunks && h.chunks.length ? h.chunks : [{ heading: '（开头）', text: h.doc.body.slice(0, 600) }];
    for (const c of chunks) out.push({ doc: h.doc, heading: c.heading, text: c.text, source: 'kw' });
  }
  return out;
}

const keyOf = (c) => `${c.doc.path}|${c.text.trim()}`;

// RRF：按 (docPath+正文) 去重，score=Σ 1/(K+rank)，rank 从 1 起
function rrfFuse(lists, topK) {
  const m = new Map();
  for (const list of lists) {
    list.forEach((item, i) => {
      const key = keyOf(item);
      const add = 1 / (RRF_K + i + 1);
      const prev = m.get(key);
      if (prev) prev.score += add;
      else m.set(key, { ...item, score: add });
    });
  }
  return [...m.values()].sort((a, b) => b.score - a.score).slice(0, topK);
}

export async function hybridRetrieve(root, question, topK = 5) {
  const docs = loadDocs(root).filter(isAgentReady);
  const kw = kwCandidates(docs, question, K_RECALL);

  // 向量召回（失败不致命，退化为关键词）
  let vec = [];
  if (indexExists(root)) {
    try {
      vec = await vectorRecall(root, question, docs, K_RECALL);
    } catch (e) {
      console.warn(`向量召回不可用，退化为关键词检索：${e.message}`);
    }
  }

  const lists = [kw, vec].filter((l) => l.length);
  const fused = rrfFuse(lists, K_FUSE);
  if (!fused.length) return [];

  // 重排（仅当有向量召回时才启用；失败则保留融合序）
  let ranked = fused;
  if (vec.length) {
    try {
      ranked = await rerank(question, fused, Math.max(K_FINAL, topK));
    } catch (e) {
      console.warn(`重排不可用，按融合序返回：${e.message}`);
    }
  }

  // chunk → 按文档聚合回 [{ doc, score, chunks }]
  const byDoc = new Map();
  for (const c of ranked) {
    const g = byDoc.get(c.doc.path);
    if (g) {
      g.chunks.push({ heading: c.heading, text: c.text, score: c.score });
      g.score = Math.max(g.score, c.score);
    } else {
      byDoc.set(c.doc.path, { doc: c.doc, score: c.score, chunks: [{ heading: c.heading, text: c.text, score: c.score }] });
    }
  }
  return [...byDoc.values()]
    .map((g) => ({ ...g, chunks: g.chunks.sort((a, b) => b.score - a.score).slice(0, 3) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
