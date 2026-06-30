// The one email seam. Swappable transport configured via SMTP env vars — point these at
// Amazon SES SMTP in an EU region (eu-west-1 / eu-central-1) for data residency, or any
// SMTP server. Keeping it behind a single function means the provider is one config change,
// never a code change. See AUTH_IMPLEMENTATION_PLAN.md (Slice 4).
//
//   SMTP_HOST, SMTP_PORT (default 587), SMTP_SECURE (true for 465), SMTP_USER, SMTP_PASS,
//   MAIL_FROM, APP_URL (for links in emails)
//
// When SMTP is unconfigured we do NOT silently "succeed": in dev the message is logged to
// the console so reset flows are testable; in production a missing transport throws.

import nodemailer, { type Transporter } from 'nodemailer';

let cached: Transporter | null | undefined;

function transport(): Transporter | null {
  if (cached !== undefined) return cached;
  const host = process.env.SMTP_HOST;
  if (!host) {
    cached = null;
    return null;
  }
  cached = nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  return cached;
}

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export async function sendEmail(mail: Mail): Promise<void> {
  const t = transport();
  const from = process.env.MAIL_FROM ?? 'no-reply@localhost';
  if (!t) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('email transport not configured (set SMTP_HOST/SMTP_* env vars)');
    }
    // Dev fallback: surface the message so flows can be exercised without a mail server.
    console.log(`\n[email:dev] to=${mail.to}  subject="${mail.subject}"\n${mail.text}\n`);
    return;
  }
  await t.sendMail({ from, to: mail.to, subject: mail.subject, text: mail.text, html: mail.html });
}

/** Base URL for links in emails. */
export function appUrl(): string {
  return process.env.APP_URL ?? 'http://localhost:5173';
}
