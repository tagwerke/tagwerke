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

// ── Email templates ─────────────────────────────────────────────────────────
// Styled to match the in-app auth card (warm paper, `do` wordmark, orange accent).
// HTML email = inline styles + table layout only (clients strip <style>, no flexbox/
// CSS-variables), so the app's design tokens are hand-inlined here.

const INK = '#1b1814';
const INK_SOFT = '#5b5246';
const INK_MUTE = '#948a7a';
const BG = '#f6f4ee';
const PAPER = '#fbfaf6';
const LINE = '#e7e2d7';
const ACCENT = '#ff6a3d';
const SERIF = `'Iowan Old Style', Palatino, Georgia, 'Times New Roman', serif`;
const SANS = `-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`;

/** Wrap body content in the branded shell: paper background + centered card. */
function shell(preheader: string, inner: string): string {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head>
<body style="margin:0;padding:0;background:${BG};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${preheader}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};padding:32px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:${PAPER};border:1px solid ${LINE};border-radius:16px;">
        <tr><td style="padding:32px 36px 36px;font-family:${SANS};">
          <div style="font-family:${SERIF};font-size:30px;font-weight:700;color:${INK};letter-spacing:-0.5px;margin:0 0 20px;">do</div>
          ${inner}
        </td></tr>
      </table>
      <div style="max-width:440px;margin:14px auto 0;font-family:${SANS};font-size:11px;color:${INK_MUTE};text-align:center;">
        ${process.env.ORG_NAME ?? 'Workspace'} · this is an automated security email
      </div>
    </td></tr>
  </table>
</body>
</html>`;
}

/** Password-reset email — subject + plaintext + branded HTML. */
export function passwordResetEmail(link: string): { subject: string; text: string; html: string } {
  const subject = 'Reset your password';
  const text = `Reset your password using the link below (valid for 1 hour):\n\n${link}\n\nIf you didn't request this, you can ignore this email.`;
  const inner = `
    <h1 style="font-family:${SERIF};font-size:20px;font-weight:600;color:${INK};margin:0 0 12px;">Reset your password</h1>
    <p style="font-size:14px;line-height:1.55;color:${INK_SOFT};margin:0 0 22px;">
      Click the button below to choose a new password. This link is valid for one hour.
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 22px;">
      <tr><td style="border-radius:10px;background:${ACCENT};">
        <a href="${link}" style="display:inline-block;padding:11px 22px;font-family:${SANS};font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px;">Reset password</a>
      </td></tr>
    </table>
    <p style="font-size:12px;line-height:1.5;color:${INK_MUTE};margin:0 0 6px;">Or paste this link into your browser:</p>
    <p style="font-size:12px;line-height:1.5;margin:0 0 22px;word-break:break-all;"><a href="${link}" style="color:${ACCENT};">${link}</a></p>
    <p style="font-size:12px;line-height:1.5;color:${INK_MUTE};margin:0;border-top:1px solid ${LINE};padding-top:16px;">
      If you didn't request this, you can safely ignore this email — your password won't change.
    </p>`;
  return { subject, text, html: shell('Reset your password — link valid for 1 hour.', inner) };
}
