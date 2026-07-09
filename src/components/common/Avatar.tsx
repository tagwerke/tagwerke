// A small identity avatar: initials in a colored circle. Color defaults to the shared
// per-identity hue (matches the person's live cursor). Reused by presence, task rows,
// kanban cards, and member lists.

import { colorForKey, initials } from '../../util/avatar';

export function Avatar({
  name,
  color,
  size = 22,
  title,
  ring,
}: {
  name: string;
  color?: string;
  size?: number;
  title?: string;
  /** Draw a colored ring (used for live presence). */
  ring?: boolean;
}) {
  const bg = color ?? colorForKey(name);
  return (
    <span
      className={`avatar${ring ? ' avatar-ring' : ''}`}
      title={title ?? name}
      style={{
        width: size,
        height: size,
        background: bg,
        fontSize: Math.round(size * 0.4),
        ...(ring ? ({ '--ring': bg } as React.CSSProperties) : {}),
      }}
    >
      {initials(name)}
    </span>
  );
}
