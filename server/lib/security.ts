// Security headers for every response — API, static bundle and SPA fallback alike.
//
// Until 2026-09-12 the app set NONE of these. This is a prerequisite for ever serving a
// user-uploaded file back to a browser (DOCUMENTS_PLAN.md §5): an uploaded .svg or .html rendered
// inline would otherwise execute on this origin with the viewer's session cookie.
//
// Lives in its own module rather than inline in index.ts so the policy can be asserted without
// booting the app and its database — see server/scripts/verify-csp.ts.

import type { FastifyHelmetOptions } from '@fastify/helmet';

/** Request shape helmet hands a directive function — just enough of it to read the Host header. */
interface HeaderSource {
  headers: Record<string, string | string[] | undefined>;
}

/**
 * The realtime socket's origin.
 *
 * CSP3 says `'self'` already covers a same-origin ws:/wss:, but that was a late amendment with a
 * patchy history in Safari, and a silently blocked WebSocket costs co-editing and live updates with
 * no visible error. So name the origin explicitly alongside `'self'`.
 *
 * Scoped to THIS host — never a bare `wss:` wildcard, which would permit exfiltration to any
 * server. Both schemes are listed because a self-host on a LAN is plain http; mixed-content rules
 * independently stop the ws: entry from ever being usable on an https page.
 */
export function socketOrigin(req: HeaderSource): string {
  const raw = req.headers.host;
  const host = Array.isArray(raw) ? raw[0] : raw;
  // Host is attacker-controlled, and it is being spliced into a header. Anything that is not a
  // plain host[:port] is dropped rather than escaped — 'self' alone is a safe policy, a malformed
  // directive is not.
  if (!host || !/^[a-zA-Z0-9.-]+(:[0-9]{1,5})?$/.test(host)) return "'self'";
  return `wss://${host} ws://${host}`;
}

/**
 * The policy is written out in full (`useDefaults: false`) rather than layered onto helmet's
 * defaults, so what ships is what is listed here. Anything not named falls back to `default-src`.
 */
export function helmetOptions(isProd: boolean): FastifyHelmetOptions {
  return {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'self'"],
        'base-uri': ["'self'"],
        'object-src': ["'none'"],
        'frame-ancestors': ["'none'"],
        'form-action': ["'self'"],
        'script-src': ["'self'"],
        // 22 components pass inline `style={{…}}` props (e.g. StatusControl's --accent), and an
        // inline style ATTRIBUTE is blocked by style-src without this. Removing it means auditing
        // every one of them into classes first; not worth coupling to this change.
        'style-src': ["'self'", "'unsafe-inline'"],
        // data: is for the TOTP enrolment QR, which auth/routes.ts builds with QRCode.toDataURL.
        'img-src': ["'self'", 'data:'],
        'font-src': ["'self'"],
        'manifest-src': ["'self'"],
        'worker-src': ["'self'"], // public/sw.js
        'connect-src': ["'self'", socketOrigin],
        // NO upgrade-insecure-requests on purpose: a self-hoster reaching the app over plain http
        // on a LAN would have every request rewritten to https and get a dead app.
      },
    },
    // Only meaningful over https, and browsers ignore it over http — but includeSubDomains would
    // reach every OTHER service on the operator's domain (staging, unrelated apps behind a
    // wildcard), which is not ours to decide. Off entirely outside production; a reverse proxy
    // may own it instead.
    hsts: isProd ? { maxAge: 15552000, includeSubDomains: false, preload: false } : false,
    // frame-ancestors above is the modern control; this is the legacy header saying the same.
    frameguard: { action: 'deny' },
  };
}
