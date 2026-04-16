// SPDX-License-Identifier: Hippocratic-3.0
import nodemailer from 'nodemailer';
import type { FastifyInstance } from 'fastify';

let transporter: nodemailer.Transporter | null = null;

export function initEmail(fastify: FastifyInstance): void {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT) || 587;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host) {
    fastify.log.warn('SMTP_HOST not set — email sending disabled');
    return;
  }

  transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: user ? { user, pass } : undefined,
  });

  fastify.log.info({ host, port }, 'Email transport configured');
}

export function isEmailEnabled(): boolean {
  return transporter !== null;
}

export async function sendVerificationEmail(
  to: string,
  token: string,
  config: { domain: string; secureCookies: boolean },
): Promise<void> {
  if (!transporter) return;
  const protocol = config.secureCookies ? 'https' : 'http';
  const verifyUrl = `${protocol}://${config.domain}/api/auth/verify?token=${encodeURIComponent(token)}`;
  const from = process.env.SMTP_FROM || `noreply@${config.domain}`;

  await transporter.sendMail({
    from,
    to,
    subject: 'Verify your Babelr account',
    text: `Welcome to Babelr!\n\nClick the link below to verify your email:\n\n${verifyUrl}\n\nThis link expires in 24 hours.\n\nIf you didn't create this account, you can ignore this email.`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 2rem;">
        <h2 style="color: #e2e8f0;">Welcome to Babelr!</h2>
        <p style="color: #cbd5e1; line-height: 1.6;">Click the button below to verify your email address:</p>
        <a href="${verifyUrl}" style="display: inline-block; background: #2563eb; color: white; padding: 0.75rem 1.5rem; border-radius: 6px; text-decoration: none; margin: 1rem 0;">Verify Email</a>
        <p style="color: #94a3b8; font-size: 0.85rem;">This link expires in 24 hours.</p>
        <p style="color: #64748b; font-size: 0.8rem;">If you didn't create this account, you can ignore this email.</p>
      </div>
    `,
  });
}
