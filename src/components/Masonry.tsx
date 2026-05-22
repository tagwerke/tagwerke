import { Children, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

const BREAKPOINTS: Array<{ min: number; cols: number }> = [
  { min: 1400, cols: 4 },
  { min: 1080, cols: 3 },
  { min: 720, cols: 2 },
  { min: 0, cols: 1 },
];

function colsFor(width: number): number {
  return BREAKPOINTS.find((b) => width >= b.min)!.cols;
}

interface Pos { x: number; y: number }

export function Masonry({ gap = 16, children }: { gap?: number; children: React.ReactNode }) {
  const items = Children.toArray(children);
  const containerRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLDivElement | null>>([]);
  const [width, setWidth] = useState(0);
  const [cols, setCols] = useState(1);
  const [positions, setPositions] = useState<Pos[]>([]);
  const [totalHeight, setTotalHeight] = useState(0);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0].contentRect.width;
      setWidth(w);
      setCols(colsFor(w));
    });
    ro.observe(el);
    setWidth(el.clientWidth);
    setCols(colsFor(el.clientWidth));
    return () => ro.disconnect();
  }, []);

  const relayout = useCallback(() => {
    if (!width || !cols) return;
    const colW = (width - gap * (cols - 1)) / cols;
    const colHeights = new Array(cols).fill(0);
    const next: Pos[] = [];
    for (let i = 0; i < items.length; i++) {
      const h = itemRefs.current[i]?.offsetHeight ?? 0;
      let best = 0;
      for (let c = 1; c < cols; c++) if (colHeights[c] < colHeights[best]) best = c;
      next.push({ x: best * (colW + gap), y: colHeights[best] });
      colHeights[best] += h + gap;
    }
    setPositions(next);
    setTotalHeight(Math.max(0, ...colHeights) - (colHeights.some((h) => h > 0) ? gap : 0));
    setHydrated(true);
  }, [width, cols, gap, items.length]);

  useLayoutEffect(() => { relayout(); }, [relayout]);

  // Per-item ResizeObserver so cards expanding/collapsing repacks the grid.
  useEffect(() => {
    const ro = new ResizeObserver(() => relayout());
    itemRefs.current.forEach((el) => { if (el) ro.observe(el); });
    return () => ro.disconnect();
  }, [relayout, items.length]);

  const colW = cols && width ? (width - gap * (cols - 1)) / cols : 0;

  return (
    <div
      ref={containerRef}
      className="masonry"
      style={{ position: 'relative', height: hydrated ? totalHeight : undefined }}
    >
      {items.map((child, i) => {
        const pos = positions[i];
        const placed = pos != null && hydrated;
        return (
          <div
            key={(child as { key?: string | number } | null)?.key ?? i}
            ref={(el) => { itemRefs.current[i] = el; }}
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              width: colW || '100%',
              transform: placed ? `translate3d(${pos.x}px, ${pos.y}px, 0)` : 'translate3d(0, 0, 0)',
              opacity: placed ? 1 : 0,
              transition: 'transform 220ms cubic-bezier(0.2, 0.65, 0.25, 1), opacity 140ms ease-out',
              willChange: 'transform',
            }}
          >
            {child}
          </div>
        );
      })}
    </div>
  );
}
