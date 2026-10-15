// IP and CIDR helpers for the board-secrets network policy and secret-link pinning.
//
// Built on node:net's BlockList, so there is no hand-rolled address parsing to get wrong.
//
// The address checked is Fastify's `req.ip`, which (trustProxy: true in index.ts) is taken from
// X-Forwarded-For. Behind a proxy that overwrites that header (Traefik/Dokploy's default, Caddy,
// nginx with `proxy_set_header X-Forwarded-For $remote_addr`) it is the real client. With the app
// published directly and NO proxy in front, a client can write that header itself, and a network
// policy is then only as strong as the client's honesty — docs/self-hosting.md says so.

import { BlockList, isIP } from 'node:net';

export interface Cidr {
  address: string;
  prefix: number;
  family: 'ipv4' | 'ipv6';
}

/** Strip the IPv4-mapped IPv6 prefix so `::ffff:10.0.0.1` matches a `10.0.0.0/8` rule. */
export function normalizeIp(ip: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return m ? m[1] : ip;
}

/** Parse `10.0.0.0/8`, `2001:db8::/32`, or a bare address (= a single host). Null when invalid. */
export function parseCidr(raw: string): Cidr | null {
  const s = raw.trim();
  const [addr, len, extra] = s.split('/');
  if (extra !== undefined || !addr) return null;
  const v = isIP(normalizeIp(addr));
  if (!v) return null;
  const max = v === 4 ? 32 : 128;
  const prefix = len === undefined ? max : /^\d{1,3}$/.test(len) ? Number(len) : NaN;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) return null;
  return { address: normalizeIp(addr), prefix, family: v === 4 ? 'ipv4' : 'ipv6' };
}

/** Canonical text for a stored rule, e.g. `10.0.0.0/8`. */
export function formatCidr(c: Cidr): string {
  return `${c.address}/${c.prefix}`;
}

/** True when `ip` falls inside any of `cidrs`. Unparseable rules are ignored, never widened. */
export function ipInCidrs(ip: string, cidrs: readonly string[]): boolean {
  const addr = normalizeIp(ip);
  const fam = isIP(addr);
  if (!fam) return false;
  const list = new BlockList();
  for (const raw of cidrs) {
    const c = parseCidr(raw);
    if (c) list.addSubnet(c.address, c.prefix, c.family);
  }
  return list.check(addr, fam === 4 ? 'ipv4' : 'ipv6');
}

/** Whether `ip` is inside the pin recorded for a secret link (D4). IPv6 maps /32→/128, /24→/64. */
export function withinPin(ip: string, pinnedIp: string, pinPrefix: number): boolean {
  const pinned = normalizeIp(pinnedIp);
  const fam = isIP(pinned);
  if (!fam) return false;
  const prefix = fam === 4 ? pinPrefix : pinPrefix >= 32 ? 128 : 64;
  return ipInCidrs(ip, [`${pinned}/${prefix}`]);
}
