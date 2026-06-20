import { db } from '../db/client.ts';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Persist a new ordering by writing each id's array index as its position.
 * Owns the transaction + index loop; `updateAt` runs the table-specific UPDATE
 * (which table, which position column, how rows are scoped) for one (id, index).
 */
export async function reorderByIndex(
  order: string[],
  updateAt: (tx: Tx, id: string, index: number) => Promise<unknown>,
): Promise<void> {
  await db.transaction(async (tx) => {
    for (let i = 0; i < order.length; i++) {
      await updateAt(tx, order[i], i);
    }
  });
}
