// Run a request that may answer `401 sudo required`: ask for the step-up, then retry once. Token
// creation needs a fresh sign-in (PAT_PLAN D5). Returns `undefined` when the user cancels the prompt.
// The same reactive shape the secrets view uses; `dialog` must be rendered by the caller.

import { useCallback, useState, type ReactNode } from 'react';
import { ApiError } from '../../api/client';
import { StepUpDialog } from '../secrets/StepUpDialog';

const isSudoRequired = (e: unknown) => e instanceof ApiError && e.status === 401 && e.data?.error === 'sudo required';

export function useStepUpRun(): { run: <T>(fn: () => Promise<T>) => Promise<T | undefined>; dialog: ReactNode } {
  const [stepUp, setStepUp] = useState<((ok: boolean) => void) | null>(null);

  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (err) {
      if (!isSudoRequired(err)) throw err;
    }
    const ok = await new Promise<boolean>((resolve) => setStepUp(() => resolve));
    setStepUp(null);
    if (!ok) return undefined;
    return fn();
  }, []);

  const dialog = stepUp ? <StepUpDialog reason="Creating an access token needs a fresh sign-in. This lasts ten minutes." onDone={stepUp} /> : null;
  return { run, dialog };
}

/** A copy of `set` with `v` added, or removed if it was there. */
export function toggled<T>(set: Set<T>, v: T): Set<T> {
  const next = new Set(set);
  if (next.has(v)) next.delete(v);
  else next.add(v);
  return next;
}

/** The server's message for a failed token request, without the `METHOD /path -> 400` prefix. */
export function tokenError(err: unknown): string {
  if (err instanceof ApiError) return err.data?.error ?? `Request failed (${err.status})`;
  return 'Something went wrong';
}
