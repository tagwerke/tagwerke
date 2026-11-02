// A board's custom fields, for UI code (CUSTOM_FIELDS_PLAN P2.3). What a value may be is in
// shared/fields.ts with the server.

import { useStore } from '../store';
import { ApiError } from '../api/client';
import { MAX_FIELDS, normalizeValue, phoneHref, urlLabel, type BoardField, type FieldType, type FieldValue } from '../../shared/fields';
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

/** Where a value of a link-like field goes, and how it reads; null for a plain value. */
export function fieldLink(type: FieldType, raw: string): { href: string; text: string } | null {
  if (!raw) return null;
  if (type === 'url') return { href: raw, text: urlLabel(raw) };
  if (type === 'email') return { href: `mailto:${raw}`, text: raw };
  if (type === 'phone') return { href: phoneHref(raw), text: raw };
  return null;
}

/** The input type that brings up the right keyboard on a phone. */
export const FIELD_INPUT_TYPE: Record<FieldType, string> = { url: 'url', email: 'email', phone: 'tel', number: 'text', text: 'text' };

/**
 * What typed text sets a field to, by the server's own rules: the value, null to clear it, or
 * undefined when the text is not a valid value of the field's type. A number takes a comma as the
 * decimal point too.
 */
export function parseFieldInput(type: FieldType, text: string): FieldValue | null | undefined {
  const input = type === 'number' ? (text.trim() ? Number(text.replace(',', '.')) : null) : text;
  return normalizeValue(type, input);
}

/** The toast for a value the field's type refuses. */
export const invalidFieldMessage = (field: BoardField): string =>
  `That isn’t a valid ${FIELD_TYPE_LABEL[field.type].toLowerCase()}, so “${field.label}” wasn’t changed.`;
