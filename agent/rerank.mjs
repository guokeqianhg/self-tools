// 重排（精排）：bge-reranker-v2-m3 cross-encoder，对 (query, 候选段) 逐对打相关性分，取 topK。
// 直接用 AutoTokenizer + AutoModelForSequenceClassification 取原始 logit（越大越相关）。
// 注意：不能用 text-classification pipeline——num_labels=1 时它做单类 softmax 恒为 1，分数失效。
// 输入候选需带 text 字段；依赖缺失抛错由调用方 catch 退化。
import { RERANKER_MODEL } from './embed.mjs';

let _model = null;
let _tokenizer = null;
let _loadErr = null;
async function ensureReranker() {
  if (_model || _loadErr) return { ok: Boolean(_model), err: _loadErr };
  try {
    const { AutoModelForSequenceClassification, AutoTokenizer } = await import('@xenova/transformers');
    [_tokenizer, _model] = await Promise.all([
      AutoTokenizer.from_pretrained(RERANKER_MODEL),
      AutoModelForSequenceClassification.from_pretrained(RERANKER_MODEL, { quantized: true }),
    ]);
  } catch (e) {
    _loadErr = e;
  }
  return { ok: Boolean(_model), err: _loadErr };
}

// 序列截断：CPU 推理耗时随序列长度平方增长；实测 256 token 截断 top3 排序不变、耗时减半以上。
const MAX_LENGTH = Number(process.env.RERANK_MAX_LENGTH || 256);

export async function rerank(query, candidates, topK = 6) {
  const { ok, err } = await ensureReranker();
  if (!ok) throw err;
  if (!candidates.length) return [];
  const BATCH = 8;
  const scored = [];
  // 按正文长度排序再分批：padding 补齐到批内最长，长短混批会让短文本白算长序列
  const byLen = [...candidates].sort((a, b) => a.text.length - b.text.length);
  for (let i = 0; i < byLen.length; i += BATCH) {
    const slice = byLen.slice(i, i + BATCH);
    const inputs = await _tokenizer(slice.map(() => query), {
      text_pair: slice.map((c) => c.text),
      padding: true,
      truncation: true,
      max_length: MAX_LENGTH,
    });
    const { logits } = await _model(inputs); // [batch, 1]，num_labels=1 → 原始相关性 logit
    const scores = Array.from(logits.data);
    slice.forEach((c, j) => scored.push({ ...c, score: scores[j] ?? 0 }));
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, topK);
}
