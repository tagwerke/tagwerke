import type { ReactNode } from 'react';

// One empty state and one loading state, so every list says "nothing here" and "working on it" the
// same way. `as` lets them sit directly inside a <ul> (as="li") without an extra wrapper.
type Tag = 'div' | 'li' | 'p' | 'span';

// size: 'inline' = left-aligned line inside a list or panel; 'block' = centred, roomier — for a
// whole view or palette that has nothing to show.
export function EmptyState({ children, size = 'inline', as: Tag = 'div' }: { children: ReactNode; size?: 'inline' | 'block'; as?: Tag }) {
  return <Tag className={`empty${size === 'block' ? ' block' : ''}`}>{children}</Tag>;
}

// A quiet shimmer bar standing in for content that is on its way. `block` fills a whole screen.
export function Loading({ size = 'inline', as: Tag = 'div' }: { size?: 'inline' | 'block'; as?: Tag }) {
  return (
    <Tag className={`loading${size === 'block' ? ' block' : ''}`} role="status" aria-label="Loading">
      <span className="loading-bar" />
      <span className="loading-bar short" />
    </Tag>
  );
}
