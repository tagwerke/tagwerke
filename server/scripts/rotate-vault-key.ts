// Re-seal every board secret under the current VAULT_KEY (SECRET_LINKS_PLAN §5: rotation has a
// procedure before the first secret is stored).
//
// Procedure:
//   1. Generate a new key:            openssl rand -base64 32
//   2. Set VAULT_KEY=<new>  and  VAULT_KEY_PREVIOUS=<old>   (comma-separate several old keys)
//   3. Restart the app — it now reads old rows with the old key and writes new ones with the new key.
//   4. Run:                           npm run rotate-vault-key
//   5. When it reports 0 remaining, remove VAULT_KEY_PREVIOUS and restart.
//
// Each entry is re-sealed in its own transaction with a row lock, so this is safe to run against
// a live instance and safe to re-run: rows already under the current key are skipped.
//
// Secret links are NOT touched — they were never encrypted with VAULT_KEY (D1, the key is in the
// recipient's URL), so a vault rotation has nothing to do with them.

import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { db, pool, schema } from '../db/client.ts';
import { vaultStatus, seal, open, sealedKeyId, entryAad } from '../lib/vault.ts';

const FIELDS = [
  ['usernameEnc', 'username'],
  ['secretEnc', 'secret'],
  ['urlEnc', 'url'],
  ['notesEnc', 'notes'],
] as const;

const status = vaultStatus();
if (!status.ok) {
  console.error(`cannot rotate: ${status.detail}`);
  process.exit(1);
}
const current = status.keyId;
console.log(`re-sealing board secrets under key ${current}`);

const ids = await db.select({ id: schema.secretEntries.id }).from(schema.secretEntries);
let resealed = 0;
let failed = 0;

for (const { id } of ids) {
  try {
    await db.transaction(async (tx) => {
      const [r] = await tx.select().from(schema.secretEntries).where(eq(schema.secretEntries.id, id)).for('update');
      if (!r) return;
      const set: Record<string, string> = {};
      for (const [col, field] of FIELDS) {
        const v = r[col];
        if (v == null || sealedKeyId(v) === current) continue;
        const aad = entryAad(r.tabId, r.id, field);
        set[col] = seal(open(v, aad), aad);
      }
      if (Object.keys(set).length) {
        await tx.update(schema.secretEntries).set(set).where(eq(schema.secretEntries.id, id));
        resealed++;
      }
    });
  } catch (err) {
    failed++;
    console.error(`  entry ${id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const left = (await db.select().from(schema.secretEntries)).filter((r) =>
  FIELDS.some(([col]) => r[col] != null && sealedKeyId(r[col]!) !== current),
).length;

console.log(`re-sealed ${resealed} entr${resealed === 1 ? 'y' : 'ies'}, ${failed} failed, ${left} remaining under an old key`);
if (!left) console.log('done — VAULT_KEY_PREVIOUS can now be removed');
await pool.end();
process.exit(failed || left ? 1 : 0);
