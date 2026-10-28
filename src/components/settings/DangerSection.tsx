// Board settings › Danger zone: leaving the board, and (for admins, whom the server requires)
// deleting it. Both are immediate and neither has an undo, which is why they sit together at the
// end of the nav rather than next to the things people change every day.

import { useState } from 'react';
import { api, ApiError } from '../../api/client';
import { useSession } from '../../session/useSession';
import { useStore } from '../../store';
import { confirmDeleteBoard, confirmLeaveBoard } from '../../confirm/prompts';
import { Section } from '../common/Section';
import { Notice } from '../common/Notice';
import type { ID } from '../../types';

export function DangerSection({ tabId }: { tabId: ID }) {
  const me = useSession((s) => s.user);
  const tab = useStore((s) => s.tabs[tabId]);
  const tasks = useStore((s) => s.tasks);
  const deleteTab = useStore((s) => s.deleteTab);
  const setBoardSettings = useStore((s) => s.setBoardSettings);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!tab || !me) return null;
  const isAdmin = tab.role === 'admin';

  async function leave(): Promise<void> {
    if (!(await confirmLeaveBoard(tab!.name))) return;
    setBusy(true);
    setError(null);
    try {
      await api.members.remove(tabId, me!.id);
      // Re-pull authoritative state: the board this was shown on is no longer ours to see.
      window.location.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message.replace(/^.*-> \d+\s*/, '') : 'Couldn’t leave the board.');
      setBusy(false);
    }
  }

  async function remove(): Promise<void> {
    const taskCount = Object.values(tasks).filter((t) => t.homeTabId === tabId).length;
    if (!(await confirmDeleteBoard(tab!.name, taskCount))) return;
    setBoardSettings(null);
    deleteTab(tabId);
  }

  return (
    <>
      {error && <Notice>{error}</Notice>}
      <Section title="Leave this board" description="You lose access right away. An admin has to add you back.">
        <button type="button" className="btn ghost security-act" disabled={busy} onClick={() => void leave()}>Leave board</button>
      </Section>
      {isAdmin && (
        <Section title="Delete this board" description="Deletes the board for everyone, with its tasks, notes and files. It can’t be undone.">
          <button type="button" className="btn danger security-act" disabled={busy} onClick={() => void remove()}>Delete board</button>
        </Section>
      )}
    </>
  );
}
