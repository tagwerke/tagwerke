// Board settings › Wallpaper: the caller's own background for this board. Personal, like starring —
// it lives on their membership row, so anyone who can open the board may set it, viewers included,
// and no one else sees it. Each tile is the wallpaper itself (the same classes the board wears).

import { useStore } from '../../store';
import { Section } from '../common/Section';
import { WALLPAPER_COLORS, WALLPAPER_LABEL, WALLPAPER_PATTERNS, type Wallpaper } from '../../../shared/wallpaper';
import type { ID } from '../../types';

export function WallpaperSection({ tabId }: { tabId: ID }) {
  const current = useStore((s) => s.tabs[tabId]?.wallpaper ?? null);
  const setTabWallpaper = useStore((s) => s.setTabWallpaper);

  const tile = (w: Wallpaper | null) => {
    const on = current === w;
    return (
      <button
        key={w ?? 'none'}
        type="button"
        role="radio"
        aria-checked={on}
        className={`wallpaper-tile ${on ? 'is-selected' : ''}`}
        onClick={() => { if (!on) setTabWallpaper(tabId, w); }}
      >
        <span className={`wallpaper-tile-face wallpaper ${w ? `wp-${w}` : ''}`} aria-hidden />
        <span className="wallpaper-tile-label">{w ? WALLPAPER_LABEL[w] : 'None'}</span>
      </button>
    );
  };

  return (
    <Section title="Wallpaper" description="Only you see this. Everyone on the board picks their own.">
      <div className="field">
        <span>Colors</span>
        <div className="wallpaper-grid" role="radiogroup" aria-label="Colors">
          {tile(null)}
          {WALLPAPER_COLORS.map(tile)}
        </div>
      </div>
      <div className="field">
        <span>Patterns</span>
        <div className="wallpaper-grid" role="radiogroup" aria-label="Patterns">
          {WALLPAPER_PATTERNS.map(tile)}
        </div>
      </div>
    </Section>
  );
}
