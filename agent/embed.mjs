// 语义 RAG · Embedding 与向量索引（本地 bge，离线、零 API、合规）。
// - 模型：Xenova/bge-base-zh-v1.5（dim=768），经 @xenova/transformers 纯 Node 运行（WASM/ONNX）。
// - 索引：.rag/embeddings.jsonl（每行一条 chunk 向量）+ .rag/meta.json（模型/维度/计数）。
// - 增量：按 chunk 正文的 sha256 判断变更，只 embed 改动/新增的块，删除消失的块。
// - 依赖缺失（未 npm i @xenova/transformers）时，所有函数抛错，调用方需 catch 退化为关键词检索。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadDocs, splitChunks, isAgentReady } from './scan.mjs';

export const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'Xenova/bge-base-zh-v1.5';
export const RERANKER_MODEL = process.env.RERANKER_MODEL || 'onnx-community/bge-reranker-v2-m3-ONNX';

const RAG_DIR = '.rag';
// bge 检索建议：仅 query 侧加指令前缀，passage 侧不加。
const QUERY_PREFIX = '为这个句子生成表示以用于检索相关文章：';

function ragPaths(root) {
  return {
    dir: path.join(root, RAG_DIR),
    index: path.join(root, RAG_DIR, 'embeddings.jsonl'),
    meta: path.join(root, RAG_DIR, 'meta.json'),
  };
}

// ---- 模型懒加载（缓存；失败也缓存，避免每次重建抛错）----
let _extractor = null;
let _extractorErr = null;
async function ensureExtractor() {
  if (_extractor || _extractorErr) return { extractor: _extractor, err: _extractorErr };
  try {
    const { pipeline } = await import('@xenova/transformers');
    _extractor = await pipeline('feature-extraction', EMBEDDING_MODEL);
  } catch (e) {
    _extractorErr = e;
  }
  return { extractor: _extractor, err: _extractorErr };
}

// 把若干文本转向量（number[][]）。isQuery=true 时加 bge query 指令前缀。
export async function embed(texts, { isQuery = false } = {}) {
  const { extractor, err } = await ensureExtractor();
  if (err) throw err;
  const list = (Array.isArray(texts) ? texts : [texts]).map(String);
  if (!list.length) return [];
  const inp = isQuery ? list.map((t) => QUERY_PREFIX + t) : list;
  const out = await extractor(inp, { pooling: 'cls', normalize: true });
  const data = Array.from(out.data);
  const n = out.dims.length === 2 ? out.dims[0] : 1;
  const dim = out.dims[out.dims.length - 1];
  const vectors = [];
  for (let i = 0; i < n; i += 1) vectors.push(data.slice(i * dim, (i + 1) * dim));
  return vectors;
}

// 读取索引；不存在返回 null。
export function loadIndex(root) {
  const { index, meta } = ragPaths(root);
  if (!fs.existsSync(index)) return null;
  const entries = fs
    .readFileSync(index, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const m = fs.existsSync(meta) ? JSON.parse(fs.readFileSync(meta, 'utf8')) : {};
  return { entries, meta: m };
}

// 索引是否可用（供查询侧快速判断，避免无谓 embed）。
export const indexExists = (root) => fs.existsSync(ragPaths(root).index);

const hashText = (t) => crypto.createHash('sha256').update(t).digest('hex').slice(0, 16);

// 增量重建索引。full=true 强制全量；模型变更自动全量。返回 { total, embedded }。
export async function reindex(root, { full = false } = {}) {
  const docs = loadDocs(root).filter(isAgentReady);
  const prior = (!full && loadIndex(root)) || { entries: [], meta: {} };
  // 模型版本变化 → 旧向量全部作废（唯一破坏增量的点，锁死版本即可避免）
  if (!full && prior.meta?.model && prior.meta.model !== EMBEDDING_MODEL) {
    prior.entries = [];
  }
  // 复用按"正文 hash"，对 chunk 位置移动也稳健（同文同向量）
  const priorByHash = new Map(prior.entries.map((e) => [e.hash, e]));

  const newEntries = [];
  const toEmbed = [];
  for (const d of docs) {
    splitChunks(d.body).forEach((c, i) => {
      const hash = hashText(c.text);
      const base = { id: `${d.path}#${i}`, docPath: d.path, chunkIndex: i, heading: c.heading, text: c.text, hash };
      const old = priorByHash.get(hash);
      if (old && Array.isArray(old.vector)) {
        newEntries.push({ ...base, vector: old.vector });
      } else {
        toEmbed.push(base);
      }
    });
  }

  if (toEmbed.length) {
    const BATCH = 16;
    for (let i = 0; i < toEmbed.length; i += BATCH) {
      const slice = toEmbed.slice(i, i + BATCH);
      const vectors = await embed(slice.map((s) => s.text));
      slice.forEach((s, j) => newEntries.push({ ...s, vector: vectors[j] }));
    }
  }

  const { dir, index, meta } = ragPaths(root);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(index, newEntries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  fs.writeFileSync(
    meta,
    JSON.stringify(
      {
        model: EMBEDDING_MODEL,
        dim: newEntries[0]?.vector?.length || 768,
        reranker: RERANKER_MODEL,
        count: newEntries.length,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    'utf8',
  );
  return { total: newEntries.length, embedded: toEmbed.length };
}
