// Per-board custom fields (CUSTOM_FIELDS_PLAN.md). Every route that writes a task's field values
// goes through resolveFieldWrite here, so the rules for what a value may be live in one place.
//
// The list is cached per board in process memory (the bus is in-process too, so there is no second
// process to keep in step) and dropped on every field write. Same shape as lib/boardStates.ts.

import { nanoid } from 'nanoid';
import { asc, eq, sql } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { FIELD_KEY, FIELD_TYPES, MAX_FIELDS, normalizeValue, slugKey, type BoardField, type FieldType, type FieldValue, type FieldValues } from '../../shared/fields.ts';
import type { FieldChange } from './audit.ts';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** A board's field row, tombstone or not. */
export type FieldRow = BoardField & { deletedAt: Date | null };

const cache = new Map<string, FieldRow[]>();

/** Every field of the board, tombstones included, in position order. */
export async function fieldsOf(tabId: string): Promise<FieldRow[]> {
  const hit = cache.get(tabId);
  if (hit) return hit;
  const rows = await db
    .select({
      key: schema.boardFields.key,
      label: schema.boardFields.label,
      type: schema.boardFields.type,
      position: schema.boardFields.position,
      hidden: schema.boardFields.hidden,
      deletedAt: schema.boardFields.deletedAt,
    })
    .from(schema.boardFields)
    .where(eq(schema.boardFields.tabId, tabId))
    .orderBy(asc(schema.boardFields.position));
  const list = rows.map((r) => ({ ...r, type: r.type as FieldType }));
  cache.set(tabId, list);
  return list;
}

/** The live fields (visible and hidden): what clients show and what values may be written to. */
export const liveFields = async (tabId: string): Promise<BoardField[]> =>
  (await fieldsOf(tabId))
    .filter((f) => !f.deletedAt)
    .map((f) => ({ key: f.key, label: f.label, type: f.type, position: f.position, hidden: f.hidden }));

export function invalidate(tabId: string): void {
  cache.delete(tabId);
}

/** The 400 body for a key the board has no live field for. */
async function unknownFieldBody(tabId: string) {
  return { error: 'unknown_field', valid: (await liveFields(tabId)).map((f) => ({ key: f.key, label: f.label, type: f.type })) };
}

/**
 * What a write of `patch` to a task on this board stores (D5): `set` holds the values to write,
 * `removed` the keys a null clears. A key with no live field → 400 `unknown_field` with the valid
 * list; a value its type refuses → 400 `invalid_field` naming the key and type.
 */
export async function resolveFieldWrite(
  tabId: string,
  patch: Record<string, unknown>,
): Promise<{ ok: true; set: FieldValues; removed: string[] } | { ok: false; body: unknown }> {
  const live = await liveFields(tabId);
  const set: FieldValues = {};
  const removed: string[] = [];
  for (const [key, raw] of Object.entries(patch)) {
    const field = live.find((f) => f.key === key);
    if (!field) return { ok: false, body: await unknownFieldBody(tabId) };
    const value = normalizeValue(field.type, raw);
    if (value === undefined) return { ok: false, body: { error: 'invalid_field', key, type: field.type } };
    if (value === null) removed.push(key);
    else set[key] = value;
  }
  return { ok: true, set, removed };
}

/**
 * A field write (D5) as ONE expression over the stored object: set keys merged in, removed keys
 * taken out. Done in SQL rather than read-modify-write so two people editing different fields of the
 * same task at once both land.
 */
export function mergeFieldsSql(write: { set: FieldValues; removed: string[] }) {
  return sql`(${schema.tasks.fields} || ${JSON.stringify(write.set)}::jsonb)${sql.join(write.removed.map((k) => sql` - ${k}::text`), sql``)}`;
}

/**
 * One change per key that differs between two `fields` objects, each named `fields.<key>` and
 * carrying the field's label at the time (D8), so history reads "Website" even after a rename.
 */
export async function fieldChanges(tabId: string, before: FieldValues, after: FieldValues): Promise<FieldChange[]> {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const changed = keys.filter((k) => (before[k] ?? null) !== (after[k] ?? null));
  if (!changed.length) return [];
  const defs = await fieldsOf(tabId);
  return changed.map((k) => ({
    field: `fields.${k}`,
    from: before[k] ?? null,
    to: after[k] ?? null,
    label: defs.find((f) => f.key === k)?.label ?? k,
  }));
}

/**
 * Which of `values` a board can hold (D7): a value carries over when the board has a live field with
 * the same key AND the same type, as the field it came from.
 */
export function carryFields(values: FieldValues, from: readonly BoardField[], to: readonly BoardField[]): { kept: FieldValues; dropped: string[] } {
  const kept: FieldValues = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    const source = from.find((f) => f.key === key);
    const dest = to.find((f) => f.key === key);
    if (source && dest && source.type === dest.type) kept[key] = value;
    else dropped.push(key);
  }
  return { kept, dropped };
}

/** A field definition as an API writer sends it, before validation. */
export interface FieldInput {
  key?: string;
  label: string;
  type: string;
}

/**
 * The definitions to insert for `inputs`, appended after `existing` (tombstones included, so a
 * deleted key is never reused), or the reason they can't be. Keys come from the input or the label.
 */
export function planFields(
  existing: readonly Pick<FieldRow, 'key' | 'label' | 'position' | 'deletedAt'>[],
  inputs: readonly FieldInput[],
): { ok: true; fields: BoardField[] } | { ok: false; body: unknown } {
  const live = existing.filter((f) => !f.deletedAt);
  if (live.length + inputs.length > MAX_FIELDS) return { ok: false, body: { error: 'too_many_fields', max: MAX_FIELDS } };
  const keys = new Set(existing.map((f) => f.key));
  const labels = new Set(live.map((f) => f.label.toLowerCase()));
  let position = existing.reduce((max, f) => Math.max(max, f.position), -1) + 1;
  const fields: BoardField[] = [];
  for (const input of inputs) {
    const label = input.label.trim();
    if (!label || label.length > 40) return { ok: false, body: { error: 'invalid_label' } };
    if (labels.has(label.toLowerCase())) return { ok: false, body: { error: 'label_taken', label } };
    if (!(FIELD_TYPES as readonly string[]).includes(input.type)) return { ok: false, body: { error: 'invalid_type', valid: FIELD_TYPES } };
    let key = input.key ?? slugKey(label);
    if (!FIELD_KEY.test(key)) return { ok: false, body: { error: 'invalid_key', key } };
    if (keys.has(key)) {
      // An explicit key must be free; a derived one gets a numeric suffix.
      if (input.key) return { ok: false, body: { error: 'key_taken', key } };
      const base = key.slice(0, 37);
      let n = 2;
      while (keys.has(`${base}_${n}`)) n++;
      key = `${base}_${n}`;
    }
    keys.add(key);
    labels.add(label.toLowerCase());
    fields.push({ key, label, type: input.type as FieldType, position: position++, hidden: false });
  }
  return { ok: true, fields };
}

/** Insert planned definitions. Call inside the transaction that needs them. */
export async function insertBoardFields(tx: Tx | typeof db, tabId: string, fields: readonly BoardField[]): Promise<void> {
  if (!fields.length) return;
  await tx.insert(schema.boardFields).values(fields.map((f) => ({ id: nanoid(), tabId, ...f })));
  invalidate(tabId);
}

/** A stored value read back out of a row, for code that only wants the object. */
export const valuesOf = (fields: unknown): FieldValues => (fields && typeof fields === 'object' ? (fields as Record<string, FieldValue>) : {});
