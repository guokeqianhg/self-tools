// 从上游归档服务的共享持久盘只读导入企业微信归档记录。
// 上游负责验签、解密、去重与媒体下载；本模块不持有企微凭据，也绝不修改来源目录。
import fs from 'node:fs';
import path from 'node:path';
import { PATHS, upsertSourceMessage, findSourceMessage } from './store.mjs';

const STATE_FILE = path.join(PATHS.DATA, 'admin-source-state.json');
const DEFAULT_POLL_SECONDS = 30;

function isBlank(value) {
  return value == null || String(value).trim() === '';
}

function resolveConfiguredDirectory(value, label) {
  if (isBlank(value)) throw new Error(`${label} 未配置`);
  const configured = String(value).trim();
  if (!path.isAbsolute(configured)) throw new Error(`${label} 必须为绝对路径`);
  const directory = path.resolve(configured);
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    throw new Error(`${label} 不存在或不是目录`);
  }
  return directory;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeState(state) {
  fs.mkdirSync(PATHS.DATA, { recursive: true });
  const temporary = `${STATE_FILE}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(temporary, STATE_FILE);
}

function loadState() {
  const state = readJson(STATE_FILE, null);
  return state && typeof state === 'object' && state.files && typeof state.files === 'object'
    ? state
    : { version: 1, files: {}, lastSyncAt: '', lastResult: null };
}

function listRecordFiles(root) {
  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.json') && !entry.name.includes('.tmp.')) files.push(full);
    }
  };
  walk(root);
  return files.sort();
}

function mediaPath(mediaRoot, localPath) {
  if (isBlank(localPath)) return '';
  const resolved = path.resolve(String(localPath));
  return isWithin(mediaRoot, resolved) ? resolved : '';
}

function toMessage(record, recordPath, mediaRoot) {
  const from = record && record.from && typeof record.from === 'object' ? record.from : {};
  const media = record && record.media && typeof record.media === 'object' ? record.media : null;
  const msgId = String(record && record.msgId || '').trim();
  const recordId = String(record && record.recordId || '').trim();
  const chatId = String(from.id || '').trim();
  if (!recordId || !msgId || !chatId) throw new Error('缺少 recordId、msgId 或 from.id');

  return {
    source: 'wecom-admin-fs',
    sourceRecordId: recordId,
    sourceRecordPath: recordPath,
    msgId,
    type: String(from.type || '').toLowerCase() === 'group' ? 'group' : 'single',
    chatId,
    sender: String(from.sender || (String(from.type || '').toLowerCase() === 'group' ? '' : chatId)).trim(),
    senderCorpId: String(from.senderCorpId || '').trim(),
    msgType: String(record.msgType || '').trim() || 'text',
    content: typeof record.content === 'string' ? record.content : '',
    mediaId: String(media && media.mediaId || '').trim(),
    picUrl: String(media && media.picUrl || '').trim(),
    mentioned: Number(record.mentionedType) || 0,
    createTime: Number(record.createTime) || Math.floor(Date.now() / 1000),
    mediaStatus: String(media && media.status || '').trim(),
    sourceMediaPath: mediaPath(mediaRoot, media && media.localPath),
    mediaMimeType: String(media && media.mimeType || '').trim(),
    mediaSha256: String(media && media.sha256 || '').trim(),
    mediaSize: Number(media && media.size) || 0,
  };
}

export function sourceConfigured() {
  return !isBlank(process.env.WEWORK_SOURCE_RECORD_DIR) && !isBlank(process.env.WEWORK_SOURCE_MEDIA_DIR);
}

export function pollSeconds() {
  return Math.max(5, Number(process.env.WEWORK_SOURCE_POLL_SECONDS) || DEFAULT_POLL_SECONDS);
}

export function sourceStatus() {
  const state = loadState();
  return {
    configured: sourceConfigured(),
    pollSeconds: pollSeconds(),
    lastSyncAt: state.lastSyncAt || '',
    lastResult: state.lastResult || null,
  };
}

export function syncArchive() {
  if (!sourceConfigured()) return { skipped: 'not-configured', imported: 0, updated: 0, skippedFiles: 0, invalid: 0 };

  const recordRoot = resolveConfiguredDirectory(process.env.WEWORK_SOURCE_RECORD_DIR, 'WEWORK_SOURCE_RECORD_DIR');
  const mediaRoot = resolveConfiguredDirectory(process.env.WEWORK_SOURCE_MEDIA_DIR, 'WEWORK_SOURCE_MEDIA_DIR');
  const state = loadState();
  const seen = new Set();
  const result = { imported: 0, updated: 0, skippedFiles: 0, invalid: 0, errors: [] };

  for (const file of listRecordFiles(recordRoot)) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    const fingerprint = `${stat.size}:${stat.mtimeMs}`;
    seen.add(file);
    if (state.files[file] && state.files[file].fingerprint === fingerprint) {
      result.skippedFiles += 1;
      continue;
    }
    try {
      const message = toMessage(readJson(file, null), file, mediaRoot);
      const written = upsertSourceMessage(message);
      result.imported += written.accepted || 0;
      result.updated += written.updated || 0;
      state.files[file] = { fingerprint, recordId: message.sourceRecordId, syncedAt: new Date().toISOString() };
    } catch (error) {
      result.invalid += 1;
      result.errors.push({ file: path.relative(recordRoot, file), error: error.message });
    }
  }

  for (const file of Object.keys(state.files)) {
    if (!seen.has(file)) delete state.files[file];
  }
  state.lastSyncAt = new Date().toISOString();
  state.lastResult = { ...result, errors: result.errors.slice(0, 20) };
  writeState(state);
  return state.lastResult;
}

export function readReadyMedia(recordId) {
  const found = findSourceMessage(recordId);
  if (!found) throw new Error('未找到来源记录');
  const { message } = found;
  if (message.mediaStatus !== 'ready' || isBlank(message.sourceMediaPath)) {
    throw new Error('图片尚未准备完成');
  }
  const mediaRoot = resolveConfiguredDirectory(process.env.WEWORK_SOURCE_MEDIA_DIR, 'WEWORK_SOURCE_MEDIA_DIR');
  const file = path.resolve(message.sourceMediaPath);
  if (!isWithin(mediaRoot, file) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error('图片文件不可用');
  }
  return { file, mimeType: message.mediaMimeType || 'application/octet-stream' };
}
