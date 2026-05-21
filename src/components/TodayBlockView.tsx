import { useState, useEffect, useRef } from 'react';
import { useStore } from '../store';
import { TaskRow } from './TaskRow';
import { TaskPicker } from './TaskPicker';
import type { ID } from '../types';
import { appendNewTaskToHome } from '../editor/registry';
import { nanoid } from 'nanoid';
import { extractTokens } from '../util/parse';

interface Props { blockId: ID; index: number; todayTabId: ID }

export function TodayBlockView({ blockId, index }: Props) {
  const block = useStore((s) => s.tabs[s.todayTabId]?.blocks?.find((b) => b.id === blockId));
  const tabs = useStore((s) => s.tabs);
  const projects = useStore((s) => s.projects);
  const tabOrder = useStore((s) => s.tabOrder);
  const updateBlock = useStore((s) => s.updateBlock);
  const deleteBlock = useStore((s) => s.deleteBlock);
  const addTaskToBlock = useStore((s) => s.addTaskToBlock);
  const upsertTask = useStore((s) => s.upsertTask);
  const setTabDoc = useStore((s) => s.setTabDoc);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newText, setNewText] = useState('');
  const newInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (adding) newInputRef.current?.focus(); }, [adding]);

  if (!block) return null;
  const boundTab = tabs[block.tabId];
  const boundProject = boundTab ? projects[boundTab.projectId] : undefined;

  const onAddNew = () => {
    const raw = newText.trim();
    if (!raw) { setAdding(false); return; }
    if (!block.tabId) {
      alert('bind this block to a tab first');
      return;
    }
    const parsed = extractTokens(raw);
    let id = appendNewTaskToHome(block.tabId, parsed.text);
    if (!id) {
      id = `t_${nanoid(8)}`;
      const tabDoc = (tabs[block.tabId]?.docJSON as any) || { type: 'doc', content: [] };
      const newItem = {
        type: 'taskItem',
        attrs: { id, done: false },
        content: [{ type: 'paragraph', content: parsed.text ? [{ type: 'text', text: parsed.text }] : [] }],
      };
      const lastNode = tabDoc.content?.[tabDoc.content.length - 1];
      if (lastNode?.type === 'taskList') {
        lastNode.content = [...(lastNode.content ?? []), newItem];
      } else {
        tabDoc.content = [...(tabDoc.content ?? []), { type: 'taskList', content: [newItem] }];
      }
      setTabDoc(block.tabId, tabDoc);
    }
    upsertTask({
      id,
      homeTabId: block.tabId,
      text: parsed.text,
      date: parsed.date,
      priority: parsed.priority,
      owner: parsed.owner,
      done: parsed.done ?? false,
    });
    addTaskToBlock(block.id, id);
    setNewText('');
    setAdding(false);
  };

  const accent = boundProject?.color ?? '#888';

  return (
    <article className="today-block" style={{ '--block-accent': accent } as React.CSSProperties}>
      <header className="today-block-head">
        <span className="today-block-index">{String(index + 1).padStart(2, '0')}</span>
        <div className="today-block-times">
          <input
            type="time"
            value={block.start ?? ''}
            onChange={(e) => updateBlock(block.id, { start: e.target.value || undefined })}
          />
          <span className="dash">–</span>
          <input
            type="time"
            value={block.end ?? ''}
            onChange={(e) => updateBlock(block.id, { end: e.target.value || undefined })}
          />
        </div>
        <select
          className="today-block-tab"
          value={block.tabId}
          onChange={(e) => updateBlock(block.id, { tabId: e.target.value })}
        >
          <option value="">— select tab —</option>
          {tabOrder.filter((tid) => tabs[tid]?.type === 'normal').map((tid) => (
            <option key={tid} value={tid}>{tabs[tid].name} · {projects[tabs[tid].projectId]?.name}</option>
          ))}
        </select>
        <input
          className="today-block-label"
          placeholder="label (optional)"
          value={block.label ?? ''}
          onChange={(e) => updateBlock(block.id, { label: e.target.value || undefined })}
        />
        <button className="icon-btn delete" onClick={() => { if (confirm('Delete this block?')) deleteBlock(block.id); }} aria-label="delete block" title="delete">
          <svg viewBox="0 0 16 16" width="12" height="12"><path d="M4 4l8 8M12 4L4 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>
        </button>
      </header>

      <ul className="today-block-tasks">
        {block.taskIds.map((tid) => (
          <TaskRow key={tid} taskId={tid} blockId={block.id} />
        ))}
      </ul>

      <div className="today-block-add">
        {adding ? (
          <div className="add-row">
            <input
              ref={newInputRef}
              value={newText}
              onChange={(e) => setNewText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onAddNew();
                else if (e.key === 'Escape') { setAdding(false); setNewText(''); }
              }}
              placeholder={`- new task in ${boundTab?.name ?? '(no tab)'}`}
            />
            <button className="btn ghost tiny" onClick={onAddNew}>add</button>
          </div>
        ) : (
          <div className="add-actions">
            <button className="btn ghost tiny" onClick={() => setAdding(true)}>+ type new</button>
            <button className="btn ghost tiny" onClick={() => setPickerOpen(true)}>+ pick from {boundTab?.name ?? 'tab'}</button>
          </div>
        )}
      </div>

      {pickerOpen && (
        <TaskPicker
          tabId={block.tabId}
          excludeIds={new Set(block.taskIds)}
          onPick={(taskId) => { addTaskToBlock(block.id, taskId); }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </article>
  );
}
