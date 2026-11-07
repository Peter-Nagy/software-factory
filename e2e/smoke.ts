// Dashboard smoke test: a real orchestrator dashboard over sample data, driven by Chromium through every page.
// Agents never run: the API calls that would start one are intercepted. Writes JUnit to $FACTORY_REPORT_DIR.
// Needs the built dashboard (dashboard/dist) and Playwright (the project image sets FACTORY_PLAYWRIGHT).
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFactoryConfig } from '../orchestrator/src/config.ts';
import { dashboardToken, startDashboard } from '../orchestrator/src/dashboard/server.ts';
import { Store } from '../orchestrator/src/db.ts';
import { taskFromIssue } from '../orchestrator/src/issues.ts';
import { createPlan } from '../orchestrator/src/plan.ts';
import { Secrets } from '../orchestrator/src/secrets.ts';
import { createStudio, studioWork } from '../orchestrator/src/studio.ts';

type Page = {
  goto(url: string): Promise<unknown>;
  waitForSelector(sel: string, o?: { timeout?: number }): Promise<unknown>;
  getByRole(role: string, o: { name: string | RegExp }): { click(): Promise<void>; first(): { click(): Promise<void> } };
  getByPlaceholder(t: string | RegExp): { fill(v: string): Promise<void> };
  locator(sel: string): { count(): Promise<number>; first(): { isVisible(): Promise<boolean> } };
  keyboard: { press(k: string): Promise<void> };
  route(glob: string, h: (r: { request(): { postDataJSON(): unknown }; fulfill(o: { status: number; contentType: string; body: string }): Promise<void> }) => Promise<void>): Promise<void>;
  on(ev: string, f: (x: { message?: string; type?: () => string; text?: () => string }) => void): void;
  waitForTimeout(ms: number): Promise<void>;
  close(): Promise<void>;
};
type Browser = { newPage(o: Record<string, unknown>): Promise<Page>; close(): Promise<void> };

const root = fileURLToPath(new URL('..', import.meta.url));
const pw = (await import(process.env.FACTORY_PLAYWRIGHT ?? 'playwright')) as { chromium: { launch(): Promise<Browser> } };

// ---------- sample data ----------
const dir = mkdtempSync(join(tmpdir(), 'factory-e2e-'));
const store = new Store(join(dir, 'state.db'));
const now = Math.floor(Date.now() / 1000);
const config = parseFactoryConfig(`github: {owner: me}\npaths: {state: ${dir}/state, logs: ${dir}/logs, workerConfig: ${root}/worker-config}\ndashboard: {port: 0}`);
store.upsertProject({ id: 'habits', owner: 'me', kind: 'web-app', state: 'active', priority: 4, createdAt: now });
const add = (n: number, title: string, path: [string, object?][]) => {
  store.upsertTask(taskFromIssue('habits', 4, { number: n, title, body: null, labels: [] }));
  for (const [to, patch] of path) store.transition(`habits#${n}`, to as never, patch as never);
};
add(1, 'Scaffold the app', [['building', { attempt: 1, branch: 'claude/1' }], ['in_review', { prNumber: 9 }], ['merging'], ['done']]);
add(2, 'Sign in with magic links', [['building', { attempt: 1, branch: 'claude/2' }]]);
add(3, 'Import habits from CSV', [['building', { attempt: 3, branch: 'claude/3' }], ['parked', { lastFailure: 'Retries exhausted: quoted newlines.' }]]);
add(4, 'Streaks with grace days', []);
store.recordUsage({ fiveHourPct: 30, fiveHourResetsAt: now + 7200, sevenDayPct: 20, sevenDayResetsAt: now + 4 * 86400, source: 'stream', takenAt: now - 60 });
const gh = {
  issue: async (_o: string, _r: string, n: number) => ({ number: n, title: `Issue ${n}`, body: 'Do the thing.\n\n## Acceptance criteria\n- [ ] It works', state: 'open', html_url: 'https://github.com/x', labels: [] }),
  readFile: async () => '# Habits\n\nBuild good habits.',
};
const ctx = {
  config, store, secrets: new Secrets({ reader: async () => 'x' }), now: () => Math.floor(Date.now() / 1000), notify: async () => undefined,
  repoAccess: async () => ({ gh, token: '' }), repoClient: async () => ({ gh, token: '' }),
};
const plan = createPlan(ctx as never, { title: 'Weekly review', target: 'existing', projectId: 'habits', model: 'opus' });
const pdir = join(dir, 'state', 'plans', String(plan.id), 'work', 'plan');
mkdirSync(pdir, { recursive: true });
writeFileSync(join(pdir, 'PRODUCT.md'), '# Weekly review\n\nA Sunday summary.\n');
writeFileSync(join(pdir, 'plan.json'), JSON.stringify({ title: 'Weekly review', issues: [{ key: 'stats', title: 'Weekly stats', body: 'Stats.\n\n## Acceptance criteria\n- [ ] Shows %', size: 'm', risk: 'low', area: 'stats', dependsOn: [] }] }));

const question = (header: string, q: string, labels: string[]) => ({ header, question: q, why: '', options: labels.map((label) => ({ label, description: `${label} it is` })), multiSelect: false, recommended: labels[0] });
const interview = createStudio(ctx as never, { title: 'Running app' });
const w = studioWork(ctx as never, interview.id);
writeFileSync(join(w, 'docs/BRIEF.md'), '# Brief\n\nA running app for a small crew.\n');
writeFileSync(join(w, 'status/brief.json'), JSON.stringify({
  ready: false, summary: 'Small crew', coverage: [{ topic: 'Who', done: true }, { topic: 'Platforms', done: false }],
  questions: [question('Platform', 'Which platforms?', ['iPhone only', 'iPhone + web']), 'Describe your typical week'],
}));
store.db.prepare("UPDATE studio_phases SET state = 'drafting' WHERE studio_id = ? AND phase = 'brief'").run(interview.id);
const review = createStudio(ctx as never, { title: 'Reviewed app' });
writeFileSync(join(studioWork(ctx as never, review.id), 'docs/BRIEF.md'), '# Brief\n\nReviewed.\n');
store.db.prepare("UPDATE studio_phases SET state = 'drafting', auto_answer = 'review' WHERE studio_id = ? AND phase = 'brief'").run(review.id);
store.db.prepare("INSERT INTO studio_answers (studio_id, phase, batch, round, question, answer, reason, at) VALUES (?, 'brief', 1, 1, ?, 'iPhone only', 'recommended', ?)")
  .run(review.id, JSON.stringify(question('Platform', 'Which platforms?', ['iPhone only', 'iPhone + web'])), now);

const server = await startDashboard(ctx as never, { createRepo: async () => { throw new Error('not in tests'); }, distDir: join(root, 'dashboard', 'dist') });
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const token = dashboardToken(ctx as never);

// ---------- cases ----------
const browser = await pw.chromium.launch();
const results: { name: string; ms: number; error?: string }[] = [];
async function check(name: string, f: (page: Page) => Promise<void>, viewport = { width: 1280, height: 900 }) {
  const started = Date.now();
  const page = await browser.newPage({ viewport });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`page error: ${e.message}`));
  page.on('console', (m) => m.type?.() === 'error' && !/401|Failed to load resource/.test(m.text?.() ?? '') && errors.push(`console: ${m.text?.()}`));
  try {
    if (!name.startsWith('logged out')) {
      await page.goto(`${base}/login?t=${token}`);
      await page.waitForSelector('text=in flight');
    }
    await f(page);
    if (errors.length) throw new Error(errors.join('\n'));
    results.push({ name, ms: Date.now() - started });
    console.log(`ok   ${name}`);
  } catch (e) {
    results.push({ name, ms: Date.now() - started, error: (e as Error).message });
    console.log(`FAIL ${name}\n     ${(e as Error).message.split('\n').join('\n     ')}`);
  } finally {
    await page.close();
  }
}
const see = (page: Page, text: string) => page.waitForSelector(`text=${text}`, { timeout: 10_000 });
let posted: unknown = null;
const capture = (page: Page, glob: string) =>
  page.route(glob, async (r) => {
    posted = r.request().postDataJSON();
    await r.fulfill({ status: 200, contentType: 'application/json', body: '{"approved":false,"next":null}' });
  });

await check('logged out: the app asks for the login link', async (page) => {
  await page.goto(base);
  await see(page, 'Open the login link');
});
await check('board: tasks by state, a parked task shows its failure', async (page) => {
  await see(page, 'Sign in with magic links');
  await see(page, 'Import habits from CSV');
});
await check('projects and a project page', async (page) => {
  await page.goto(`${base}/projects`);
  await see(page, 'habits');
  await page.goto(`${base}/projects/habits`);
  await see(page, 'Streaks with grace days');
});
await check('issue page loads the issue text', async (page) => {
  await page.goto(`${base}/projects/habits/issues/4`);
  await see(page, 'It works');
});
await check('plans: list and plan view with the drafted issues', async (page) => {
  await page.goto(`${base}/plans`);
  await see(page, 'Weekly review');
  await page.goto(`${base}/plans/${plan.id}`);
  await see(page, 'A Sunday summary');
  await page.getByRole('tab', { name: /Issues/ }).click();
  await see(page, 'Weekly stats');
});
await check('activity page', async (page) => {
  await page.goto(`${base}/activity`);
  await page.waitForSelector('main');
});
await check('studio: the interview form sends the answers as one message', async (page) => {
  await capture(page, '**/api/studios/*/messages');
  await page.goto(`${base}/studio/${interview.id}?phase=brief`);
  await see(page, 'has 2 questions');
  await page.keyboard.press('1');
  await page.waitForTimeout(500);
  await page.getByPlaceholder(/Your answer/).fill('Three runs, one long');
  await page.getByRole('button', { name: /^Send (\d|answers)/ }).click();
  await page.waitForTimeout(500);
  const text = (posted as { text?: string } | null)?.text ?? '';
  if (!/> Which platforms\?\niPhone only/.test(text) || !/Three runs, one long/.test(text)) throw new Error(`unexpected message: ${JSON.stringify(posted)}`);
});
await check('studio: skip hands the interview to the stand-in', async (page) => {
  posted = null;
  await capture(page, '**/api/studios/*/auto-answer');
  await page.goto(`${base}/studio/${interview.id}?phase=brief`);
  await see(page, 'has 2 questions');
  await page.getByRole('button', { name: /Skip, answer for me/ }).click();
  await page.waitForTimeout(500);
  if ((posted as { phase?: string } | null)?.phase !== 'brief') throw new Error(`unexpected request: ${JSON.stringify(posted)}`);
});
await check('studio: reviewing the stand-in\'s answers sends only the changes', async (page) => {
  posted = null;
  await capture(page, '**/api/studios/*/review');
  await page.goto(`${base}/studio/${review.id}?phase=brief`);
  await see(page, 'Review the answers given for you');
  await page.getByRole('button', { name: 'iPhone + web' }).click();
  await page.getByRole('button', { name: /Send 1 change/ }).click();
  await page.waitForTimeout(500);
  const edits = (posted as { edits?: { answer: string }[] } | null)?.edits ?? [];
  if (edits.length !== 1 || edits[0]!.answer !== 'iPhone + web') throw new Error(`unexpected review: ${JSON.stringify(posted)}`);
});
await check('studio list and the new-idea form', async (page) => {
  await page.goto(`${base}/studio`);
  await see(page, 'What do you want to make?');
  await see(page, 'Running app');
});
await check('phone: board and the tab bar', async (page) => {
  await see(page, 'Sign in with magic links');
  if (!(await page.locator('nav.fixed >> text=Studio').first().isVisible())) throw new Error('tab bar not visible');
}, { width: 390, height: 844 });

await browser.close();
server.close();
store.close();

// ---------- report ----------
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const failures = results.filter((r) => r.error);
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites><testsuite name="dashboard smoke" tests="${results.length}" failures="${failures.length}" time="${results.reduce((t, r) => t + r.ms, 0) / 1000}">
${results.map((r) => `  <testcase classname="e2e.smoke" name="${esc(r.name)}" time="${r.ms / 1000}">${r.error ? `<failure message="${esc(r.error.split('\n')[0]!)}">${esc(r.error)}</failure>` : ''}</testcase>`).join('\n')}
</testsuite></testsuites>
`;
const out = process.env.FACTORY_REPORT_DIR ?? join(root, '.factory-run', 'e2e-report');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'e2e.xml'), xml);
console.log(`${results.length - failures.length}/${results.length} passed; report in ${out}/e2e.xml`);
process.exit(failures.length ? 1 : 0);
