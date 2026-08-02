// Toast store — a one-line, self-dismissing notice for something that ALREADY happened.
//
// Distinct from useConfirm (which asks before) and from the cascade offer (which proposes a
// follow-up action): this only reports. It exists because some operations do more than the user
// literally asked for and have to say so — a cross-board move that drops assignments the
// destination board's roster cannot hold is the first of them, and "we quietly unassigned
// someone's work" is not a thing to leave to the audit log alone.
//
// A standalone Zustand store, like useConfirm / useNotifications: ephemeral UI state that must
// survive a state hydrate/resync untouched.

import { create } from 'zustand';

interface ToastState {
  /** Bumped per message, so an identical repeat still restarts the dismiss timer. */
  seq: number;
  message: string | null;
  show(message: string): void;
  dismiss(): void;
}

export const useToast = create<ToastState>((set, get) => ({
  seq: 0,
  message: null,
  show(message) {
    set({ message, seq: get().seq + 1 });
  },
  dismiss() {
    set({ message: null });
  },
}));

/** Report something that just happened. Replaces any notice still on screen. */
export function showToast(message: string): void {
  useToast.getState().show(message);
}
