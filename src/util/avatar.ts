// Shared avatar helpers: a stable per-identity color and short initials. The color
// formula is the SAME one the editor uses for a user's live cursor (colorForKey), so a
// presence avatar and that person's caret in the doc are always the same hue.

/** Stable HSL color derived from a string key (user id or email). */
export function colorForKey(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 70% 45%)`;
}

/** Up to two uppercase initials from a display name or email (local-part). */
export function initials(nameOrEmail: string): string {
  const base = (nameOrEmail.split('@')[0] || '').trim();
  if (!base) return '?';
  const parts = base.split(/[.\-_\s]+/).filter(Boolean);
  const chars = parts.length >= 2 ? parts[0][0] + parts[1][0] : base.slice(0, 2);
  return chars.toUpperCase();
}
