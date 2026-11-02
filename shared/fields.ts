// Custom fields, shared by client and server (CUSTOM_FIELDS_PLAN.md).
//
// Each board defines its own fields (the `board_fields` table), the same way it defines its states:
// an immutable KEY (what a task's `fields` object is keyed by, and what an API writer sends), an
// editable LABEL, and a TYPE fixed at creation. A task stores only the values that are set; an
// absent key is an empty field.
//
// Validation lives here so the client refuses a bad value before it reaches the outbox, by the same
// rules the server applies.

export const FIELD_TYPES = ['url', 'email', 'phone', 'number', 'text'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** Most live fields a board may have. */
export const MAX_FIELDS = 20;

/** A field key: a readable slug, unique on its board (D3). */
export const FIELD_KEY = /^[a-z][a-z0-9_]{0,39}$/;

export interface BoardField {
  key: string;
  label: string;
  type: FieldType;
  position: number;
  hidden: boolean;
}

export type FieldValue = string | number;
export type FieldValues = Record<string, FieldValue>;

const MAX_LENGTH: Record<Exclude<FieldType, 'number'>, number> = { url: 2048, email: 320, phone: 40, text: 500 };

/** The key a label gives: "Site quality" → `site_quality`. Never empty, always a valid key. */
export function slugKey(label: string): string {
  const slug = label
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  if (!slug) return 'field';
  return /^[a-z]/.test(slug) ? slug : `f_${slug}`.slice(0, 40);
}

/**
 * What a value of this type stores, or `undefined` when it is not one. An empty or blank string is
 * `null`: it means "no value", the same as sending null.
 */
export function normalizeValue(type: FieldType, v: unknown): FieldValue | null | undefined {
  if (v === null) return null;
  if (type === 'number') return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (!s) return null;
  if (s.length > MAX_LENGTH[type]) return undefined;
  if (type === 'url') {
    try {
      const u = new URL(s);
      return u.protocol === 'http:' || u.protocol === 'https:' ? s : undefined;
    } catch {
      return undefined;
    }
  }
  if (type === 'email') return /^[^\s@]+@[^\s@]+$/.test(s) ? s : undefined;
  if (type === 'phone') return /^[0-9+()\-. ]+$/.test(s) && (s.match(/[0-9]/g) ?? []).length >= 3 ? s : undefined;
  return s;
}

/** The `tel:` href of a phone value: digits and `+` only. */
export const phoneHref = (v: string): string => `tel:${v.replace(/[^0-9+]/g, '')}`;

/** A URL value as people read it: the hostname, without `www.`. */
export function urlLabel(v: string): string {
  try {
    return new URL(v).hostname.replace(/^www\./, '');
  } catch {
    return v;
  }
}

// ── Table columns (CUSTOM_FIELDS_PLAN P4) ──────────────────────────────────────────────────────
//
// A board's table shows the columns its `tabs.table_columns` lists, in that order, the same for
// everyone on the board. Select, Title and the open button are always there and never listed. A
// field's column is `f:<key>`.

/** The built-in columns a board can show, hide and reorder. */
export const BUILTIN_COLUMNS = ['status', 'assignee', 'due', 'priority', 'sprint', 'parent'] as const;
export type BuiltinColumn = (typeof BUILTIN_COLUMNS)[number];

/** What a new board's table shows. */
export const DEFAULT_COLUMNS: string[] = [...BUILTIN_COLUMNS];

/** The column id of a field. */
export const fieldColumn = (key: string): string => `f:${key}`;

/** The field key a column id names, or null for a built-in. */
export const columnFieldKey = (id: string): string | null => (id.startsWith('f:') ? id.slice(2) : null);
