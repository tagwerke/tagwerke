// Asserts the security headers this app ships (server/lib/security.ts).
//
// Runs against a bare Fastify with ONLY helmet registered — no database, no routes — so it can be
// run anywhere, including CI and a machine with no Postgres. What it protects is the thing static
// analysis cannot see: a CSP is a string, a typo in it either silently permits what it should block
// or silently breaks the app for every user at once.
//
//   npm run verify:csp
//
// Add a case here whenever a directive changes. If a new feature needs a new source, this failing
// is the intended way to find out.

import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import { helmetOptions } from '../lib/security.ts';

const HOST = 'tagwerke.example.com:8443';

let failures = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function headersFor(isProd: boolean, host = HOST): Promise<Record<string, string>> {
  const app = Fastify();
  await app.register(helmet, helmetOptions(isProd));
  app.get('/probe', async () => ({ ok: true }));
  const res = await app.inject({ method: 'GET', url: '/probe', headers: { host } });
  await app.close();
  return res.headers as Record<string, string>;
}

const dev = await headersFor(false);
const prod = await headersFor(true);
const csp = dev['content-security-policy'] ?? '';

console.log('\ncontent-security-policy:\n  ' + csp.split('; ').join('\n  ') + '\n');

console.log('directives that must be present:');
for (const expected of [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "font-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
]) {
  check(expected, csp.includes(expected));
}

console.log('\ndeliberate allowances (each exists for a named reason):');
// Inline style ATTRIBUTES from React style={{…}} props. Removing this means auditing them first.
check("style-src allows 'unsafe-inline'", csp.includes("style-src 'self' 'unsafe-inline'"));
// The TOTP enrolment QR is a data: URI from QRCode.toDataURL.
check('img-src allows data:', /img-src [^;]*data:/.test(csp));

console.log('\nthings that must NOT be present:');
// Would rewrite every request to https and kill a plain-http self-host on a LAN.
check('no upgrade-insecure-requests', !csp.includes('upgrade-insecure-requests'));
// A bare wss:/ws: wildcard would allow exfiltration to any server.
check('no bare wss: wildcard', !/connect-src [^;]*(\s|;)wss:(\s|;|$)/.test(csp));
check("script-src does not allow 'unsafe-inline'", !/script-src [^;]*'unsafe-inline'/.test(csp));
check("script-src does not allow 'unsafe-eval'", !/script-src [^;]*'unsafe-eval'/.test(csp));

console.log('\nwebsocket origin is derived from Host, and scoped to it:');
check(`connect-src names wss://${HOST}`, csp.includes(`wss://${HOST}`));
check(`connect-src names ws://${HOST}`, csp.includes(`ws://${HOST}`));
check("connect-src still keeps 'self'", /connect-src 'self'/.test(csp));

// Host arrives from the client. A malformed one must degrade to 'self', never be spliced in.
const spoofed = await headersFor(false, 'evil.com; script-src *');
const spoofedCsp = spoofed['content-security-policy'] ?? '';
check('a malformed Host is dropped, not reflected', !spoofedCsp.includes('evil.com'), spoofedCsp);

console.log('\nHSTS is production-only, and never reaches sibling subdomains:');
check('absent outside production', !dev['strict-transport-security']);
check('present in production', Boolean(prod['strict-transport-security']));
check(
  'production HSTS omits includeSubDomains',
  !(prod['strict-transport-security'] ?? '').includes('includeSubDomains'),
  prod['strict-transport-security'],
);

console.log('\nother headers:');
check('x-content-type-options: nosniff', dev['x-content-type-options'] === 'nosniff');
check('x-frame-options: DENY', dev['x-frame-options'] === 'DENY');
check('referrer-policy set', Boolean(dev['referrer-policy']), dev['referrer-policy']);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.\n`);
  process.exit(1);
}
console.log('\nall security header checks passed.\n');
