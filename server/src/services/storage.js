import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { env, SERVER_ROOT } from '../config/env.js';
import { logger } from '../utils/logger.js';

export const UPLOAD_DIR = path.join(SERVER_ROOT, 'uploads');

const { aws } = env;
const s3Enabled = Boolean(aws.bucket && aws.accessKeyId && aws.secretAccessKey);

const s3 = s3Enabled
  ? new S3Client({
      region: aws.region,
      endpoint: aws.endpoint || undefined,
      forcePathStyle: aws.forcePathStyle,
      credentials: { accessKeyId: aws.accessKeyId, secretAccessKey: aws.secretAccessKey },
    })
  : null;

export const storageDriver = () => (s3Enabled ? 's3' : 'local');

export function logStorageDriver() {
  if (s3Enabled) logger.ok(`Storage: AWS S3 bucket "${aws.bucket}" (${aws.region})`);
  else logger.warn('Storage: AWS S3 not configured -> uploads saved to server/uploads');
}

const EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' };

/**
 * Keys this app writes: {folder}/{YYYY-MM-DD}/{uploader's user id}/{uuid}.{ext}. Only keys of this shape are
 * ever deleted, so a key can't reach outside the upload folders (e.g. "../.env" on local disk).
 */
const KEY_PATTERN = /^(products|stores|avatars|reviews|returns)\/\d{4}-\d{2}-\d{2}\/([a-f\d]{24})\/[\da-f-]{36}\.(jpg|png|webp|gif|avif)$/;

const publicUrlFor = (key) => {
  if (!s3) return `${env.serverUrl}/uploads/${key}`;
  if (aws.publicUrl) return `${aws.publicUrl}/${key}`;
  if (aws.endpoint) return `${aws.endpoint.replace(/\/$/, '')}/${aws.bucket}/${key}`;
  return `https://${aws.bucket}.s3.${aws.region}.amazonaws.com/${key}`;
};

/** Stores an uploaded image (multer memory file, type already checked) and returns its public URL and storage key. */
export async function uploadFile(file, folder, ownerId) {
  const key = `${folder}/${new Date().toISOString().slice(0, 10)}/${ownerId}/${crypto.randomUUID()}.${EXTENSIONS[file.mimetype]}`;

  if (s3) {
    await s3.send(
      new PutObjectCommand({
        Bucket: aws.bucket,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
  } else {
    const target = path.join(UPLOAD_DIR, key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.buffer);
  }
  return { url: publicUrlFor(key), key };
}

/**
 * The storage key behind `url` when it is a file this app stored for `ownerId`; null for anything else
 * (seeded or external images, other users' files, uploads from before the owner was part of the key).
 * Keys are always worked out here, never taken from the client.
 */
export function ownedKey(url, ownerId) {
  const base = publicUrlFor('');
  if (typeof url !== 'string' || !url.startsWith(base)) return null;
  const key = url.slice(base.length);
  const match = KEY_PATTERN.exec(key);
  return match && match[2] === String(ownerId) ? key : null;
}

/** Best-effort delete of a key this app wrote; returns whether the file is gone. */
export async function deleteFile(key) {
  if (!KEY_PATTERN.test(key || '')) return false;
  try {
    if (s3) await s3.send(new DeleteObjectCommand({ Bucket: aws.bucket, Key: key }));
    else await fs.rm(path.join(UPLOAD_DIR, key), { force: true });
    return true;
  } catch (err) {
    logger.warn(`Could not delete file ${key}: ${err.message}`);
    return false;
  }
}

/**
 * Deletes the images that were in `before` but are no longer in `after` (lists of URLs), when `ownerId`
 * uploaded them. Call it after the change is saved, so a failed save never loses a picture still in use.
 */
export function deleteReplaced(before, after, ownerId) {
  const kept = new Set(after.filter(Boolean));
  const keys = [...new Set(before)].filter((url) => !kept.has(url)).map((url) => ownedKey(url, ownerId)).filter(Boolean);
  return Promise.all(keys.map(deleteFile));
}
