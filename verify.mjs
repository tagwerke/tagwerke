import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync } from 'fs';

const OUT = 'verify-out';
if (!existsSync(OUT)) mkdirSync(OUT);

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1400,1000'],
  defaultViewport: { width: 1400, height: 1000 },
});

const consoleErrors = [];
const pageErrors = [];

const page = await browser.newPage();
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => pageErrors.push(err.message));

const step = async (label, fn) => {
  try {
    await fn();
    console.log(`OK  ${label}`);
  } catch (e) {
    console.log(`ERR ${label}: ${e.message}`);
    throw e;
  }
};

await step('navigate to /', async () => {
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle0', timeout: 15000 });
});
// Clear any persisted state from prior runs
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 600));

await page.screenshot({ path: `${OUT}/01-board.png`, fullPage: true });

await step('board has TODAY mini-card and tab cards', async () => {
  await page.waitForSelector('.today-mini', { timeout: 5000 });
  await page.waitForSelector('.tab-card', { timeout: 5000 });
  const tabCount = await page.$$eval('.tab-card', (els) => els.length);
  if (tabCount < 1) throw new Error('expected at least one tab card');
});

await step('open Inbox tab', async () => {
  const card = await page.evaluateHandle(() => {
    const cards = [...document.querySelectorAll('.tab-card')];
    return cards.find((c) => c.querySelector('.tab-card-title')?.textContent === 'Inbox');
  });
  if (!card) throw new Error('Inbox card not found');
  await card.asElement().click();
  await page.waitForSelector('.tab-view', { timeout: 5000 });
});
await new Promise((r) => setTimeout(r, 300));
await page.screenshot({ path: `${OUT}/02-tab-empty.png`, fullPage: true });

await step('type a task line with tokens', async () => {
  await page.click('.ProseMirror');
  await page.keyboard.type('- buy milk @tomorrow !!');
  await new Promise((r) => setTimeout(r, 200));
});
await page.screenshot({ path: `${OUT}/03-task-typed.png`, fullPage: true });

await step('press Enter — task should commit, tokens stripped, chips appear', async () => {
  await page.keyboard.press('Enter');
  await new Promise((r) => setTimeout(r, 400));
  await page.waitForSelector('li[data-type="taskItem"]', { timeout: 3000 });
  const itemHTML = await page.$eval('li[data-type="taskItem"]', (el) => el.outerHTML);
  if (!itemHTML.includes('chip-date')) throw new Error('no date chip rendered:\n' + itemHTML);
  if (!itemHTML.includes('chip-priority')) throw new Error('no priority chip rendered:\n' + itemHTML);
  const text = await page.$eval('li[data-type="taskItem"] .task-content', (el) => el.textContent);
  if (text.includes('@') || text.includes('!!')) throw new Error('tokens not stripped: ' + text);
  if (!text.toLowerCase().includes('buy milk')) throw new Error('text missing: ' + text);
});
await page.screenshot({ path: `${OUT}/04-task-committed.png`, fullPage: true });

await step('type a second nested task', async () => {
  await page.keyboard.type('- call Chris [Kirill] !!!');
  await new Promise((r) => setTimeout(r, 200));
  await page.keyboard.press('Enter');
  await new Promise((r) => setTimeout(r, 400));
});
await page.screenshot({ path: `${OUT}/05-two-tasks.png`, fullPage: true });

await step('back to board', async () => {
  await page.click('.back-btn');
  await page.waitForSelector('.board', { timeout: 3000 });
});
await new Promise((r) => setTimeout(r, 400));
await page.screenshot({ path: `${OUT}/06-board-after.png`, fullPage: true });

await step('open TODAY view', async () => {
  await page.click('.today-mini');
  await page.waitForSelector('.today-view', { timeout: 3000 });
});
await new Promise((r) => setTimeout(r, 300));
await page.screenshot({ path: `${OUT}/07-today-empty.png`, fullPage: true });

await step('add a block', async () => {
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.today-empty button, .today-head-actions button')].find((b) => b.textContent.includes('block'));
    btn?.click();
  });
  await page.waitForSelector('.today-block', { timeout: 3000 });
});
await page.screenshot({ path: `${OUT}/08-block-added.png`, fullPage: true });

await step('select bound tab = Inbox in block', async () => {
  const handle = await page.$('.today-block-tab');
  await handle.click();
  // Read option values
  const inboxId = await page.evaluate(() => {
    const sel = document.querySelector('.today-block-tab');
    const opt = [...sel.options].find((o) => o.textContent.includes('Inbox'));
    return opt?.value;
  });
  if (inboxId) {
    await page.select('.today-block-tab', inboxId);
  }
  await new Promise((r) => setTimeout(r, 200));
});

await step('type a new task into the block', async () => {
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.today-block-add button')].find((b) => b.textContent.includes('type new'));
    btn?.click();
  });
  await page.waitForSelector('.today-block-add .add-row input', { timeout: 2000 });
  await page.type('.today-block-add .add-row input', 'review designs @today !');
  await new Promise((r) => setTimeout(r, 100));
  await page.keyboard.press('Enter');
  await new Promise((r) => setTimeout(r, 400));
  await page.waitForSelector('.today-block-tasks .task-row', { timeout: 3000 });
});
await page.screenshot({ path: `${OUT}/09-task-in-block.png`, fullPage: true });

await step('verify block task has chips + correct text', async () => {
  const rowHTML = await page.$eval('.today-block-tasks .task-row', (el) => el.outerHTML);
  if (!rowHTML.includes('chip-date')) throw new Error('block task missing date chip:\n' + rowHTML);
  if (!rowHTML.includes('chip-priority')) throw new Error('block task missing priority chip:\n' + rowHTML);
});

await step('toggle task done in block, verify strike', async () => {
  await page.click('.today-block-tasks .task-row .task-indicator');
  await new Promise((r) => setTimeout(r, 200));
  const isDone = await page.$eval('.today-block-tasks .task-row', (el) => el.classList.contains('is-done'));
  if (!isDone) throw new Error('task did not get is-done class');
});
await page.screenshot({ path: `${OUT}/10-task-done.png`, fullPage: true });

await step('navigate to Inbox and verify the task synced + done state visible', async () => {
  await page.click('.back-btn');
  await page.waitForSelector('.board', { timeout: 3000 });
  const inboxHandle = await page.evaluateHandle(() => {
    const cards = [...document.querySelectorAll('.tab-card')];
    return cards.find((c) => c.querySelector('.tab-card-title')?.textContent === 'Inbox');
  });
  await inboxHandle.asElement().click();
  await page.waitForSelector('.tab-view', { timeout: 3000 });
  await new Promise((r) => setTimeout(r, 400));
  const items = await page.$$eval('li[data-type="taskItem"]', (els) => els.map((e) => ({
    text: e.querySelector('.task-content')?.textContent ?? '',
    done: e.getAttribute('data-done'),
  })));
  const reviewItem = items.find((i) => i.text.toLowerCase().includes('review designs'));
  if (!reviewItem) throw new Error('"review designs" not in Inbox doc. Items: ' + JSON.stringify(items));
  if (reviewItem.done !== 'true') throw new Error('done state did not sync back. items: ' + JSON.stringify(items));
});
await page.screenshot({ path: `${OUT}/11-synced-back.png`, fullPage: true });

await step('back to board, freeze TODAY snapshot appears', async () => {
  await page.click('.back-btn');
  await page.waitForSelector('.board', { timeout: 3000 });
});

console.log('\nConsole errors:');
for (const e of consoleErrors) console.log('  -', e);
console.log('\nPage errors:');
for (const e of pageErrors) console.log('  -', e);

await browser.close();

if (pageErrors.length || consoleErrors.length) {
  process.exitCode = 1;
}
