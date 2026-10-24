// Map one set of task states onto another board's (BOARD_STATES_PLAN P5.2). One row per source
// state — its chip, an arrow, a target dropdown.
//
// It knows nothing about why the mapping is needed: a cross-board move uses it today, and CSV
// import and a board copy will reuse it. Prefill with `suggestMapping` (src/tasks/states.ts).

import { useState } from 'react';
import { Dropdown } from '../Dropdown';
import { stateStyle } from '../../tasks/states';
import type { BoardState } from '../../../shared/status';

export interface MapSource {
  key: string;
  label: string;
  category: BoardState['category'];
  color: string;
  /** How many tasks are on it. */
  count: number;
}

export function StateMapper({ sources, targets, value, onChange }: {
  sources: MapSource[];
  targets: readonly BoardState[];
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}) {
  const options = targets.map((t) => ({ value: t.key, label: t.label, accent: `var(--state-${t.color})` }));
  return (
    <ul className="state-mapper">
      {sources.map((s) => (
        <li key={s.key} className="state-mapper-row">
          <span className="state-mapper-source" title={`${s.count} task${s.count === 1 ? '' : 's'}`}>
            <span className="list-dot" style={stateStyle(s)} aria-hidden />
            <span className="state-mapper-label">{s.label}</span>
            <span className="state-mapper-count">{s.count}</span>
          </span>
          <span className="state-mapper-arrow" aria-hidden>→</span>
          <Dropdown value={value[s.key] ?? ''} options={options} onChange={(v) => onChange({ ...value, [s.key]: v })} placeholder="pick a state" />
        </li>
      ))}
    </ul>
  );
}

/** The same, holding its own choice — for a host that only wants to hear about changes, like the
 *  confirm dialog, whose body is rendered once and never re-rendered by the caller. */
export function UncontrolledStateMapper({ initial, onChange, ...rest }: {
  sources: MapSource[];
  targets: readonly BoardState[];
  initial: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}) {
  const [value, setValue] = useState(initial);
  return <StateMapper {...rest} value={value} onChange={(v) => { setValue(v); onChange(v); }} />;
}
