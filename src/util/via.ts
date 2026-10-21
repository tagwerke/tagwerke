// Writes made with a personal access token are recorded as the owner PLUS the token's name
// (server/lib/audit.ts stamps `via: 'pat'` and `tokenLabel` on the audit payload), so the UI can say
// "kirill · PAT Claude Code" instead of attributing a script's work to the person alone.

/** The token name behind an audited write, or null when a person did it directly. */
export function patNameOf(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as { via?: unknown; tokenLabel?: unknown };
  if (p.via !== 'pat') return null;
  return typeof p.tokenLabel === 'string' && p.tokenLabel ? p.tokenLabel : 'token';
}
