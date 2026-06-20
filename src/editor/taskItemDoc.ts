// Shared ProseMirror helpers for taskItem nodes: the inner-paragraph range math
// and the on-commit token stripping that SyncPlugin and TodaySyncPlugin both run.

import type { Node as PMNode, Schema } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import { extractTokens, hasTokens } from '../util/parse';

export interface StripOp {
  from: number;
  to: number;
  insert: string;
}

/**
 * Text range of a taskItem's inner paragraph content. `+2` skips the taskItem
 * and paragraph open tokens; the upper bound stops before the paragraph close.
 */
export function taskItemInnerRange(taskItemPos: number, para: PMNode): { from: number; to: number } {
  return { from: taskItemPos + 2, to: taskItemPos + 1 + para.nodeSize - 1 };
}

/** Token-strip op for one committed line, or null when there is nothing to strip. */
export function stripOpForLine(taskItemPos: number, rawText: string, doc: PMNode): StripOp | null {
  if (!hasTokens(rawText)) return null;
  const parsed = extractTokens(rawText);
  if (parsed.text === rawText) return null;
  const para = doc.nodeAt(taskItemPos)?.firstChild;
  if (!para) return null;
  return { ...taskItemInnerRange(taskItemPos, para), insert: parsed.text };
}

/** Apply strip ops back-to-front so earlier positions stay valid as text shrinks. */
export function applyStripOps(tr: Transaction, ops: StripOp[], schema: Schema): void {
  ops.sort((a, b) => b.from - a.from);
  for (const op of ops) {
    tr.replaceWith(op.from, op.to, op.insert ? schema.text(op.insert) : []);
  }
}
