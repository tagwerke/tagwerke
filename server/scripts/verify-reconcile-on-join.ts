/**
 * Verifies the board-open ref repair (NOTES_SPLIT_PLAN §N1.4).
 *
 * Four properties, checked against a real database and the real `ydocJoin` — a stub socket is the
 * only fake, since the join path only ever calls `send` on it:
 *
 *   1. REPAIR      a live root row with no ref in the document gains one when the board is opened.
 *   2. ONCE/LOAD   a second join on the same resident room does NOT reconcile again.
 *   3. PER LOAD    once the room is released and reloaded, it reconciles again — so a task added
 *                  in between is picked up on the next open.
 *   4. SEED GUARD  a room still waiting to be seeded (legacy docJSON, no ydoc_state) is left
 *                  alone. Reconciling it would append a ref per live row to an empty document
 *                  that the client is about to replace wholesale, duplicating every task.
 *
 * Writes to whatever DATABASE_URL points at, under ids prefixed `vrj_`, and deletes them again.
 * Run against the dev database only.
 */
import 'dotenv/config';
import * as Y from 'yjs';
import { eq, inArray } from 'drizzle-orm';
import type { WebSocket } from 'ws';
import { db, schema } from '../db/client.ts';
import { ydocJoin, ydocLeave } from '../realtime/ydoc.ts';
import { rankSequence } from '../../shared/rank.ts';

const FRAGMENT = 'default';
const BOARD_A = 'vrj_board_a';
const BOARD_B = 'vrj_board_b';
const [RANK_1, RANK_2] = rankSequence(2);

/** The join path only ever calls `send`; nothing reads from the socket. */
function stubWs(): WebSocket {
  return { send() {} } as unknown as WebSocket;
}

/** Base64 Yjs state for a document holding one paragraph of prose and no task refs. */
function proseOnlyState(text: string): string {
  const doc = new Y.Doc();
  const para = new Y.XmlElement('paragraph');
  para.insert(0, [new Y.XmlText(text)]);
  doc.getXmlFragment(FRAGMENT).insert(0, [para]);
  return Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64');
}

/** Every taskItem id in a persisted state, in document order. */
function refIdsIn(stateB64: string | null): string[] {
  if (!stateB64) return [];
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(Buffer.from(stateB64, 'base64')));
  const out: string[] = [];
  const walk = (node: Y.XmlElement | Y.XmlFragment): void => {
    for (let i = 0; i < node.length; i++) {
      const child = node.get(i);
      if (!(child instanceof Y.XmlElement)) continue;
      if (child.nodeName === 'taskItem') out.push(child.getAttribute('id') ?? '(no id)');
      else walk(child);
    }
  };
  walk(doc.getXmlFragment(FRAGMENT));
  return out;
}

async function storedRefs(tabId: string): Promise<string[]> {
  const row = (
    await db.select({ s: schema.tabs.ydocState }).from(schema.tabs).where(eq(schema.tabs.id, tabId)).limit(1)
  )[0];
  return refIdsIn(row?.s ?? null);
}

/** Reconcile is fired but not awaited by the join, so give it a beat to land. */
function settle(): Promise<void> {
  return new Promise((r) => setTimeout(r, 600));
}

let failures = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function cleanup(): Promise<void> {
  await db.delete(schema.tasks).where(inArray(schema.tasks.homeTabId, [BOARD_A, BOARD_B]));
  await db.delete(schema.tabs).where(inArray(schema.tabs.id, [BOARD_A, BOARD_B]));
}

async function main(): Promise<void> {
  await cleanup();

  // ── Board A: a real, previously-persisted document with prose and no refs ──────────────
  await db.insert(schema.tabs).values({
    id: BOARD_A,
    name: 'verify reconcile on join',
    ydocState: proseOnlyState('Some prose that was already here.'),
  });
  await db.insert(schema.tasks).values({
    id: 'vrj_t1', homeTabId: BOARD_A, text: 'created while no editor was mounted', rank: RANK_1,
  });

  check('board A starts with no refs', (await storedRefs(BOARD_A)).length === 0, '');

  const wsA1 = stubWs();
  await ydocJoin(BOARD_A, wsA1, true);
  await settle();
  const afterFirst = await storedRefs(BOARD_A);
  check('1. REPAIR — the missing ref is written on open',
    afterFirst.length === 1 && afterFirst[0] === 'vrj_t1', `refs=[${afterFirst}]`);

  // A task added while the room is already resident.
  await db.insert(schema.tasks).values({
    id: 'vrj_t2', homeTabId: BOARD_A, text: 'added while the room was live', rank: RANK_2,
  });

  const wsA2 = stubWs();
  await ydocJoin(BOARD_A, wsA2, true);
  await settle();
  const afterSecond = await storedRefs(BOARD_A);
  check('2. ONCE PER LOAD — a second join does not reconcile again',
    !afterSecond.includes('vrj_t2'), `refs=[${afterSecond}]`);

  // Release the room (last one out flushes and destroys it), then reopen.
  await ydocLeave(BOARD_A, wsA1);
  await ydocLeave(BOARD_A, wsA2);
  const wsA3 = stubWs();
  await ydocJoin(BOARD_A, wsA3, true);
  await settle();
  const afterReload = await storedRefs(BOARD_A);
  check('3. PER LOAD — reopening the board picks up the newer task',
    afterReload.includes('vrj_t1') && afterReload.includes('vrj_t2'), `refs=[${afterReload}]`);
  await ydocLeave(BOARD_A, wsA3);

  // ── Board B: mid-seed. Legacy docJSON, no ydoc_state — the client is about to fill it. ──
  await db.insert(schema.tabs).values({
    id: BOARD_B,
    name: 'verify seed guard',
    docJSON: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'legacy' }] }] },
    ydocState: null,
  });
  await db.insert(schema.tasks).values({
    id: 'vrj_t3', homeTabId: BOARD_B, text: 'must not get a ref yet', rank: RANK_1,
  });

  const wsB = stubWs();
  await ydocJoin(BOARD_B, wsB, true);
  await settle();
  const boardBRow = (
    await db.select({ s: schema.tabs.ydocState }).from(schema.tabs).where(eq(schema.tabs.id, BOARD_B)).limit(1)
  )[0];
  check('4. SEED GUARD — a mid-seed room is left untouched',
    boardBRow?.s == null && refIdsIn(boardBRow?.s ?? null).length === 0,
    boardBRow?.s == null ? 'ydoc_state still NULL' : `refs=[${refIdsIn(boardBRow.s)}]`);
  await ydocLeave(BOARD_B, wsB);

  await cleanup();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  void cleanup().finally(() => process.exit(1));
});
