// Board settings › Secrets access (board admins only): which networks this board's secrets can be
// opened from. The editor is the Secrets view's own PolicyDialog; this section is where the policy
// is found without opening the secrets themselves.
//
// It reads the policy from the secrets list, which only answers from an allowed network — so from
// anywhere else this says where you are connecting from instead, the same way the Secrets view does.

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../api/client';
import { PolicyDialog } from '../secrets/SecretDialogs';
import { useStepUpRun } from '../tokens/useStepUpRun';
import { Section } from '../common/Section';
import { EmptyState, Loading } from '../common/EmptyState';
import type { ID } from '../../types';

type Load =
  | { kind: 'loading' }
  | { kind: 'ready'; cidrs: string[]; clientIp: string }
  | { kind: 'off' }
  | { kind: 'blocked'; ip?: string }
  | { kind: 'error'; message: string };

export function SecretsAccessSection({ tabId }: { tabId: ID }) {
  const { run, dialog } = useStepUpRun('Changing which networks can open secrets needs a fresh sign-in. This lasts ten minutes.');
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [editing, setEditing] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = await api.secrets.list(tabId);
      setLoad({ kind: 'ready', cidrs: r.policy.allowedCidrs, clientIp: r.clientIp });
    } catch (err) {
      if (err instanceof ApiError && err.data?.code === 'vault_off') setLoad({ kind: 'off' });
      else if (err instanceof ApiError && err.data?.code === 'ip_not_allowed') setLoad({ kind: 'blocked', ip: err.data.ip as string | undefined });
      else setLoad({ kind: 'error', message: err instanceof ApiError ? err.data?.error ?? `Request failed (${err.status})` : 'Something went wrong' });
    }
  }, [tabId]);

  useEffect(() => {
    // Fetch-on-mount; every setState in refresh() lands after an await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  return (
    <Section
      title="Secrets access"
      description="The networks this board’s secrets can be opened from. Only admins can open them, and every reveal asks them to confirm it’s them."
    >
      {load.kind === 'loading' && <Loading as="p" />}
      {load.kind === 'off' && <p className="section-desc">Secrets aren’t enabled on this instance.</p>}
      {load.kind === 'blocked' && (
        <p className="section-desc">
          You’re connecting from <code>{load.ip ?? 'an address that isn’t on the list'}</code>, which isn’t on this
          board’s list, so its networks can only be changed from one that is.
        </p>
      )}
      {load.kind === 'error' && <p className="section-desc">{load.message}</p>}
      {load.kind === 'ready' && (
        <>
          <ul className="share-members">
            {load.cidrs.map((c) => (
              <li key={c} className="list-row"><code>{c}</code></li>
            ))}
            {load.cidrs.length === 0 && <EmptyState as="li">Any network.</EmptyState>}
          </ul>
          <p className="section-desc">You’re connecting from <code>{load.clientIp || 'an unknown address'}</code>.</p>
          <button type="button" className="btn ghost tiny security-act" onClick={() => setEditing(true)}>Edit networks</button>
          {editing && (
            <PolicyDialog
              boardId={tabId}
              current={load.cidrs}
              clientIp={load.clientIp}
              run={run}
              onClose={() => setEditing(false)}
              onSaved={(cidrs) => {
                setLoad({ ...load, cidrs });
                setEditing(false);
              }}
            />
          )}
        </>
      )}
      {dialog}
    </Section>
  );
}
