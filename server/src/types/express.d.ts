// Fields the middleware adds to every Express request (see middleware/auth.ts and middleware/validate.ts).
import type { SafeUser } from '../models/User.ts';
import type { VendorDocument } from '../models/Vendor.ts';

declare global {
  namespace Express {
    interface Request {
      /** The signed-in user (from the session cache), set by `protect` / `optionalAuth`. */
      user?: SafeUser;
      /** The verified access-token payload. */
      auth?: { sub: string; sid: string; role?: string; iat: number; exp?: number; [key: string]: any };
      /** The vendor profile of a signed-in vendor, set by `loadVendor`. */
      vendor?: VendorDocument;
      /** Parsed and validated input, set by `validate()`. */
      valid?: any;
    }
  }
}

export {};
