import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { ChatAttachment } from '../models/types';

export const UPLOADS_DIR = path.join(process.cwd(), 'data', 'uploads');

const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export const MAX_BYTES_PER_FILE = 5 * 1024 * 1024; // 单图 5MB
export const MAX_BYTES_PER_REQUEST = 8 * 1024 * 1024; // 单条 message 总和

function safeIdSegment(id: string): string {
  return id.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 64) || 'misc';
}

export interface SaveImageResult {
  attachment: ChatAttachment;
  absPath: string;
}

export interface SaveImageInput {
  threadId: string;
  base64: string;        // 不含 data: 前缀的纯 base64
  mime: string;
  width?: number;
  height?: number;
  source?: string;
}

export function ensureUploadsDir(): void {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

export function saveImage(input: SaveImageInput): SaveImageResult {
  if (!ALLOWED_MIME.has(input.mime)) {
    throw new Error(`不支持的 mime: ${input.mime}`);
  }
  const buf = Buffer.from(input.base64, 'base64');
  if (!buf.length) throw new Error('图片为空或 base64 无法解析');
  if (buf.length > MAX_BYTES_PER_FILE) {
    throw new Error(`图片过大：${buf.length} bytes > ${MAX_BYTES_PER_FILE}`);
  }

  const ext = MIME_EXT[input.mime];
  const dir = path.join(UPLOADS_DIR, safeIdSegment(input.threadId));
  fs.mkdirSync(dir, { recursive: true });
  const fileBase = `${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
  const absPath = path.join(dir, fileBase);
  fs.writeFileSync(absPath, buf);

  const rel = path.relative(UPLOADS_DIR, absPath).split(path.sep).join('/');
  return {
    attachment: {
      type: 'image',
      path: rel,
      mime: input.mime,
      size: buf.length,
      width: input.width,
      height: input.height,
      source: input.source,
    },
    absPath,
  };
}

export function readImageAsDataUrl(att: ChatAttachment): string | null {
  try {
    const abs = path.join(UPLOADS_DIR, att.path);
    if (!abs.startsWith(UPLOADS_DIR)) return null; // path traversal 防御
    const buf = fs.readFileSync(abs);
    return `data:${att.mime};base64,${buf.toString('base64')}`;
  } catch (e) {
    return null;
  }
}

export function deleteThreadUploads(threadId: string): void {
  try {
    const dir = path.join(UPLOADS_DIR, safeIdSegment(threadId));
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch (e) {
    console.error(`[chat] deleteThreadUploads(${threadId}) failed:`, e);
  }
}

export function deleteAttachmentFiles(attachments: ChatAttachment[] | undefined): void {
  if (!attachments?.length) return;
  for (const att of attachments) {
    try {
      const abs = path.join(UPLOADS_DIR, att.path);
      if (abs.startsWith(UPLOADS_DIR) && fs.existsSync(abs)) fs.unlinkSync(abs);
    } catch (e) {
      console.error('[chat] deleteAttachmentFiles failed for', att.path, e);
    }
  }
}
