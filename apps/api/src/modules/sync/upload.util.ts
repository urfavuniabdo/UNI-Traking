import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

/** مجلد بيانات المشروع (_data) — قابل للتجاوز بـ SYNC_DATA_DIR */
export const syncDataDir = (): string =>
  process.env.SYNC_DATA_DIR ? path.resolve(process.env.SYNC_DATA_DIR) : path.resolve(process.cwd(), '../../_data');

export const syncUploadsDir = (): string => {
  const dir = path.join(syncDataDir(), 'uploads');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
};

/**
 * اسم ملف آمن — بلا path traversal:
 * basename فقط، حرف/رقم/نقطة/شرطة/underscore فقط، بدون نقاط leading، وامتداد .csv إجباري.
 */
export const sanitizeUploadName = (originalName: string): string => {
  let base = path.basename(String(originalName ?? ''));
  base = base.replace(/[^\w.\-]/g, '_');
  base = base.replace(/\.csv$/i, '').replace(/\.+/g, '_');
  base = base.replace(/^[._]+/, '').replace(/_+/g, '_').slice(0, 64);
  if (!base) base = 'upload';
  return `${Date.now()}-${base}.csv`;
};

/**
 * منع traversal لمسارات filePath من الإعدادات: المسار المطلق مسموح فقط داخل _data،
 * والنسبي يُحل دائمًا داخل _data/uploads.
 */
export const resolveSyncFilePath = (rawPath: string): string => {
  const p = String(rawPath ?? '').trim();
  if (!p) throw new Error('BAD_FILE_PATH: filePath is required for csv sources');
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(syncUploadsDir(), path.basename(p));
  const root = path.resolve(syncDataDir());
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`BAD_FILE_PATH: "${p}" is outside the sync data directory (${root})`);
  }
  return abs;
};
