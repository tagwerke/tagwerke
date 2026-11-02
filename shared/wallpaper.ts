// Board wallpapers, shared by client and server.
//
// A wallpaper is personal: each member picks their own for each board (board_members.wallpaper), and
// no one else sees it. The set is fixed — a name, never a hex or an upload — so every choice has a
// light and a dark rendering that keeps the board readable (src/styles/wallpaper.css), and the server
// can validate it as an enum. No wallpaper (null) is the plain paper the board has always had.

export const WALLPAPER_COLORS = ['sage', 'mint', 'sky', 'lavender', 'rose', 'peach', 'butter', 'stone'] as const;
export const WALLPAPER_PATTERNS = ['dots', 'waves', 'blueprint', 'blossom'] as const;

export const WALLPAPERS = [...WALLPAPER_COLORS, ...WALLPAPER_PATTERNS] as const;
export type Wallpaper = (typeof WALLPAPERS)[number];

export const WALLPAPER_LABEL: Record<Wallpaper, string> = {
  sage: 'Sage',
  mint: 'Mint',
  sky: 'Sky',
  lavender: 'Lavender',
  rose: 'Rose',
  peach: 'Peach',
  butter: 'Butter',
  stone: 'Stone',
  dots: 'Dots',
  waves: 'Waves',
  blueprint: 'Blueprint',
  blossom: 'Blossom',
};
