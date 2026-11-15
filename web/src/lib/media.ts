import sharp from 'sharp';
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { dataDir, get, newId, run, type Db } from './db';
import { AppError, forbidden, notFound } from './validation';

export const MAX_UPLOAD_BYTES = 6 * 1024 * 1024;
export const MAX_PIXELS = 40_000_000; // guards against decompression bombs
const PREVIEW_MAX_EDGE = 1600;
const AVATAR_EDGE = 256;

export interface ProcessedImage {
  data: Buffer;
  mime: 'image/webp';
  width: number;
  height: number;
}

/** Identifies the real format from magic bytes; the filename and declared type are never trusted. */
export function sniffImage(buf: Buffer): 'png' | 'jpeg' | 'webp' | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null; // includes SVG, GIF, PDF, HTML, executables...
}

/**
 * Validates and RE-ENCODES an uploaded raster image: always decoded and written fresh as WebP, which
 * drops EXIF/location/other metadata and any payload hidden in the original file. SVG is not accepted.
 */
export async function processImage(input: Buffer, kind: 'preview' | 'avatar'): Promise<ProcessedImage> {
  if (input.length === 0) throw new AppError(400, 'That file is empty.');
  if (input.length > MAX_UPLOAD_BYTES) throw new AppError(413, `Images can be up to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);
  if (!sniffImage(input)) throw new AppError(415, 'Please upload a PNG, JPEG or WebP image. (SVG and other formats are not accepted.)');
  try {
    const meta = await sharp(input, { limitInputPixels: MAX_PIXELS, failOn: 'error' }).metadata();
    if (!meta.width || !meta.height) throw new Error('no dimensions');
    if (kind === 'preview' && (meta.width < 320 || meta.height < 200)) {
      throw new AppError(400, 'Preview images should be at least 320 by 200 pixels so they are readable.');
    }
    const pipeline =
      kind === 'avatar'
        ? sharp(input, { limitInputPixels: MAX_PIXELS }).rotate().resize(AVATAR_EDGE, AVATAR_EDGE, { fit: 'cover' })
        : sharp(input, { limitInputPixels: MAX_PIXELS }).rotate().resize({ width: PREVIEW_MAX_EDGE, height: PREVIEW_MAX_EDGE, fit: 'inside', withoutEnlargement: true });
    // No .withMetadata(): sharp strips metadata by default.
    const { data, info } = await pipeline.webp({ quality: 82 }).toBuffer({ resolveWithObject: true });
    return { data, mime: 'image/webp', width: info.width, height: info.height };
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(400, 'That image could not be read. Try saving it again as a PNG or JPEG.');
  }
}

const uploadsDir = (): string => path.join(dataDir(), 'uploads');

export function storeMedia(db: Db, ownerId: string, img: ProcessedImage): { id: string } {
  const id = newId();
  const file = `${id}.webp`;
  mkdirSync(uploadsDir(), { recursive: true });
  writeFileSync(path.join(uploadsDir(), file), img.data);
  run(db, 'INSERT INTO media (id, owner_id, mime, width, height, bytes, file, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, ownerId, img.mime, img.width, img.height, img.data.length, file, Date.now());
  return { id };
}

export function readMedia(db: Db, id: string): { data: Buffer; mime: string } | null {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const row = get<{ file: string; mime: string }>(db, 'SELECT file, mime FROM media WHERE id = ?', id);
  if (!row || row.file.includes('/') || row.file.includes('\\')) return null;
  try {
    return { data: readFileSync(path.join(uploadsDir(), row.file)), mime: row.mime };
  } catch {
    return null;
  }
}

/** Removes files from disk (after the database rows are gone). Best effort. */
export function deleteMediaFiles(files: string[]): void {
  for (const f of files) {
    if (f.includes('/') || f.includes('\\')) continue;
    try {
      rmSync(path.join(uploadsDir(), f), { force: true });
    } catch {
      /* ignore */
    }
  }
}

/** A user may only attach media they uploaded themselves. */
export function requireOwnMedia(db: Db, userId: string, mediaId: string): void {
  const m = get<{ owner_id: string }>(db, 'SELECT owner_id FROM media WHERE id = ?', mediaId);
  if (!m) throw notFound('That image');
  if (m.owner_id !== userId) throw forbidden('You can only use images you uploaded.');
}
