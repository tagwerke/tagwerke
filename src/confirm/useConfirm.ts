// Confirmation-dialog store. One app-wide dialog, rendered once in App next to CascadeToast and
// driven imperatively: `if (await askConfirm({...})) doTheThing()`.
//
// Imperative rather than per-call-site JSX because nearly every destructive action already sits
// inside an async handler (SharePanel/AdminConsole's `run(...)`), a keydown handler (EventCard),
// or a plain onClick that used to read `if (confirm(msg))` — threading open/close state through a
// dozen components to render a local dialog would be far more code than it saves.
//
// Rendering at the App root also keeps the dialog OUT of the DOM subtree of whatever opened it:
// SharePanel, SecurityPanel and TrashPanel each sit under a `.modal-backdrop` whose onClick closes
// the panel, so a dialog nested inside one would dismiss its own host on every click.
//
// A standalone Zustand store (like useNotifications / useSession) rather than part of RootState —
// this is ephemeral UI state and must survive a state hydrate/resync untouched.

import type { ReactNode } from 'react';
import { create } from 'zustand';

export interface ConfirmRequest {
  /** Short question, e.g. "Remove this member?" — rendered as the dialog heading. */
  title: string;
  /** What actually happens, including anything irreversible. Node so call sites can emphasise names. */
  body?: ReactNode;
  /** Label for the destructive button. Name the verb ("Remove", "Delete board") — never "OK". */
  confirmLabel?: string;
  cancelLabel?: string;
  /** Style the confirm button as destructive. Default true — that is what this dialog is for. */
  danger?: boolean;
}

interface Pending extends ConfirmRequest {
  resolve(ok: boolean): void;
}

interface ConfirmState {
  pending: Pending | null;
  request(req: ConfirmRequest): Promise<boolean>;
  /** Answer the open request and close. */
  settle(ok: boolean): void;
}

export const useConfirm = create<ConfirmState>((set, get) => ({
  pending: null,

  request(req) {
    // The dialog is modal, so a second request while one is open is a stray double-fire (a key
    // repeat, a double click). Decline it instead of replacing `pending` — overwriting would drop
    // the first request's resolve and strand that caller's promise forever.
    if (get().pending) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      set({ pending: { ...req, resolve } });
    });
  },

  settle(ok) {
    const p = get().pending;
    if (!p) return;
    set({ pending: null });
    p.resolve(ok);
  },
}));

/** Ask the user to confirm a destructive action. Resolves true ONLY on an explicit confirm —
 *  Escape, the Cancel button and a backdrop click all resolve false. */
export function askConfirm(req: ConfirmRequest): Promise<boolean> {
  return useConfirm.getState().request(req);
}
