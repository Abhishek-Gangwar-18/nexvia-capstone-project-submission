import multer from 'multer';
import { ApiError } from '../utils/http.js';

const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];

/** Files are kept in memory and streamed to S3 (or local disk) by the storage service. */
export const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 8 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED.includes(file.mimetype)) cb(null, true);
    else cb(new ApiError(400, `Unsupported file type ${file.mimetype}. Use JPG, PNG, WEBP, GIF or AVIF.`));
  },
});
