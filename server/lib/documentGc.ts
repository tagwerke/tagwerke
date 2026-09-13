// Object cleanup for documents (DOCUMENTS_PLAN.md §6, §8).
//
// The bytes of a document live in a bucket, so Postgres FK cascade — which is what removes the
// ROWS — cannot reach them. Every path that destroys document rows has to delete the objects too,
// or the bucket grows forever with files nothing references and no one can see. Three such paths
// exist, and all of them come through here:
//
//   1. DELETE /api/tabs/:id      a board is hard-deleted; its documents cascade away
//   2. npm run erase-user        a sole-member board is deleted during erasure
//   3. npm run prune-audit       soft-deleted documents age out of Trash
//
// ORDER IS NOT NEGOTIABLE: delete the object first, the row second. A crash between the two leaks
// an object, which is invisible and cheap to sweep later. The reverse leaves a row pointing at
// nothing, which is a 500 on a download and looks to the user like their file was corrupted.

import { eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { blobstore } from './blobstore.ts';

/** Minimal logger shape — Fastify's in a request, console in a script. */
export interface GcLog {
  info(msg: string): void;
  warn(msg: string): void;
}

export interface PurgeResult {
  deleted: number;
  /** Keys we could not remove. Logged so an operator can clean up by hand. */
  failed: string[];
  /** True when object storage is not configured and the keys could not even be attempted. */
  skipped: boolean;
}

/**
 * Every storage key on a board, INCLUDING soft-deleted documents — a board being destroyed takes
 * its Trash with it, so anything still in the bucket for that board is about to be unreferenced.
 */
export async function storageKeysForBoard(tabId: string): Promise<string[]> {
  const rows = await db
    .select({ storageKey: schema.documents.storageKey })
    .from(schema.documents)
    .where(eq(schema.documents.tabId, tabId));
  return rows.map((r) => r.storageKey);
}

export async function storageKeysForBoards(tabIds: string[]): Promise<string[]> {
  if (tabIds.length === 0) return [];
  const rows = await db
    .select({ storageKey: schema.documents.storageKey })
    .from(schema.documents)
    .where(inArray(schema.documents.tabId, tabIds));
  return rows.map((r) => r.storageKey);
}

/**
 * Delete objects, best effort.
 *
 * Never throws. This runs AFTER the rows are gone, so there is nothing left to roll back and
 * failing the caller's request would be a lie — the delete already succeeded from the user's point
 * of view. Failures are returned and logged instead, because the only correct response to a leaked
 * object is an operator sweeping it, not a 500 on a board deletion.
 */
export async function purgeObjects(keys: string[], log?: GcLog): Promise<PurgeResult> {
  if (keys.length === 0) return { deleted: 0, failed: [], skipped: false };

  const store = blobstore();
  if (!store) {
    // Rows referencing objects exist but storage is unconfigured — the operator changed or removed
    // S3_* after uploading. Say so loudly: these keys are now unreachable from the app.
    log?.warn(
      `object storage is not configured — ${keys.length} object(s) could not be deleted and are now orphaned: ${keys.join(', ')}`,
    );
    return { deleted: 0, failed: [...keys], skipped: true };
  }

  const failed: string[] = [];
  for (const key of keys) {
    try {
      await store.delete(key);
    } catch {
      failed.push(key);
    }
  }
  if (failed.length > 0) {
    log?.warn(`failed to delete ${failed.length} object(s); sweep them by hand: ${failed.join(', ')}`);
  }
  return { deleted: keys.length - failed.length, failed, skipped: false };
}
