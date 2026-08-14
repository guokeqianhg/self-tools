// OpenAI 兼容 Chat Completions 客户端。
// 配置来源（优先级：系统环境变量 > 仓库根目录 .env 文件）：
//   LLM_API_KEY / LLM_BASE_URL / LLM_MODEL
// 三项均未内置默认值，避免绑定特定模型服务；未完整配置时自动降级为确定性逻辑。
// .env 文件已被 .gitignore 排除，不会提交进仓库。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 零依赖 .env 解析：KEY=VALUE 每行一条，# 开头为注释
(function loadDotEnv() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const envPath = path.join(root, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    if (!(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

const BASE = (process.env.LLM_BASE_URL || '').replace(/\/+$/, '');
const MODEL = process.env.LLM_MODEL || '';
const KEY = process.env.LLM_API_KEY || '';

export const llmAvailable = () => Boolean(KEY && BASE && MODEL);

const COMPLETIONS_URL = BASE.endsWith('/v1') ? `${BASE}/chat/completions` : `${BASE}/v1/chat/completions`;

export async function chat(messages, { temperature = 0.2 } = {}) {
  if (!KEY) return null;
  const res = await fetch(COMPLETIONS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${KEY}`,
    },
    body: JSON.stringify({ model: MODEL, messages, temperature }),
  });
  if (!res.ok) throw new Error(`LLM 请求失败: HTTP ${res.status} - ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('LLM 返回空响应');
  return content;
}

// 流式版本：async generator，逐段 yield 文本增量（OpenAI SSE 协议）
export async function* chatStream(messages, { temperature = 0.2 } = {}) {
  if (!KEY) return;
  const res = await fetch(COMPLETIONS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${KEY}`,
    },
    body: JSON.stringify({ model: MODEL, messages, temperature, stream: true }),
  });
  if (!res.ok) throw new Error(`LLM 请求失败: HTTP ${res.status} - ${(await res.text()).slice(0, 300)}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        const delta = JSON.parse(payload).choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch { /* 忽略半包/心跳 */ }
    }
  }
}
