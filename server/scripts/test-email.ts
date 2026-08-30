// Prove the mail path works — without locking yourself out to find out.
//
//   npm run mail:test                      # config check + credential/transport check only
//   npm run mail:test -- you@example.com   # also send a real test message there
//
// Works for whichever transport is configured (SES API or SMTP). Exits non-zero when mail is
// unusable, so a deploy check can gate on it. Sending is opt-in because a sandboxed SES
// account accepts credentials but rejects unverified recipients — a credential check passing
// is not proof of delivery.

import 'dotenv/config';
import { mailStatus, verifyEmailTransport, sendEmail, appUrl } from '../lib/email.ts';

async function main() {
  const to = process.argv[2];

  const cfg = mailStatus();
  console.log(`\n  config:    ${cfg.ok ? 'OK' : 'NOT USABLE'} — ${cfg.detail}`);
  if (!cfg.ok) {
    console.log('  → password resets will be refused with 503 until this is fixed.\n');
    process.exit(1);
  }

  const conn = await verifyEmailTransport();
  console.log(`  transport: ${conn.ok ? 'OK' : `FAILED — ${conn.detail}`}`);
  if (!conn.ok) {
    console.log('  → password resets will fail at send time.\n');
    process.exit(1);
  }
  if (conn.warning) console.log(`  warning:   ${conn.warning}`);

  if (!to) {
    console.log(`  links:     ${appUrl()}/reset?token=…  (from APP_URL — must be the public URL)`);
    console.log('\n  Pass an address to send a real test: npm run mail:test -- you@example.com\n');
    return;
  }

  try {
    await sendEmail({
      to,
      subject: 'Tagwerke mail test',
      text: `This is a test from your Tagwerke instance.\n\nReset links will point at ${appUrl()}/reset?token=…\nIf that URL is wrong, fix APP_URL.`,
    });
    console.log(`  send:      OK — accepted for delivery to ${to}`);
    console.log('  → check the inbox (and spam). Nothing there means it was accepted and then dropped.\n');
  } catch (err) {
    const e = err as { name?: string; responseCode?: number; message?: string };
    console.log(`  send:      FAILED — ${e.name ?? ''} ${e.responseCode ?? ''} ${e.message ?? String(err)}`.replace(/\s+/g, ' ').trimEnd());
    console.log('  → a sandboxed account rejects unverified recipients, and MAIL_FROM must itself be a verified identity.\n');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
