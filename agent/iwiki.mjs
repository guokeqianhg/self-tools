// 可选 iWiki MCP 客户端（轻量、零依赖）：把获授权文档忠实导入知识库。
// 协议、导入逻辑和附件处理与源项目一致；地址、页面基础地址和只读令牌由部署环境提供。
import fs from 'node:fs';
import path from 'node:path';

const MCP_URL = process.env.IWIKI_MCP_URL || '';
const PAGE_BASE_URL = process.env.IWIKI_PAGE_BASE_URL || '';
const TIMEOUT = 120_000; // 大文档（如说明书，正文+几十张图）读取可能超过 30s

export const iwikiAvailable = () => Boolean(process.env.IWIKI_PAT && MCP_URL && PAGE_BASE_URL);

// 从用户输入析出 docid：支持完整 URL / p/xxxx / 纯数字
export function parseDocid(input) {
  const s = String(input || '').trim();
  const m = s.match(/\/p\/(\d+)/) || s.match(/[?&]docid=(\d+)/) || s.match(/^(\d{6,})$/);
  return m ? m[1] : null;
}

export const iwikiPageUrl = (docid) => `${PAGE_BASE_URL.replace(/\/+$/, '')}/${docid}`;

async function rpc(method, params, id, headers) {
  const resp = await fetch(MCP_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', method, params: params || {}, id }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const sid = resp.headers.get('Mcp-Session-Id');
  if (sid) headers['Mcp-Session-Id'] = sid;
  const ct = resp.headers.get('content-type') || '';
  const text = await resp.text();
  if (ct.includes('text/event-stream')) {
    for (const block of text.split('\n\n')) {
      const line = block.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      const json = JSON.parse(line.slice(6));
      if (json.result !== undefined || json.error) return json;
    }
    return {};
  }
  try { return JSON.parse(text); } catch { throw new Error(`iWiki MCP 返回非 JSON：${text.slice(0, 200)}`); }
}

// 建立会话并调用一个工具，返回其 text 内容
async function callTool(headers, name, args) {
  const r = await rpc('tools/call', { name, arguments: args }, 3, headers);
  if (r.error) throw new Error(`iWiki 工具 ${name} 报错：${r.error.message || JSON.stringify(r.error).slice(0, 300)}`);
  let text = '';
  for (const c of r.result?.content || []) if (c.type === 'text') text += c.text;
  const mcpErr = text.match(/^MCP error -?\d+:\s*([\s\S]*)$/);
  if (mcpErr) throw new Error(`iWiki 工具 ${name} 报错：${mcpErr[1].slice(0, 300)}`);
  return text;
}

async function withSession(fn) {
  const headers = {
    Authorization: `Bearer ${process.env.IWIKI_PAT}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'x-readonly': 'true',
  };
  await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'internal-knowledge-base', version: '0.1' } }, 1, headers);
  await rpc('notifications/initialized', {}, null, headers);
  return fn(headers);
}

export async function iwikiGetDocument(docid) {
  return withSession(async (h) => callTool(h, 'getDocument', { docid }));
}

export async function iwikiMetadata(docid) {
  const text = await withSession(async (h) => callTool(h, 'metadata', { docid }));
  try { return JSON.parse(text); } catch { return {}; }
}

// 列出某页面的直接子页面：[{ docid, title, has_children }]（parentid 必须是数字）
export async function iwikiGetPageTree(parentid) {
  const text = await withSession(async (h) => callTool(h, 'getSpacePageTree', { parentid: Number(parentid) }));
  try {
    const arr = JSON.parse(text);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' };

// attachmentid → 临时下载 URL → 下载字节
async function downloadAttachment(headers, attachmentid) {
  const text = await callTool(headers, 'getAttachmentDownloadUrl', { attachmentid });
  let url = '';
  try { url = JSON.parse(text).url || ''; } catch { url = (text.match(/https?:\/\/[^\s"')]+/) || [''])[0]; }
  if (!url) throw new Error(`附件 ${attachmentid} 未返回下载地址`);
  const resp = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT) });
  if (!resp.ok) throw new Error(`附件 ${attachmentid} 下载失败：HTTP ${resp.status}`);
  const mime = resp.headers.get('content-type') || '';
  const buffer = Buffer.from(await resp.arrayBuffer());
  if (!buffer.length) throw new Error(`附件 ${attachmentid} 内容为空`);
  if (buffer.length > 15 * 1024 * 1024) throw new Error(`附件 ${attachmentid} 超过 15MB`);
  if (!mime.startsWith('image/')) throw new Error(`附件 ${attachmentid} 不是图片（${mime}）`);
  return { buffer, ext: MIME_EXT[mime] || 'png' };
}

// 拉取整篇文档用于导入：
// { docid, title, author, sourceUrl, markdown（图片引用已改写为 /assets/ 本地路径）, images: [已落盘的仓库相对路径] }
// downloadImages=false（dryRun 预览）时保留原始 iwiki 图片链接、不落盘
export async function iwikiFetchForImport(root, input, { downloadImages = true } = {}) {
  const docid = parseDocid(input);
  if (!docid) throw new Error('无法从输入解析 iWiki 文档 ID（支持完整链接 / p/xxxx / 纯数字）');
  const sourceUrl = iwikiPageUrl(docid);

  const headers = {
    Authorization: `Bearer ${process.env.IWIKI_PAT}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'x-readonly': 'true',
  };
  await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'internal-knowledge-base', version: '0.1' } }, 1, headers);
  await rpc('notifications/initialized', {}, null, headers);

  let markdown = await callTool(headers, 'getDocument', { docid });
  if (!markdown.trim()) throw new Error('iWiki 返回的文档内容为空（可能无权限或文档不存在）');

  let title = '';
  let author = '';
  try {
    const meta = JSON.parse(await callTool(headers, 'metadata', { docid }));
    title = String(meta.title || '').trim();
    author = String(meta.content_last_modifier_cn || meta.last_modifier_cn || meta.creator_cn || '').trim();
  } catch { /* 元数据失败不阻断，标题走兜底 */ }
  if (!title) title = (markdown.match(/^#\s+(.+)$/m)?.[1] || '').trim() || `iWiki 文档 ${docid}`;

  // 下载图片附件 → 落盘 assets/ → 改写引用（同一附件去重）
  const images = [];
  if (downloadImages) {
    const refs = [...markdown.matchAll(/!\[[^\]]*\]\(([^)\s]*attachmentid=(\d+)[^)\s]*)\)/g)];
    const byId = new Map();
    for (const [, url, attid] of refs) if (!byId.has(attid)) byId.set(attid, url);
    for (const [attid] of byId) {
      const { buffer, ext } = await downloadAttachment(headers, attid);
      const rel = `assets/iwiki/${docid}/att-${attid}.${ext}`;
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, buffer);
      images.push(rel);
    }
    markdown = markdown.replace(/!\[([^\]]*)\]\(([^)\s]*attachmentid=(\d+)[^)\s]*)\)/g, (all, alt, _url, attid) => {
      const hit = images.find((r) => r.includes(`att-${attid}.`));
      return hit ? `![${alt}](/${hit})` : all;
    });
  }
  return { docid, title, author, sourceUrl, markdown, images };
}
