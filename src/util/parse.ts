import { resolveDateKeyword } from './dates';

export interface ExtractedMeta {
  text: string;
  date?: string;
  priority?: 1 | 2 | 3;
  owner?: string;
  done?: boolean;
}

const DATE_RE = /@([A-Za-z]+|\d{4}-\d{2}-\d{2})/g;
const OWNER_RE = /\[([A-Za-z][\w .'-]*)\]/g;
const PRIORITY_RE = /(?<![!\w])(!{1,3})(?!!)(?=\s|$)/;
const CHECKBOX_RE = /^\[([ xX])\]\s+/;

export function extractTokens(raw: string, now = new Date()): ExtractedMeta {
  let text = raw;
  let date: string | undefined;
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

  text = text.replace(DATE_RE, (_m, captured: string) => {
    const resolved = resolveDateKeyword(captured, now);
    if (resolved) {
      date = resolved;
      return '';
    }
    return _m;
  });

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

  return { text, date, priority, owner, done };
}

export function hasTokens(raw: string): boolean {
  return (
    /^\s*-\s+/.test(raw) ||
    DATE_RE.test(raw) ||
    OWNER_RE.test(raw) ||
    PRIORITY_RE.test(raw) ||
    CHECKBOX_RE.test(raw)
  );
}
