import type { ReactNode } from 'react';

// A titled card for one self-contained setting: title + optional status badge on the first line, a
// one-line description under it, then the controls. Panels that group several settings stack these.
export function Section({ title, badge, description, children }: { title: string; badge?: ReactNode; description?: ReactNode; children?: ReactNode }) {
  return (
    <section className="section-card">
      <header className="section-head">
        <h3>{title}</h3>
        {badge}
      </header>
      {description && <p className="section-desc">{description}</p>}
      {children}
    </section>
  );
}
