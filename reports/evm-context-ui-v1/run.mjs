import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/Users/home/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';

const dir = dirname(fileURLToPath(import.meta.url)), root = resolve(dir, '../..');
const origin = 'http://127.0.0.1:5174', executablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const startedAt = new Date().toISOString(), attempt = startedAt.replaceAll(':', '-');
const out = resolve(dir, 'attempts', attempt); await mkdir(out, { recursive: true });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const files = ['public/app.js', 'public/index.html', 'public/style.css', 'package.json'];
const source = await Promise.all(files.map(async path => { const bytes = await readFile(resolve(root, path)); return { path, bytes: bytes.length, sha256: sha(bytes) }; }));
const report = { schemaVersion: 1, startedAt, finishedAt: null, status: 'running', origin, browser: { executablePath, temporaryProfile: true, userProfileUsed: false, headless: true },
  productVersion: JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')).version, source,
  scope: { realBrowser: true, syntheticResponses: true, providerRpcCalls: 0, localEngineExecutions: 0, productionSourceModified: false, authOrUserProfileUsed: false,
    limitations: ['Submission responses are intercepted synthetic UI controls, not blockchain observations or engine results.', 'Layout checks and screenshots cover the declared desktop and mobile viewport only.'] },
  checks: [], submissions: [], allowedGets: [], blockedRequests: [], pageErrors: [], consoleErrors: [], screenshots: [] };
const check = (name, details = {}) => { report.checks.push({ name, passed: true, ...details }); process.stdout.write(name + '\n'); };
const A = '0x' + '11'.repeat(20), T = '0x' + 'ab'.repeat(20), H = '0x' + '33'.repeat(32), K = '0x' + 'cd'.repeat(32), B = '0x01' + 'ef'.repeat(31);
const accessList = [{ address: T, storageKeys: [K, K] }, { address: T, storageKeys: [H] }], blobVersionedHashes = [B, B];
const declaredContext = { accessList, blobVersionedHashes }, query = { to: T, data: '0x70a08231' + A.slice(2).padStart(64, '0') };
const note = 'SYNTHETIC UI TEST ONLY: intercepted response; no engine execution or public RPC.';
function synthetic(path, body, index) {
  const base = { id: `SYNTHETIC_UI_ONLY_${index}`, apiRequest: body, canonicalStatus: 'unverified', execution: { status: 'unavailable' }, measurementFailure: note,
    source: { blockSelection: { requested: body.block }, canonicalStatus: 'unverified', profile: 'synthetic_ui_only' }, preview: { queries: [], nativeBalances: [], positions: [] }, limitations: [note], timing: { totalMs: 0 } };
  if (path === '/api/evm/local-preview') return { ...base, kind: 'local_proof_preview', status: 'unavailable', error: { code: 'SYNTHETIC_UI_ONLY', message: note }, measurements: (body.queries || []).map(descriptor => ({ descriptor, status: 'unavailable', reason: note, values: null })) };
  if (path === '/api/evm/simulate-sequence') return { ...base, sequence: { status: 'unavailable', completedSteps: 0, attemptedSteps: 0, stoppedAtIndex: null, reason: note }, steps: body.calls.map((input, index) => ({ index, input, status: 'skipped', reason: note, result: null })) };
  return base;
}
let browser, page; const pending = [], tasks = [];
async function snapshot(name) {
  const path = resolve(out, name + '.png'); await page.screenshot({ path, fullPage: true }); const bytes = await readFile(path);
  report.screenshots.push({ path: `attempts/${attempt}/${name}.png`, bytes: bytes.length, sha256: sha(bytes) });
}
async function layout(label) {
  const evidence = await page.evaluate(() => {
    const visible = [...document.querySelectorAll('#transaction-context, .transaction-context-settings textarea')].filter(el => el.getClientRects().length && !el.closest('[hidden]'));
    return { viewport: { width: innerWidth, height: innerHeight }, documentWidth: document.documentElement.scrollWidth,
      contextFields: visible.map(el => { const r = el.getBoundingClientRect(), style = getComputedStyle(el); return { id: el.id, left: r.left, right: r.right, width: r.width, fontSize: style.fontSize, lineHeight: style.lineHeight, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }; }) };
  });
  assert.ok(evidence.documentWidth <= evidence.viewport.width + 1, label + ': horizontal page overflow');
  for (const field of evidence.contextFields) assert.ok(field.left >= 0 && field.right <= evidence.viewport.width + 1 && field.width > 100, label + ': context field clipped');
  check(label + ' layout has no horizontal overflow or clipped context controls', evidence);
}
async function submit(expectedPath, expectedBody) {
  const before = report.submissions.length;
  await page.locator('#simulate-button').click();
  await page.waitForFunction(() => document.querySelector('#simulate-button').disabled);
  while (report.submissions.length === before) await page.waitForTimeout(20);
  const row = report.submissions.at(-1); assert.equal(row.path, expectedPath); assert.deepEqual(row.body, expectedBody);
  assert.equal(await page.locator('#transaction-context').isDisabled(), true);
  assert.equal(await page.locator('#chain').isDisabled(), true); assert.equal(await page.locator('#ethereum-engine').isDisabled(), true);
  check(expectedPath + ' forwards exact context and locks request controls', { submission: row.index });
  return async () => { pending.shift()(); await page.waitForFunction(() => !document.querySelector('#simulate-button').disabled); await page.locator('#raw-details').evaluate(el => { el.open = true; });
    const raw = JSON.parse(await page.locator('#raw-json').textContent()); assert.deepEqual(raw, row.response); assert.equal(raw.id, `SYNTHETIC_UI_ONLY_${row.index}`); };
}
try {
  assert.equal(report.productVersion, '0.15.0');
  browser = await chromium.launch({ executablePath, headless: true, args: ['--disable-background-networking', '--disable-component-update', '--disable-domain-reliability', '--no-default-browser-check'] });
  report.browser.version = browser.version();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, serviceWorkers: 'block' });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    if (url.origin === origin && method === 'POST' && ['/api/evm/simulate', '/api/evm/local-preview', '/api/evm/simulate-sequence'].includes(path)) {
      const bodyText = request.postData(), body = JSON.parse(bodyText), index = report.submissions.length + 1, response = synthetic(path, body, index);
      report.submissions.push({ index, path, method, intercepted: true, reachedProductionHandler: false, bodyText, bodySha256: sha(bodyText), body, response });
      await new Promise(resolve => pending.push(resolve)); await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(response) }); return;
    }
    if (url.origin === origin && method === 'GET' && ['/', '/app.js', '/style.css', '/api/config', '/favicon.ico'].includes(path)) { report.allowedGets.push({ method, path }); await route.continue(); return; }
    report.blockedRequests.push({ method, url: url.href }); await route.abort('blockedbyclient');
  });
  page = await context.newPage(); page.setDefaultTimeout(10000);
  page.on('pageerror', error => report.pageErrors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
  page.on('response', response => { if (response.url() === origin + '/api/config') tasks.push(response.body().then(async bytes => {
    report.config = { bytes: bytes.length, sha256: sha(bytes) }; await writeFile(resolve(out, 'config.json'), bytes);
  })); });
  await page.goto(origin, { waitUntil: 'networkidle' }); await page.locator('#chain option[value="1"]').waitFor({ state: 'attached' });
  await page.evaluate(note => { const label = document.createElement('div'); label.id = 'headless-test-label'; label.textContent = note; Object.assign(label.style, { position: 'fixed', bottom: '0', left: '0', right: '0', zIndex: '10000', padding: '5px 10px', font: '12px sans-serif', color: '#fff', background: '#72501d', textAlign: 'center', pointerEvents: 'none' }); document.body.append(label); }, note);
  assert.equal(await page.locator('#transaction-context-settings').isVisible(), false); check('HyperEVM hides optional Ethereum context');
  await page.locator('#chain').selectOption('1');
  assert.equal(await page.locator('#transaction-context-settings').isVisible(), true); assert.equal(await page.locator('#transaction-context').inputValue(), '');
  assert.equal(await page.locator('#transaction-context-settings').evaluate(el => el.open), false); check('Ethereum context is visible as collapsed Advanced with a blank default');
  await page.locator('#transaction-context-settings > summary').click(); await layout('Desktop blank context'); await snapshot('01-desktop-context-blank');
  for (const [id, value] of Object.entries({ from: A, to: T, data: '0x', value: '0', block: H })) await page.locator('#' + id).fill(value);
  await page.locator('#transaction-context').fill('{invalid'); const count = report.submissions.length; await page.locator('#simulate-button').click();
  assert.equal(report.submissions.length, count); assert.match(await page.locator('#transaction-context').evaluate(el => el.validationMessage), /valid JSON/); check('Malformed context blocks submission with native field feedback');
  await page.locator('#transaction-context').fill(JSON.stringify(declaredContext, null, 2));
  let finish = await submit('/api/evm/simulate', { chainId: 1, from: A, to: T, data: '0x', value: '0', block: H, ...declaredContext });
  await snapshot('02-provider-request-locked'); await finish(); await snapshot('03-provider-synthetic-response');
  await page.locator('#ethereum-engine').selectOption('local'); await page.locator('#standard-queries').fill(JSON.stringify([query]));
  assert.equal(await page.locator('#transaction-context').inputValue(), JSON.stringify(declaredContext, null, 2));
  finish = await submit('/api/evm/local-preview', { chainId: 1, from: A, to: T, data: '0x', value: '0', block: H, queries: [query], ...declaredContext }); await finish();
  assert.match(await page.locator('#execution-error').textContent(), /SYNTHETIC UI TEST ONLY/); await snapshot('04-local-synthetic-response');
  await page.locator('#ethereum-engine').selectOption('provider'); await page.locator('#ethereum-call-mode').selectOption('sequence');
  assert.equal(await page.locator('#transaction-context').inputValue(), ''); assert.equal(await page.locator('#transaction-context-settings').isVisible(), false);
  const rows = page.locator('.sequence-call'); assert.equal(await rows.count(), 2);
  for (let i = 0; i < 2; i++) { await rows.nth(i).locator('.transaction-context-settings > summary').click(); assert.equal(await rows.nth(i).locator('.transaction-context-settings textarea').inputValue(), ''); }
  await rows.nth(0).locator('.transaction-context-settings textarea').fill(JSON.stringify({ accessList }, null, 2));
  await rows.nth(1).locator('.transaction-context-settings textarea').fill(JSON.stringify({ blobVersionedHashes }, null, 2));
  await rows.nth(0).getByRole('button', { name: 'Move down step 1' }).click();
  const calls = await rows.evaluateAll(elements => elements.map(row => ({ to: row.querySelector('input[id$="-to"]').value, data: row.querySelector('textarea[id$="-data"]').value, value: row.querySelector('input[id$="-value"]').value, ...JSON.parse(row.querySelector('.transaction-context-settings textarea').value) })));
  assert.deepEqual(calls[0].blobVersionedHashes, blobVersionedHashes); assert.deepEqual(calls[1].accessList, accessList); assert.equal(Object.hasOwn(calls[0], 'accessList'), false);
  const from = await page.locator('#from').inputValue(), block = await page.locator('#block').inputValue();
  finish = await submit('/api/evm/simulate-sequence', { chainId: 1, from, block, calls });
  assert.equal(await rows.nth(0).locator('.transaction-context-settings textarea').isDisabled(), true); await finish();
  for (let i = 0; i < 2; i++) await rows.nth(i).locator('.transaction-context-settings').evaluate(el => { el.open = true; });
  await layout('Desktop sequence context'); await snapshot('05-sequence-synthetic-response');
  await page.locator('#simulation-form').evaluate(form => form.reset());
  assert.equal(await page.locator('#transaction-context').inputValue(), '');
  for (let i = 0; i < 2; i++) assert.equal(await rows.nth(i).locator('.transaction-context-settings textarea').inputValue(), '');
  check('Native form reset clears global and every per-step context');
  await page.locator('#chain').selectOption('1'); await page.locator('#transaction-context-settings > summary').click();
  await page.locator('#transaction-context').fill(JSON.stringify(declaredContext)); await page.locator('#example').selectOption('');
  assert.equal(await page.locator('#transaction-context').inputValue(), ''); check('Choosing a custom example clears prior context');
  const exampleValue = await page.locator('#example option').nth(1).getAttribute('value');
  await page.locator('#transaction-context-settings').evaluate(el => { el.open = true; }); await page.locator('#transaction-context').fill(JSON.stringify(declaredContext));
  await page.locator('#example').selectOption(exampleValue); assert.equal(await page.locator('#transaction-context').inputValue(), ''); check('Loading a recorded example clears unrelated context');
  await page.locator('#transaction-context-settings').evaluate(el => { el.open = true; }); await page.locator('#transaction-context').fill(JSON.stringify(declaredContext)); await page.locator('#chain').selectOption('999');
  assert.equal(await page.locator('#transaction-context').inputValue(), ''); assert.equal(await page.locator('#transaction-context-settings').isVisible(), false);
  await page.locator('#chain').selectOption('1'); assert.equal(await page.locator('#transaction-context').inputValue(), ''); check('Network round-trip clears and hides stale context');
  const blankBody = await page.evaluate(() => Object.fromEntries(['chain', 'from', 'to', 'data', 'value', 'block'].map(id => [id === 'chain' ? 'chainId' : id, id === 'chain' ? Number(document.getElementById(id).value) : document.getElementById(id).value])));
  finish = await submit('/api/evm/simulate', blankBody); await finish(); check('Blank context forwards neither optional field');
  await page.locator('#transaction-context-settings').evaluate(el => { el.open = true; }); await page.locator('#transaction-context').fill(JSON.stringify(declaredContext, null, 2));
  await page.setViewportSize({ width: 390, height: 844 }); await layout('Mobile populated context'); await snapshot('06-mobile-context');
  assert.equal(report.submissions.length, 4); assert.equal(report.blockedRequests.length, 0); assert.deepEqual(report.pageErrors, []);
  check('All four POSTs intercepted; no simulation handler or public RPC reached; no page errors');
  const after = await Promise.all(files.map(async path => ({ path, sha256: sha(await readFile(resolve(root, path))) })));
  assert.deepEqual(after, source.map(({ path, sha256 }) => ({ path, sha256 }))); check('UI/package source unchanged throughout browser check');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = { name: error.name, message: error.message, stack: error.stack };
  if (page) { try { await snapshot('failure'); } catch {} }
  process.exitCode = 1;
} finally {
  for (const release of pending.splice(0)) release();
  if (browser) await browser.close(); await Promise.allSettled(tasks);
  report.finishedAt = new Date().toISOString();
  await writeFile(resolve(out, 'browser-checks.json'), JSON.stringify(report, null, 2) + '\n');
  await writeFile(resolve(dir, 'browser-checks.json'), JSON.stringify({ ...report, attemptDirectory: `attempts/${attempt}` }, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ status: report.status, checks: report.checks.length, submissions: report.submissions.length, report: resolve(dir, 'browser-checks.json'), error: report.error?.message }) + '\n');
}
