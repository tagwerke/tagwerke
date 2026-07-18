import type { ReactNode } from 'react';
import { useStore } from '../store';

interface ChipProps {
  kind: 'priority' | 'owner' | 'date' | 'project';
  priority?: 1 | 2 | 3;
  color?: string;
  onClick?: () => void;
  title?: string;
  children: ReactNode;
}

export function Chip({ kind, priority, color, onClick, title, children }: ChipProps) {
  const setFilter = useStore((s) => s.setFilter);
  const filter = useStore((s) => s.filter);

  const handleClick = () => {
    if (onClick) return onClick();
    if (kind === 'owner' && typeof children === 'string') {
      const owners = filter.owners.includes(children)
        ? filter.owners.filter((o) => o !== children)
        : [...filter.owners, children];
      setFilter({ owners });
    } else if (kind === 'priority' && priority) {
      const priorities = filter.priorities.includes(priority)
        ? filter.priorities.filter((p) => p !== priority)
        : [...filter.priorities, priority];
      setFilter({ priorities });
    }
  };

  return (
    <button
      type="button"
      className={`chip chip-${kind}${priority ? ` p${priority}` : ''}`}
      onClick={handleClick}
      title={title}
      style={color ? { '--chip-color': color } as React.CSSProperties : undefined}
    >
      {children}
    </button>
  );
}
