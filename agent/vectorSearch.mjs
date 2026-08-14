// 向量召回：embed(query) → 与 .rag/embeddings.jsonl 全部向量做余弦（已归一化，余弦=点积）→ topN。
// 返回 chunk 级候选 [{ doc, heading, text, score, source:'vec' }]，doc 按路径回查（已过滤非 ready/已删）。
import { embed, loadIndex } from './embed.mjs';

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += a[i] * b[i];
  return s;
}

export async function vectorRecall(root, query, docs, topK = 20) {
  const idx = loadIndex(root);
  if (!idx || !idx.entries.length) return [];
  const [qv] = await embed([query], { isQuery: true });
  const byPath = new Map(docs.map((d) => [d.path, d]));
  return idx.entries
    .map((e) => ({ e, score: dot(qv, e.vector) }))
    .sort((a, b) => b.score - a.score)
    .map(({ e, score }) => ({ doc: byPath.get(e.docPath), heading: e.heading, text: e.text, score, source: 'vec' }))
    .filter((c) => c.doc)
    .slice(0, topK);
}
