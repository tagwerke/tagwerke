// Verifies shared/rank.ts — the fractional index keys the task tree orders siblings by.
// No DB, no network: pure property checks over the key algebra. Run: npm run verify:rank
//
// This is the safety net for the one piece of logic that MUST behave identically in the browser
// and on the server (a rank minted by a client is compared against ranks minted by the backfill).

import { RANK_INITIAL, compareRank, isValidRank, rankAfter, rankBefore, rankBetween, rankSequence } from '../../shared/rank.ts';

let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

section('basics');
check('initial rank is valid', isValidRank(RANK_INITIAL), RANK_INITIAL);
check('empty string is not a valid rank', !isValidRank(''));
check("a fractional part ending in '0' is not a valid rank", !isValidRank('a0V0'));
check('an integer part MAY end in zero', isValidRank('a0'));
check('a key with no valid integer head is invalid', !isValidRank('0V'));
check('a key shorter than its declared integer part is invalid', !isValidRank('b0'));

section('between two neighbours');
{
  const a = rankBetween(null, null);
  const b = rankAfter(a);
  const mid = rankBetween(a, b);
  check('a < mid < b', a < mid && mid < b, `${a} / ${mid} / ${b}`);
  check('all three valid', isValidRank(a) && isValidRank(mid) && isValidRank(b));
}

section('repeated append stays ordered and valid');
{
  let prev = rankAfter(null);
  let ok = true;
  let last = prev;
  for (let i = 0; i < 500; i++) {
    const next = rankAfter(prev);
    if (!(next > prev) || !isValidRank(next)) {
      ok = false;
      last = next;
      break;
    }
    prev = next;
    last = next;
  }
  check('500 appends ascend and stay valid', ok, last);
  // The whole reason for the integer part: append must NOT grow a character per call.
  check('append keys stay short', last.length <= 4, `len=${last.length} (${last})`);
}

section('repeated prepend stays ordered and valid');
{
  let prev = rankBefore(null);
  let ok = true;
  let last = prev;
  for (let i = 0; i < 500; i++) {
    const next = rankBefore(prev);
    if (!(next < prev) || !isValidRank(next)) {
      ok = false;
      last = next;
      break;
    }
    prev = next;
    last = next;
  }
  check('500 prepends descend and stay valid', ok, last);
  check('prepend keys stay short', last.length <= 4, `len=${last.length} (${last})`);
}

section('repeated insert into the SAME gap (the pathological case)');
{
  // Two people fighting over one slot, or a user dragging into the same position 1000 times.
  // Keys must keep splitting forever; they grow in length but never collide or invert.
  const lo = rankAfter(null);
  const hi = rankAfter(lo);
  let cur = hi;
  let ok = true;
  for (let i = 0; i < 1000; i++) {
    const next = rankBetween(lo, cur);
    if (!(next > lo && next < cur) || !isValidRank(next)) {
      ok = false;
      break;
    }
    cur = next;
  }
  check('1000 splits of one gap stay strictly between', ok, cur);
  check('split keys grow but stay bounded', cur.length < 600, `len=${cur.length}`);
}

section('sequence');
{
  const seq = rankSequence(100);
  const ascending = seq.every((r, i) => i === 0 || seq[i - 1] < r);
  check('rankSequence(100) is strictly ascending', ascending);
  check('rankSequence(100) is all valid', seq.every(isValidRank));
  check('rankSequence(0) is empty', rankSequence(0).length === 0);
}

section('lexicographic order matches sort order');
{
  // The property the DB index and the client sort both rely on.
  const seq = rankSequence(200);
  const shuffled = [...seq].reverse();
  const sorted = [...shuffled].sort();
  check('plain string sort reproduces insertion order', sorted.every((r, i) => r === seq[i]));
}

section('comparator');
{
  const rows = [
    { id: 'c', rank: null },
    { id: 'a', rank: 'V' },
    { id: 'b', rank: 'G' },
  ];
  const sorted = [...rows].sort(compareRank).map((r) => r.id);
  check('unranked rows sort last', sorted.join('') === 'bac', sorted.join(''));

  const tied = [{ id: 'z', rank: 'V' }, { id: 'a', rank: 'V' }];
  check('equal ranks break ties by id', [...tied].sort(compareRank)[0].id === 'a');
}

section('guards');
{
  let threw = false;
  try {
    rankBetween('b', 'a');
  } catch {
    threw = true;
  }
  check('inverted bounds throw', threw);

  threw = false;
  try {
    rankBetween('a0V0', null);
  } catch {
    threw = true;
  }
  check("a bound whose fraction ends in '0' throws", threw);

  threw = false;
  try {
    rankBetween('nonsense!', null);
  } catch {
    threw = true;
  }
  check('a malformed bound throws', threw);
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
