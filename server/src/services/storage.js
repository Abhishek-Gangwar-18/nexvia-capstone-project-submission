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

const publicUrlFor = (key) => {
  if (aws.publicUrl) return `${aws.publicUrl}/${key}`;
  if (aws.endpoint) return `${aws.endpoint.replace(/\/$/, '')}/${aws.bucket}/${key}`;
  return `https://${aws.bucket}.s3.${aws.region}.amazonaws.com/${key}`;
};

/** Stores an uploaded file (multer memory file) and returns its public URL and storage key. */
export async function uploadFile(file, folder = 'misc') {
  const ext = EXTENSIONS[file.mimetype] || path.extname(file.originalname).slice(1) || 'bin';
  const key = `${folder}/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.${ext}`;

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
    return { url: publicUrlFor(key), key };
  }

  const target = path.join(UPLOAD_DIR, key);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, file.buffer);
  return { url: `${env.serverUrl}/uploads/${key}`, key };
}

/** Best-effort delete; external (seeded) images have no key and are skipped. */
export async function deleteFile(key) {
  if (!key) return;
  try {
    if (s3) await s3.send(new DeleteObjectCommand({ Bucket: aws.bucket, Key: key }));
    else await fs.rm(path.join(UPLOAD_DIR, key), { force: true });
  } catch (err) {
    logger.warn(`Could not delete file ${key}: ${err.message}`);
  }
}
