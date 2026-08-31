// Drive the board table's keyboard in a real browser and assert on what happens.
//
// This exists because the table's keyboard shipped broken twice while "verified" by reading the
// code. Interaction cannot be checked by reasoning: both bugs were in the seams between a mouse
// event, a React state update and where the browser put focus, and no amount of re-reading found
// them.
//
//   npm run dev                       # in another terminal
//   npm run verify:table-keys
//
// Requires a seeded login and a board with tasks — see the constants below. Dev only; it types
// into whatever board you point it at.
//
// TWO HARNESS TRAPS, both of which cost hours and are worth knowing:
//
//   1. After a cross-document navigation (the login redirect), this Chrome session silently stops
//      delivering mouse and key events to that page. `evaluate` keeps working, so the app looks
//      dead to the keyboard when it is fine. The fix is to run the test on a FRESH page that has
//      only its own single navigation; it shares the session cookie through the browser context.
//
//   2. Dispatching synthetic `KeyboardEvent`s from `evaluate` reaches React's handlers but not the
//      browser's own behaviour — no caret moves, no default actions. It will happily "pass" a
//      test for a field that a real user cannot type into. Use real input, or test nothing.

import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const APP = process.env.APP ?? 'http://localhost:5173';
const EMAIL = process.env.EMAIL ?? 'seed1@example.com';
const PASSWORD = process.env.PASSWORD ?? 'Test1234!';
const BOARD = process.env.BOARD ?? 't_shot';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) fails++;
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  defaultViewport: { width: 1440, height: 900 },
  args: ['--no-sandbox'],
});

// ── Sign in on one page, then throw it away (see trap 1) ──────────────────────────────────────
const login = await browser.newPage();
await login.goto(APP, { waitUntil: 'networkidle2' });
await sleep(800);
const email = await login.$('input[type="email"], input[name="email"]');
if (email) {
  await email.type(EMAIL);
  await (await login.$('input[type="password"]')).type(PASSWORD);
  await Promise.all([
    login.keyboard.press('Enter'),
    login.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {}),
  ]);
  await sleep(1500);
}
await login.close();

const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
page.on('pageerror', (e) => console.log('  PAGE ERROR:', String(e).slice(0, 160)));
await page.goto(`${APP}/b/${BOARD}`, { waitUntil: 'networkidle2' });
await sleep(2500);

// A board opens filtered to its current sprint; show everything so the fixtures are visible.
await page.evaluate(() => {
  [...document.querySelectorAll('.work-control')]
    .find((c) => /sprint/i.test(c.textContent ?? ''))?.querySelector('.dd-trigger')?.click();
});
await sleep(400);
await page.evaluate(() => {
  const o = [...document.querySelectorAll('.dd-panel .dd-option')].find((x) => x.textContent.trim() === 'All');
  o?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  o?.click();
});
await sleep(1200);

// Watch for the table being replaced: a remount detaches whatever had focus, which is the
// "cursor is drawn but nothing responds" state.
await page.evaluate(() => {
  window.__t = document.querySelector('.work-table');
  window.__swaps = [];
  setInterval(() => {
    const now = document.querySelector('.work-table');
    if (now !== window.__t) {
      window.__swaps.push({ at: Date.now(), rows: document.querySelectorAll('.wt-row').length });
      window.__t = now;
    }
  }, 60);
});

const state = () => page.evaluate(() => {
  const cur = document.querySelector('.wt-row.is-cursor');
  const focused = cur?.querySelector('.is-focused');
  const input = document.querySelector('.wt-title-input');
  return {
    active: document.activeElement?.className?.toString().slice(0, 30) || document.activeElement?.tagName,
    inTable: !!document.activeElement?.closest('.work-table'),
    row: cur?.getAttribute('data-row') ?? null,
    col: focused?.getAttribute('data-col') ?? null,
    editing: !!input,
    value: input?.value ?? null,
    firstTitle: document.querySelector('.wt-row .wt-title')?.textContent?.slice(0, 24) ?? null,
  };
});

await page.click('.wt-row .wt-title');
await sleep(400);
let s = await state();
check('a click parks the cursor and does not open an editor', !!s.row && !s.editing, JSON.stringify(s));
check('the table has the keyboard', s.inTable, `active=${s.active}`);

await page.keyboard.press('ArrowRight');
await sleep(250);
check('right moves to the status cell', (await state()).col === '2', `col=${(await state()).col}`);
await page.keyboard.press('ArrowLeft');
await sleep(250);
check('left moves back to the title', (await state()).col === '1', `col=${(await state()).col}`);

const before = (await state()).row;
await page.keyboard.press('ArrowDown');
await sleep(250);
s = await state();
check('down moves a row', s.row !== before, `${before} -> ${s.row}`);

// Typing renames; Escape must revert, not commit.
const title = (await state()).firstTitle;
await page.keyboard.press('ArrowUp');
await sleep(200);
await page.keyboard.type('Zebra', { delay: 20 });
await sleep(400);
s = await state();
check('typing on a title starts a rename with that text', s.editing && s.value?.startsWith('Z'), JSON.stringify({ editing: s.editing, v: s.value }));

await page.keyboard.press('Escape');
await sleep(400);
s = await state();
check('escape leaves the editor', !s.editing, `editing=${s.editing}`);
check('escape reverts rather than commits', s.firstTitle === title, `${title} -> ${s.firstTitle}`);
check('the keyboard comes back after an edit', s.inTable, `active=${s.active}`);

const beforeMove = (await state()).row;
await page.keyboard.press('ArrowDown');
await sleep(250);
check('still navigable after an edit', (await state()).row !== beforeMove, '');

await page.keyboard.press('ArrowRight');
await sleep(200);
await page.keyboard.press('Enter');
await sleep(500);
const menu = await page.evaluate(() => ({
  open: !!document.querySelector('.task-menu'),
  head: document.querySelector('.task-menu-head')?.textContent?.trim(),
}));
check('enter on the status cell opens the status menu', menu.open && /status/i.test(menu.head ?? ''), JSON.stringify(menu));
await page.keyboard.press('Escape');
await sleep(500);
check('the keyboard comes back after the menu', (await state()).inTable, `active=${(await state()).active}`);

const swaps = await page.evaluate(() => window.__swaps);
check('the table is never replaced under the cursor', swaps.length === 0, JSON.stringify(swaps));

console.log(fails ? `\n${fails} failed` : '\nall passed');
await browser.close();
process.exit(fails ? 1 : 0);
