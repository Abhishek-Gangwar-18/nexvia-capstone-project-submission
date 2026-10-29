import { z } from 'zod';
import { CANCEL_REASONS_BY_ACTOR } from '../models/Order.js';

/** Shared field rules so users, vendors and addresses validate contact details the same way. */

export const PASSWORD_MIN = 8;

export const email = z.string().trim().toLowerCase().email('Enter a valid email address');

/** Indian mobile number. Accepts spaces, dashes and a +91/0 prefix; stores the bare 10 digits. */
export const phone = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s-]/g, '').replace(/^(\+91|91|0)(?=\d{10}$)/, ''))
  .pipe(z.string().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number'));

export const password = (label = 'Password') =>
  z.string().min(PASSWORD_MIN, `${label} must be at least ${PASSWORD_MIN} characters`).max(100);

export const pincode = z.string().trim().regex(/^\d{6}$/, 'Pincode must be 6 digits');

/** 15-character GSTIN: state code, PAN, entity number, 'Z', checksum. */
export const GSTIN_REGEX = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const gstin = z.string().trim().toUpperCase().regex(GSTIN_REGEX, 'Enter a valid 15-character GSTIN (e.g. 27ABCDE1234F1Z5)');

/** Matches the shared Mongoose address schema (models/address.js). */
export const address = z.object({
  line1: z.string().trim().min(3, 'Address line 1 is required'),
  line2: z.string().trim().max(120).optional().default(''),
  city: z.string().trim().min(2, 'City is required'),
  state: z.string().trim().min(2, 'State is required'),
  pincode,
  country: z.string().trim().default('India'),
});

/** Cancel reason for a given actor: a code from their list, and a note when the code is `other`. */
export const cancelReason = (actor) =>
  z
    .object({ reasonCode: z.enum(CANCEL_REASONS_BY_ACTOR[actor]), note: z.string().trim().max(200).optional() })
    .refine((b) => b.reasonCode !== 'other' || (b.note && b.note.length >= 3), { message: 'Describe the reason (at least 3 characters)', path: ['note'] });
