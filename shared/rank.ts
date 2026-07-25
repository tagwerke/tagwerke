// Fractional index keys — the sibling ordering primitive for the task tree (SUBTASKS_PLAN D4).
//
// A rank is a short string compared LEXICOGRAPHICALLY. Moving a task between two neighbours means
// computing a key strictly between their two keys, so a move updates exactly ONE row no matter how
// long the list is. That is the whole point: integer positions would have to renumber every
// sibling after the insertion point — O(n) writes, and a merge disaster when two people reorder at
// once.
//
// Alphabet is base62 in ASCII order ('0'-'9' < 'A'-'Z' < 'a'-'z'), so JS string comparison, byte
// comparison, and Postgres `COLLATE "C"` all agree. The rank column is declared COLLATE "C" for
// exactly that reason — under a locale collation ('a'/'A' folding) the DB would disagree with the
// client about order, and the two must never disagree.
//
// A key has two parts: an INTEGER part and an optional FRACTIONAL part.
//
//   a0        integer 'a0', no fraction          ← the first key ever handed out
//   a1        the next one along
//   a0V       integer 'a0' + fraction 'V'        ← sits strictly between a0 and a1
//
// The integer part's first character encodes its own length ('a' → 2 chars, 'b' → 3, … and the
// uppercase range mirrors it downward for keys below zero). That indirection is what keeps
// APPENDING cheap: appending increments the integer, so 62 appends fit in 2 characters, 3,844 in
// 3, and so on — logarithmic growth. A naive midpoint-only scheme grows one character per append
// (500 tasks → 101-character keys), which is why this indirection is worth the extra code.
// Only repeated insertion into the SAME gap lengthens keys linearly, and that is the rare case.
//
// Invariant: a key's FRACTIONAL part never ends in the lowest digit ('0'). Without it there is no
// key strictly between 'a0V0' and 'a0V' and the scheme dead-ends. Every function here preserves
// it; `isValidRank` checks it. (The integer part may of course end in '0' — 'a0' does.)
//
// This file is imported by BOTH the client and the server and must behave identically in each — a
// rank minted in the browser is compared against ranks minted by the backfill script. See
// server/scripts/verify-rank.ts, which is the property check for everything claimed above.

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ZERO = DIGITS[0];
const TOP = DIGITS[DIGITS.length - 1];

/** The integer part meaning zero. The first key ever handed out for an empty list. */
export const RANK_INITIAL = 'a0';

/** The floor of the key space. Reserved as a sentinel — never a real key. */
const SMALLEST_INTEGER = `A${ZERO.repeat(26)}`;

/**
 * How many characters the integer part occupies, read off its first character. Lowercase heads
 * count upward from 2 ('a0' … 'z' + 26 digits); uppercase heads mirror them downward for the
 * below-zero range, so 'A' is the longest negative and 'Z' the shortest.
 */
function integerLength(head: string): number {
  if (head >= 'a' && head <= 'z') return head.charCodeAt(0) - 'a'.charCodeAt(0) + 2;
  if (head >= 'A' && head <= 'Z') return 'Z'.charCodeAt(0) - head.charCodeAt(0) + 2;
  throw new Error(`rank: invalid integer head '${head}'`);
}

function validateInteger(int: string): void {
  if (int.length !== integerLength(int[0])) throw new Error(`rank: malformed integer part '${int}'`);
}

function integerPart(key: string): string {
  if (!key.length) throw new Error('rank: empty key');
  const len = integerLength(key[0]);
  if (len > key.length) throw new Error(`rank: key '${key}' is shorter than its integer part`);
  return key.slice(0, len);
}

function validateKey(key: string): void {
  if (key === SMALLEST_INTEGER) throw new Error('rank: the smallest integer is a sentinel, not a key');
  const int = integerPart(key);
  const frac = key.slice(int.length);
  if (frac.endsWith(ZERO)) throw new Error(`rank: fractional part of '${key}' ends in '${ZERO}'`);
}

export function isValidRank(rank: string | null | undefined): boolean {
  if (!rank) return false;
  try {
    validateKey(rank);
    return true;
  } catch {
    return false;
  }
}

/** The next integer after `x`, or null when the integer space is exhausted upward. */
function incrementInteger(x: string): string | null {
  validateInteger(x);
  const [head, ...digs] = x.split('');
  let carry = true;
  for (let i = digs.length - 1; carry && i >= 0; i--) {
    const d = DIGITS.indexOf(digs[i]) + 1;
    if (d === DIGITS.length) digs[i] = ZERO;
    else {
      digs[i] = DIGITS[d];
      carry = false;
    }
  }
  if (!carry) return head + digs.join('');
  // Overflowed this width — step the head, which changes how many digits follow it.
  if (head === 'Z') return `a${ZERO}`;
  if (head === 'z') return null;
  const next = String.fromCharCode(head.charCodeAt(0) + 1);
  if (next > 'a') digs.push(ZERO);
  else digs.pop();
  return next + digs.join('');
}

/** The previous integer before `x`, or null when the integer space is exhausted downward. */
function decrementInteger(x: string): string | null {
  validateInteger(x);
  const [head, ...digs] = x.split('');
  let borrow = true;
  for (let i = digs.length - 1; borrow && i >= 0; i--) {
    const d = DIGITS.indexOf(digs[i]) - 1;
    if (d === -1) digs[i] = TOP;
    else {
      digs[i] = DIGITS[d];
      borrow = false;
    }
  }
  if (!borrow) return head + digs.join('');
  if (head === 'a') return `Z${TOP}`;
  if (head === 'A') return null;
  const prev = String.fromCharCode(head.charCodeAt(0) - 1);
  if (prev < 'Z') digs.push(TOP);
  else digs.pop();
  return prev + digs.join('');
}

/**
 * A fractional string strictly between `a` and `b` (`b` null = no upper bound). Strips the common
 * prefix, then splits the first differing digit; when the digits are already adjacent it descends
 * into the next place rather than giving up, which is what lets a gap be split indefinitely.
 */
function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) throw new Error(`rank: lower bound '${a}' is not below upper bound '${b}'`);
  if (a.endsWith(ZERO) || (b !== null && b.endsWith(ZERO))) {
    throw new Error(`rank: fractional bound ends in '${ZERO}' ('${a}', '${b}')`);
  }
  if (b !== null) {
    // Strip the longest common prefix and solve the remainder. `a` is padded with the lowest digit
    // because a shorter `a` is implicitly followed by zeroes.
    let n = 0;
    while ((a[n] ?? ZERO) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const digitA = a.length ? DIGITS.indexOf(a[0]) : 0;
  const digitB = b !== null ? DIGITS.indexOf(b[0]) : DIGITS.length;
  if (digitB - digitA > 1) return DIGITS[Math.round(0.5 * (digitA + digitB))];
  // Leading digits are adjacent. If `b` has more digits its own first digit already sits strictly
  // between; otherwise keep `a`'s digit and recurse into the next place with no upper bound.
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[digitA] + midpoint(a.slice(1), null);
}

/**
 * The rank for an item placed between `before` and `after` — either may be null/undefined for
 * "at the start" / "at the end". Callers read the two bounds off the neighbours they are dropping
 * between; `before` must sort below `after`.
 */
export function rankBetween(before?: string | null, after?: string | null): string {
  const a = before ?? null;
  const b = after ?? null;
  if (a !== null) validateKey(a);
  if (b !== null) validateKey(b);
  if (a !== null && b !== null && a >= b) {
    throw new Error(`rank: lower bound '${a}' is not below upper bound '${b}'`);
  }

  if (a === null) {
    if (b === null) return RANK_INITIAL;
    // Prepend: step the integer down, or split below `b`'s own integer when it has a fraction.
    const intB = integerPart(b);
    const fracB = b.slice(intB.length);
    if (intB === SMALLEST_INTEGER) return intB + midpoint('', fracB);
    if (intB < b) return intB; // `b` carries a fraction, so its bare integer is already below it
    const dec = decrementInteger(intB);
    if (dec === null) throw new Error('rank: key space exhausted downward');
    return dec;
  }

  const intA = integerPart(a);
  const fracA = a.slice(intA.length);

  if (b === null) {
    // Append: step the integer up. Only when the integer space is exhausted do we grow a fraction.
    const inc = incrementInteger(intA);
    return inc === null ? intA + midpoint(fracA, null) : inc;
  }

  const intB = integerPart(b);
  const fracB = b.slice(intB.length);
  if (intA === intB) return intA + midpoint(fracA, fracB);
  const inc = incrementInteger(intA);
  if (inc === null) throw new Error('rank: key space exhausted upward');
  if (inc < b) return inc;
  return intA + midpoint(fracA, null);
}

/** Rank for a new item appended after the whole list (`last` = current final rank, or null). */
export function rankAfter(last?: string | null): string {
  return rankBetween(last ?? null, null);
}

/** Rank for a new item placed ahead of the whole list (`first` = current first rank, or null). */
export function rankBefore(first?: string | null): string {
  return rankBetween(null, first ?? null);
}

/**
 * `n` ranks in ascending order, for seeding a list whose order is already known (the backfill, a
 * bulk import). Built by repeated append, which is the cheap direction.
 */
export function rankSequence(n: number): string[] {
  const out: string[] = [];
  let prev: string | null = null;
  for (let i = 0; i < n; i++) {
    prev = rankAfter(prev);
    out.push(prev);
  }
  return out;
}

/**
 * Ascending comparator over ranks. Rows with no rank yet (pre-backfill, or written by an older
 * client) sort LAST rather than first, so a missing key can never silently jump a task to the top
 * of its parent; equal ranks break by id for a stable, deterministic order.
 */
export function compareRank(
  a: { rank?: string | null; id: string },
  b: { rank?: string | null; id: string },
): number {
  const ra = a.rank ?? '';
  const rb = b.rank ?? '';
  if (ra !== rb) {
    if (!ra) return 1;
    if (!rb) return -1;
    return ra < rb ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
