import type { ReactNode } from 'react';

// The one inline banner: errors, confirmations and neutral info all share the same shape so a
// panel never mixes two looks. Sits at the top of a panel/form body.
export function Notice({ tone = 'error', children }: { tone?: 'error' | 'success' | 'info'; children: ReactNode }) {
  return (
    <div className={`notice notice-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}
