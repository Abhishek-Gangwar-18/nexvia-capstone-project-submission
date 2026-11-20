import multer from 'multer';
import { ApiError } from '../utils/http.ts';

const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Files are kept in memory and streamed to S3 (or local disk) by the storage service. */
export const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 8 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED.includes(file.mimetype)) cb(null, true);
    else cb(new ApiError(400, `Unsupported file type ${file.mimetype}. Use JPG, PNG, WEBP, GIF or AVIF.`));
  },
});

/** The image type from a file's first bytes, or null when it is none of the allowed formats. */
export function sniffImage(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(PNG)) return 'image/png';
  const head = buf.toString('latin1', 0, 12);
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return 'image/gif';
  if (head.startsWith('RIFF') && head.slice(8) === 'WEBP') return 'image/webp';
  if (head.slice(4, 8) === 'ftyp') {
    // ISO box: [size][ftyp][major brand][version][compatible brands...]; AVIF lists avif or avis.
    const brands = buf.toString('latin1', 8, Math.min(buf.readUInt32BE(0), buf.length, 64));
    if (/avi[fs]/.test(brands)) return 'image/avif';
  }
  return null;
}

/**
 * Runs after multer: the browser's Content-Type is only a claim, so every file must really be one of the
 * allowed images. Checked before anything is stored, and the stored type comes from the bytes.
 */
export function verifyImages(req, _res, next) {
  for (const file of req.files || []) {
    const type = sniffImage(file.buffer);
    if (!type) return next(new ApiError(400, `${file.originalname} is not a valid image. Use JPG, PNG, WEBP, GIF or AVIF.`));
    file.mimetype = type;
  }
  next();
}
