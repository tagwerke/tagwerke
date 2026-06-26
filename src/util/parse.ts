export interface ExtractedMeta {
  text: string;
  date?: string; // no longer parsed from text (P0: dates via the date picker / `/due`)
  priority?: 1 | 2 | 3;
  owner?: string;
  done?: boolean;
}

// P0: `@` is retired as a date token — it now triggers the assignee picker (handled by the
// suggestion overlay, not here). Dates are set via the picker / `/due`. `[Name]` stays as a
// legacy free-text owner token for one release; assignment proper is via the `@` picker.
const OWNER_RE = /\[([A-Za-z][\w .'-]*)\]/g;
const PRIORITY_RE = /(?<![!\w])(!{1,3})(?!!)(?=\s|$)/;
const CHECKBOX_RE = /^\[([ xX])\]\s+/;

export function extractTokens(raw: string): ExtractedMeta {
  let text = raw;
  let priority: 1 | 2 | 3 | undefined;
  let owner: string | undefined;
  let done: boolean | undefined;

  // Strip a leading "- " (the task marker — typing - at start of an
  // already-task line just leaves literal "- " as prefix).
  text = text.replace(/^\s*-\s+/, '');

  const cb = text.match(CHECKBOX_RE);
  if (cb) {
    done = cb[1].toLowerCase() === 'x';
    text = text.slice(cb[0].length);
  }

  text = text.replace(OWNER_RE, (_m, name: string) => {
    owner = name.trim();
    return '';
  });

  const pm = text.match(PRIORITY_RE);
  if (pm) {
    priority = pm[1].length as 1 | 2 | 3;
    text = text.replace(PRIORITY_RE, '');
  }

  text = text.replace(/\s+/g, ' ').trim();

  return { text, priority, owner, done };
}

export function hasTokens(raw: string): boolean {
  return (
    /^\s*-\s+/.test(raw) ||
    OWNER_RE.test(raw) ||
    PRIORITY_RE.test(raw) ||
    CHECKBOX_RE.test(raw)
  );
}
