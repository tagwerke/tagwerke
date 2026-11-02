// A board's custom fields, for UI code (CUSTOM_FIELDS_PLAN P2.3). What a value may be is in
// shared/fields.ts with the server.

import { useStore } from '../store';
import { ApiError } from '../api/client';
import { MAX_FIELDS, type BoardField } from '../../shared/fields';
import type { ID } from '../types';

const NONE: readonly BoardField[] = [];

/** Every live field of the board (hidden included), in position order, as a hook so a component
 *  re-renders when an admin edits them. A board with no fields has none. */
export const useBoardFields = (tabId: ID | null | undefined): readonly BoardField[] =>
  useStore((s) => (tabId ? s.fieldsByBoard[tabId] : undefined) ?? NONE);

export const FIELD_TYPE_LABEL: Record<BoardField['type'], string> = {
  url: 'Link',
  email: 'Email',
  phone: 'Phone',
  number: 'Number',
  text: 'Text',
};

/** What each type is for, in the words the add-field forms use. */
export const FIELD_TYPE_HINT: Record<BoardField['type'], string> = {
  url: 'a web address; shows as a link.',
  email: 'an email address; opens your mail app.',
  phone: 'a phone number; tap to call.',
  number: 'a number, like a score or an amount.',
  text: 'a short line of text.',
};

/** What a refused field or column write means, in a sentence. */
export function fieldRefusal(e: unknown): string {
  const data = e instanceof ApiError ? e.data : undefined;
  if (data?.error === 'label_taken') return 'Another field already has that name.';
  if (data?.error === 'too_many_fields') return `A board can have at most ${MAX_FIELDS} fields.`;
  if (e instanceof ApiError && e.status === 403) return 'Only board admins can change fields and columns.';
  return 'Could not save the change.';
}
