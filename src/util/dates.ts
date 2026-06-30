const DAY_KEYWORDS: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

function pad(n: number) {
  return String(n).padStart(2, '0');
}

export function toISO(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function todayISO(): string {
  return toISO(new Date());
}

export function resolveDateKeyword(raw: string, now = new Date()): string | undefined {
  const trimmed = raw.trim().toLowerCase();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  if (trimmed === 'today') return toISO(now);
  if (trimmed === 'tomorrow') {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    return toISO(d);
  }
  if (trimmed in DAY_KEYWORDS) {
    const target = DAY_KEYWORDS[trimmed];
    const d = new Date(now);
    const cur = d.getDay();
    let diff = target - cur;
    if (diff <= 0) diff += 7;
    d.setDate(d.getDate() + diff);
    return toISO(d);
  }
  return undefined;
}

export function formatDateChip(iso: string, now = new Date()): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const today = toISO(now);
  if (iso === today) return 'today';
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (iso === toISO(tomorrow)) return 'tomorrow';
  const d = new Date(iso + 'T00:00:00');
  const sameYear = d.getFullYear() === now.getFullYear();
  const m = d.toLocaleString('en-US', { month: 'short' });
  return sameYear ? `${m} ${d.getDate()}` : `${m} ${d.getDate()} ${d.getFullYear()}`;
}

/** Compact relative time for presence stamps: "just now", "5m ago", "3h ago", "2d ago". */
export function timeAgo(iso: string, now = new Date()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const secs = Math.max(0, Math.floor((now.getTime() - then) / 1000));
  if (secs < 45) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return formatDateChip(toISO(new Date(then)), now);
}

export function isDueSoon(iso: string, now = new Date()): boolean {
  const today = new Date(toISO(now) + 'T00:00:00');
  const target = new Date(iso + 'T00:00:00');
  const diff = (target.getTime() - today.getTime()) / 86400000;
  return diff <= 2;
}
