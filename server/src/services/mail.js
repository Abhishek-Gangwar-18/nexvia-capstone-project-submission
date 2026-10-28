import nodemailer from 'nodemailer';
import { env, PLATFORM_NAME } from '../config/env.js';
import { logger } from '../utils/logger.js';

const { host, port, secure, user, pass, from } = env.smtp;

/** SMTP when configured; otherwise mails are logged so local development needs no provider. */
const transport = host ? nodemailer.createTransport({ host, port, secure, auth: user ? { user, pass } : undefined }) : null;

export async function sendMail({ to, subject, text, html }) {
  if (!transport) {
    logger.info(`[mail] SMTP not configured - would send "${subject}" to ${to}:\n${text}`);
    return;
  }
  await transport.sendMail({ from, to, subject, text, html });
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function sendVerificationEmail(to, rawName, link) {
  const name = escapeHtml(rawName);
  return sendMail({
    to,
    subject: `Verify your ${PLATFORM_NAME} email`,
    text: `Hi ${name},\n\nConfirm your email address by opening this link (valid for 24 hours):\n${link}\n\nIf you didn't create a ${PLATFORM_NAME} account, ignore this email.`,
    html: `<p>Hi ${name},</p><p>Confirm your email address to start shopping and selling on ${PLATFORM_NAME}.</p>
<p><a href="${link}" style="display:inline-block;padding:10px 18px;background:#4f46e5;color:#fff;border-radius:8px;text-decoration:none">Verify email</a></p>
<p style="color:#666;font-size:13px">The link is valid for 24 hours. If you didn't create an account, ignore this email.</p>`,
  });
}
