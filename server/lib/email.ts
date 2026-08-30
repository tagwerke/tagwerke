// The one email seam. Two transports, one function: everything else in the app calls
// sendEmail() and never learns which one is in play.
//
//   SES API   AWS_SES_REGION (+ AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY), MAIL_FROM
//   SMTP      SMTP_HOST, SMTP_PORT (default 587), SMTP_SECURE (true for 465),
//             SMTP_USER, SMTP_PASS, MAIL_FROM
//   both      APP_URL (for links in emails)
//
// Which one runs is decided by AWS_SES_REGION alone — set it and mail goes over the SES API
// (SigV4 over HTTPS), leave it and mail goes over SMTP. The SES path exists because SES SMTP
// credentials can only be minted by someone with IAM rights on the AWS account; a plain
// send-only access key is often all an operator is given, and that key cannot speak SMTP.
//
// Mail is either configured or it isn't — `mailStatus()` is the single answer, and callers
// gate on it rather than guessing. Half-configured counts as NOT configured: leaving
// SMTP_USER/SMTP_PASS blank (as .env.example ships them) used to build an unauthenticated
// transport that every hosted relay rejects — SES answers `530 Authentication required` —
// while /api/auth/forgot swallowed the throw and told the user a link was on its way. A
// silent mail failure is the worst kind: the person who needs it is locked out and waiting.
//
// When mail is unconfigured we do NOT silently "succeed": in dev the message is logged to
// the console so reset flows are testable; in production a missing transport throws.

import nodemailer, { type Transporter } from 'nodemailer';

/** Read an env var, treating whitespace/empty as unset — `SMTP_USER=` is not a username. */
function env(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

// Escape hatch for a relay that genuinely accepts unauthenticated mail (a local postfix, an
// internal smarthost). Every hosted provider — SES, Postmark, Mailgun — needs credentials,
// so blank creds are treated as a misconfiguration unless this is explicitly set.
const allowAnonymous = process.env.SMTP_ALLOW_ANONYMOUS === 'true';

export type MailStatus =
  | { ok: true; detail: string; warning?: string }
  | { ok: false; detail: string };

/** Which transport this instance is set up to use. AWS_SES_REGION is the deliberate switch:
 *  it is specific to mail, so an AWS_REGION set for some unrelated reason can't hijack it. */
function transportKind(): 'ses' | 'smtp' | 'none' {
  if (env('AWS_SES_REGION')) return 'ses';
  if (env('SMTP_HOST')) return 'smtp';
  return 'none';
}

/** Whether this instance can send mail, and a human-readable reason when it can't.
 *  Cheap and env-only — safe to call per request. */
export function mailStatus(): MailStatus {
  const from = env('MAIL_FROM');
  const kind = transportKind();

  if (kind === 'none') {
    return { ok: false, detail: 'no mail transport configured — set AWS_SES_REGION (SES API) or SMTP_HOST (SMTP)' };
  }
  if (!from) {
    return { ok: false, detail: 'MAIL_FROM is not set — there is no verified sender to send as' };
  }

  if (kind === 'ses') {
    const key = env('AWS_ACCESS_KEY_ID');
    const secret = env('AWS_SECRET_ACCESS_KEY');
    if (!key !== !secret) {
      return { ok: false, detail: `AWS_${key ? 'SECRET_ACCESS_KEY' : 'ACCESS_KEY_ID'} is empty — set both or neither` };
    }
    const region = env('AWS_SES_REGION')!;
    return key
      ? { ok: true, detail: `SES API ${region} as ${from}` }
      : { ok: true, detail: `SES API ${region} as ${from} (no explicit key — using the AWS default credential chain)` };
  }

  const host = env('SMTP_HOST')!;
  const user = env('SMTP_USER');
  const pass = env('SMTP_PASS');
  if (!user && !pass) {
    return allowAnonymous
      ? { ok: true, detail: `SMTP ${host} as ${from} (unauthenticated, SMTP_ALLOW_ANONYMOUS=true)` }
      : {
          ok: false,
          detail: `SMTP_HOST is set to ${host} but SMTP_USER/SMTP_PASS are empty — hosted relays reject unauthenticated mail (SES: "530 Authentication required"). Fill both, or set SMTP_ALLOW_ANONYMOUS=true for an internal relay that needs no login.`,
        };
  }
  if (!user || !pass) {
    return { ok: false, detail: `SMTP_${user ? 'PASS' : 'USER'} is empty — set both or neither` };
  }
  return { ok: true, detail: `SMTP ${host} as ${from}` };
}

/** True when mail can be sent. Callers that need a reason should use `mailStatus()`. */
export function isEmailConfigured(): boolean {
  return mailStatus().ok;
}

// ── SES API transport ───────────────────────────────────────────────────────
// The SDK is imported lazily so an SMTP-only deployment never pays to load it at boot.

type SESv2 = import('@aws-sdk/client-sesv2').SESv2Client;
let sesCached: SESv2 | undefined;

async function sesClient(): Promise<SESv2> {
  if (sesCached) return sesCached;
  const { SESv2Client } = await import('@aws-sdk/client-sesv2');
  const key = env('AWS_ACCESS_KEY_ID');
  const secret = env('AWS_SECRET_ACCESS_KEY');
  sesCached = new SESv2Client({
    region: env('AWS_SES_REGION'),
    // Omitting `credentials` entirely lets the SDK walk its default chain (env, shared
    // config, container/instance role) — the right behaviour when no key was supplied.
    ...(key && secret
      ? { credentials: { accessKeyId: key, secretAccessKey: secret, sessionToken: env('AWS_SESSION_TOKEN') } }
      : {}),
  });
  return sesCached;
}

async function sendViaSes(mail: Mail, from: string): Promise<void> {
  const { SendEmailCommand } = await import('@aws-sdk/client-sesv2');
  const client = await sesClient();
  await client.send(
    new SendEmailCommand({
      FromEmailAddress: from,
      Destination: { ToAddresses: [mail.to] },
      Content: {
        Simple: {
          Subject: { Data: mail.subject, Charset: 'UTF-8' },
          Body: {
            Text: { Data: mail.text, Charset: 'UTF-8' },
            ...(mail.html ? { Html: { Data: mail.html, Charset: 'UTF-8' } } : {}),
          },
        },
      },
    }),
  );
}

// ── SMTP transport ──────────────────────────────────────────────────────────

let smtpCached: Transporter | null | undefined;

function smtpTransport(): Transporter | null {
  if (smtpCached !== undefined) return smtpCached;
  if (transportKind() !== 'smtp' || !mailStatus().ok) {
    smtpCached = null;
    return null;
  }
  const user = env('SMTP_USER');
  smtpCached = nodemailer.createTransport({
    host: env('SMTP_HOST'),
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: user ? { user, pass: env('SMTP_PASS') } : undefined,
  });
  return smtpCached;
}

// ── Public API ──────────────────────────────────────────────────────────────

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export async function sendEmail(mail: Mail): Promise<void> {
  const status = mailStatus();
  const from = env('MAIL_FROM') ?? 'no-reply@localhost';

  if (!status.ok) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(`email transport not configured: ${status.detail}`);
    }
    // Dev fallback: surface the message so flows can be exercised without a mail server.
    console.log(`\n[email:dev] to=${mail.to}  subject="${mail.subject}"\n${mail.text}\n`);
    return;
  }

  if (transportKind() === 'ses') return sendViaSes(mail, from);

  const t = smtpTransport();
  if (!t) throw new Error(`email transport not configured: ${status.detail}`);
  await t.sendMail({ from, to: mail.to, subject: mail.subject, text: mail.text, html: mail.html });
}

/** Check the transport without sending anything. Used by the boot preflight and
 *  `npm run mail:test`, so bad credentials surface at deploy time rather than the moment a
 *  locked-out user asks for a reset.
 *
 *  For SES this reads the account's sending status, which also reveals sandbox mode — the
 *  single most common reason a correctly-credentialled SES account still delivers nothing.
 *  A key scoped to `ses:SendEmail` alone cannot call it; that is reported as a warning, not
 *  a failure, because sending itself may well work. */
export async function verifyEmailTransport(): Promise<MailStatus> {
  const status = mailStatus();
  if (!status.ok) return status;

  if (transportKind() === 'ses') {
    try {
      const { GetAccountCommand } = await import('@aws-sdk/client-sesv2');
      const acct = await (await sesClient()).send(new GetAccountCommand({}));
      if (acct.SendingEnabled === false) {
        return { ok: false, detail: `${status.detail} — SES sending is DISABLED for this account` };
      }
      if (acct.ProductionAccessEnabled === false) {
        return {
          ok: true,
          detail: status.detail,
          warning: 'SES is in SANDBOX mode — it will only deliver to verified addresses. Request production access, or verify each recipient.',
        };
      }
      return { ok: true, detail: status.detail };
    } catch (err) {
      const e = err as { name?: string; message?: string };
      if (e.name === 'AccessDeniedException') {
        return { ok: true, detail: status.detail, warning: 'credentials work but cannot read account status (ses:GetAccount denied) — sandbox mode could not be checked' };
      }
      return { ok: false, detail: `${status.detail} — SES rejected the call: ${e.name ?? ''} ${e.message ?? String(err)}`.trim() };
    }
  }

  const t = smtpTransport();
  if (!t) return { ok: false, detail: 'no transport' };
  try {
    await t.verify();
    return { ok: true, detail: status.detail };
  } catch (err) {
    const e = err as { responseCode?: number; message?: string };
    return { ok: false, detail: `${status.detail} — relay rejected the connection: ${e.responseCode ?? ''} ${e.message ?? String(err)}`.trim() };
  }
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
