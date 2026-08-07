// The `@mention` token format used inside comment bodies (COMMENTS_PLAN.md D5).
//
// A comment body is PLAIN TEXT. A mention is one token embedded in it:
//
//     @[alice](V1StGXR8_Z5jdHi6B-myT)
//
// Display name first (so a client that has never heard of this format still renders something
// readable), user id second (so the reference survives a rename and is what the server resolves).
//
// This lives in shared/ because both ends must agree on it and neither owns it: the composer
// WRITES tokens, the renderer READS them, and the server RE-DERIVES the recipient list from them —
// it never trusts a mention list the client sends alongside. Parsing in one place is what makes
// "what the user sees mentioned" and "who actually gets notified" the same set.

/** Matches one `@[name](id)` token. Ids are nanoid-shaped (URL-safe base64 alphabet). */
const TOKEN = /@\[([^\]\n]*)\]\(([A-Za-z0-9_-]+)\)/g;

/** One mention token found in a body, with where it sits so a renderer can split around it. */
export interface MentionToken {
  /** Display name as it was written at mention time. */
  name: string;
  /** The mentioned user's id. */
  userId: string;
  /** Index of the token's first character in the body. */
  start: number;
  /** Index one past the token's last character. */
  end: number;
}

/** Every mention token in `body`, in order of appearance (duplicates kept — they're real text). */
export function parseMentions(body: string): MentionToken[] {
  const out: MentionToken[] = [];
  // A fresh regex per call: TOKEN is global and therefore stateful, and a shared lastIndex
  // between callers would silently skip tokens.
  const re = new RegExp(TOKEN.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    out.push({ name: m[1], userId: m[2], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** The distinct user ids mentioned in `body`. The input to the server's membership filter. */
export function mentionedUserIds(body: string): string[] {
  return [...new Set(parseMentions(body).map((t) => t.userId))];
}

/** Render a token as the composer writes it. Newlines/brackets in a name would break the token. */
export function mentionToken(name: string, userId: string): string {
  return `@[${name.replace(/[[\]\n]/g, ' ')}](${userId})`;
}

/**
 * The body as a human reads it — tokens collapsed to `@name`. Used anywhere the markup itself
 * would be noise rather than information: notification bodies, search, the audit payload.
 */
export function plainBody(body: string): string {
  return body.replace(new RegExp(TOKEN.source, 'g'), (_, name: string) => `@${name}`);
}
