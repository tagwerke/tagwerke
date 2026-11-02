// Per-board task states (BOARD_STATES_PLAN.md). Every route that writes a task status goes
// through resolveStatus here, so the rules for what a status may be live in one place.
//
// The list is cached per board in process memory (the bus is in-process too, so there is no
// second process to keep in step) and dropped on every state write.

import { nanoid } from 'nanoid';
import { asc, eq } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import {
  CATEGORY_DEFAULT_COLOR, DEFAULT_LABEL, DEFAULT_STATES, MAX_STATES, REQUIRED_CATEGORIES, STATE_COLORS, STATUS_CATEGORIES,
  nextSameCategory, visible, type BoardState, type StatusCategory,
} from '../../shared/status.ts';
import { slugKey } from '../../shared/fields.ts';
import type { FieldChange } from './audit.ts';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** A board's state row, tombstone or not. */
export type StateRow = BoardState & { deletedAt: Date | null };

const cache = new Map<string, StateRow[]>();

/** Every state of the board, tombstones included, in position order. */
export async function statesOf(tabId: string): Promise<StateRow[]> {
  const hit = cache.get(tabId);
  if (hit) return hit;
  const rows = await db
    .select({
      key: schema.boardStates.key,
      label: schema.boardStates.label,
      description: schema.boardStates.description,
      category: schema.boardStates.category,
      color: schema.boardStates.color,
      position: schema.boardStates.position,
      hidden: schema.boardStates.hidden,
      deletedAt: schema.boardStates.deletedAt,
    })
    .from(schema.boardStates)
    .where(eq(schema.boardStates.tabId, tabId))
    .orderBy(asc(schema.boardStates.position));
  const list = rows.map((r) => ({ ...r, category: r.category as StatusCategory }));
  cache.set(tabId, list);
  return list;
}

/** The live states (visible and hidden), what clients and the editor work with. */
export const liveStates = async (tabId: string): Promise<BoardState[]> =>
  (await statesOf(tabId))
    .filter((s) => !s.deletedAt)
    .map((s) => ({ key: s.key, label: s.label, description: s.description, category: s.category, color: s.color, position: s.position, hidden: s.hidden }));

export function invalidate(tabId: string): void {
  cache.delete(tabId);
}

/** Give a new board the six default states. Call inside the transaction that creates it. */
export async function seedBoardStates(tx: Tx | typeof db, tabId: string): Promise<void> {
  await tx.insert(schema.boardStates).values(
    DEFAULT_STATES.map((s) => ({
      id: nanoid(),
      tabId,
      key: s.key,
      label: s.label,
      description: s.description,
      category: s.category,
      color: s.color,
      position: s.position,
    })),
  );
  invalidate(tabId);
}

/** A state as a board template gives it (CUSTOM_FIELDS_PLAN P3), before validation. */
export interface StateInput {
  key?: string;
  label: string;
  category: string;
  color?: string;
  description?: string | null;
}

const STATE_KEY = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * A board template's states, checked by the rules the states panel enforces (a visible `open` and
 * `done` state, at most MAX_STATES, unique names), or the reason they can't be. Keys come from the
 * input or the label, so boards made from one template share keys and a move between them needs no
 * mapping.
 */
export function planStates(inputs: readonly StateInput[]): { ok: true; states: BoardState[] } | { ok: false; body: unknown } {
  if (!inputs.length || inputs.length > MAX_STATES) return { ok: false, body: { error: 'too_many_states', max: MAX_STATES } };
  const keys = new Set<string>();
  const labels = new Set<string>();
  const states: BoardState[] = [];
  for (const [position, input] of inputs.entries()) {
    const label = input.label.trim();
    if (!label || label.length > 40) return { ok: false, body: { error: 'invalid_label' } };
    if (labels.has(label.toLowerCase())) return { ok: false, body: { error: 'label_taken', label } };
    if (!(STATUS_CATEGORIES as readonly string[]).includes(input.category)) return { ok: false, body: { error: 'invalid_category', valid: STATUS_CATEGORIES } };
    const category = input.category as StatusCategory;
    if (input.color !== undefined && !(STATE_COLORS as readonly string[]).includes(input.color)) return { ok: false, body: { error: 'invalid_color', valid: STATE_COLORS } };
    const description = input.description?.trim() || null;
    if (description && description.length > 200) return { ok: false, body: { error: 'invalid_description' } };
    const key = input.key ?? slugKey(label);
    if (!STATE_KEY.test(key)) return { ok: false, body: { error: 'invalid_key', key } };
    if (keys.has(key)) return { ok: false, body: { error: 'key_taken', key } };
    keys.add(key);
    labels.add(label.toLowerCase());
    states.push({ key, label, description, category, color: input.color ?? CATEGORY_DEFAULT_COLOR[category], position, hidden: false });
  }
  const missing = REQUIRED_CATEGORIES.find((c) => !states.some((s) => s.category === c));
  if (missing) return { ok: false, body: { error: 'required_category', category: missing } };
  return { ok: true, states };
}

/** Give a new board the states a template planned. Call inside the transaction that creates it. */
export async function insertBoardStates(tx: Tx | typeof db, tabId: string, states: readonly BoardState[]): Promise<void> {
  await tx.insert(schema.boardStates).values(states.map((s) => ({ id: nanoid(), tabId, ...s })));
  invalidate(tabId);
}

/**
 * What a write of `key` to a task on this board actually stores.
 *   - a live state (hidden or not) → itself
 *   - a deleted state (an offline queue, an old client; D8) → the next visible state of the same
 *     category, else the start state, with `remapped: true`
 *   - a key that never existed on the board → null; the route answers 400 with the valid keys
 */
export async function resolveStatus(tabId: string, key: string): Promise<{ key: string; remapped: boolean } | null> {
  const states = await statesOf(tabId);
  const row = states.find((s) => s.key === key);
  if (!row) return null;
  if (!row.deletedAt) return { key, remapped: false };
  const live = states.filter((s) => !s.deletedAt);
  return { key: nextSameCategory([...live, row], key), remapped: true };
}

/** The 400 body for a status the board doesn't have. */
export async function unknownStatusBody(tabId: string) {
  const states = visible((await statesOf(tabId)).filter((s) => !s.deletedAt));
  return { error: 'unknown_status', valid: states.map((s) => ({ key: s.key, label: s.label, category: s.category })) };
}

/** The label a key has on this board right now, tombstones included. */
export async function labelOf(tabId: string, key: string): Promise<string> {
  return (await statesOf(tabId)).find((s) => s.key === key)?.label ?? DEFAULT_LABEL[key] ?? key;
}

/** Snapshot the labels into any status change (D10): history shows the name a state had when the
 *  change happened, not whatever it is called today. */
export async function withStatusLabels(tabId: string, changes: FieldChange[]): Promise<FieldChange[]> {
  if (!changes.some((c) => c.field === 'status')) return changes;
  return Promise.all(
    changes.map(async (c) =>
      c.field !== 'status'
        ? c
        : {
            ...c,
            ...(typeof c.from === 'string' ? { fromLabel: await labelOf(tabId, c.from) } : {}),
            ...(typeof c.to === 'string' ? { toLabel: await labelOf(tabId, c.to) } : {}),
          },
    ),
  );
}
