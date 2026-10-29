import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const CAPTURE = path.join(HERE, 'capture');
const sha = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const read = file => JSON.parse(fs.readFileSync(file));
function put(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(json(value));
  const fd = fs.openSync(file, 'wx', 0o644);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return { path: path.relative(CAPTURE, file), bytes: bytes.length, sha256: sha(bytes) };
}
function inventory(root, prefix = '') {
  return fs.readdirSync(path.join(root, prefix), { withFileTypes: true }).flatMap(entry => {
    const name = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) return inventory(root, name);
    assert(entry.isFile(), 'Symlinks and special files are not accepted in this fixed packet.');
    const bytes = fs.readFileSync(path.join(root, name));
    return [{ path: name, bytes: bytes.length, mode: fs.statSync(path.join(root, name)).mode & 0o777, sha256: sha(bytes) }];
  }).sort((a, b) => a.path.localeCompare(b.path, 'en'));
}
function runtime() {
  const names = ['package.json', ...fs.readdirSync(path.join(ROOT, 'src')).filter(x => /\.(js|json)$/.test(x)).map(x => 'src/' + x),
    ...fs.readdirSync(path.join(ROOT, 'engines/arbitrum-evm')).filter(x => /\.(js|json)$/.test(x)).map(x => 'engines/arbitrum-evm/' + x)];
  const files = names.map(name => { const target = path.join(ROOT, name), stat = fs.lstatSync(target); assert(stat.isFile()); const bytes = fs.readFileSync(target); return { path: name, bytes: bytes.length, mode: stat.mode & 0o777, sha256: sha(bytes) }; });
  files.push(...inventory(path.join(ROOT, 'engines/arbitrum-evm/node_modules')).map(f => ({ ...f, path: 'engines/arbitrum-evm/node_modules/' + f.path })));
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  return { files, node: { version: process.version, executable: process.execPath, sha256: sha(fs.readFileSync(process.execPath)) } };
}
function verify(planPin) {
  const planBytes = fs.readFileSync(path.join(CAPTURE, 'PLAN.json')); assert.equal(sha(planBytes), planPin);
  const plan = JSON.parse(planBytes), snapshot = read(path.join(CAPTURE, 'runtime-manifest.json'));
  assert.equal(sha(fs.readFileSync(path.join(CAPTURE, 'runtime-manifest.json'))), plan.runtimeManifestSha256);
  for (const f of snapshot.files.filter(f => !f.path.includes('/node_modules/'))) {
    const file = path.join(CAPTURE, 'source', f.path), bytes = fs.readFileSync(file), stat = fs.lstatSync(file);
    assert(stat.isFile()); assert.equal(bytes.length, f.bytes); assert.equal(sha(bytes), f.sha256); assert.equal(stat.mode & 0o777, f.mode);
  }
  assert.deepEqual(runtime(), snapshot); assert.equal(sha(fs.readFileSync(import.meta.filename)), plan.runnerSha256);
  assert.equal(sha(fs.readFileSync(path.join(CAPTURE, 'input.json'))), plan.inputSha256);
  assert.equal(sha(fs.readFileSync(path.join(CAPTURE, 'qualification-header.json'))), plan.qualificationHeaderSha256);
  return plan;
}
if (process.argv[2] === '--prepare') {
  assert.equal(sha(fs.readFileSync(path.join(ROOT, 'research/arbitrum-funded-selection-v1/capture/manifest.json'))), 'fc3733e901257af80399bb98a26f34a02ab82694cecb15aae6d2c48d901ef16e');
  const selection = read(path.join(ROOT, 'research/arbitrum-funded-selection-v1/capture/results.json'));
  const selectionManifest = read(path.join(ROOT, 'research/arbitrum-funded-selection-v1/capture/manifest.json'));
  for (const name of ['results.json', 'selected-header.json']) {
    const row = selectionManifest.files.find(f => f.path === name), bytes = fs.readFileSync(path.join(ROOT, 'research/arbitrum-funded-selection-v1/capture', name));
    assert(row); assert.equal(bytes.length, row.bytes); assert.equal(sha(bytes), row.sha256);
  }
  assert.equal(selection.status, 'selected'); assert(selection.usable && selection.headerConfirmed && selection.sourceUnchanged);
  const input = { ...read(path.join(ROOT, 'src/arbitrum-contract-example.json')), block: selection.selectedHeader.number };
  assert.equal(input.from, selection.selected.address); assert.notEqual(selection.selected.code, '0x');
  const snapshot = runtime(); fs.mkdirSync(CAPTURE);
  const runner = put(path.join(CAPTURE, 'runner.mjs'), fs.readFileSync(import.meta.filename));
  const inputFile = put(path.join(CAPTURE, 'input.json'), input), identity = put(path.join(CAPTURE, 'runtime-manifest.json'), snapshot);
  const qualificationHeader = put(path.join(CAPTURE, 'qualification-header.json'), selection.selectedHeader);
  for (const f of snapshot.files.filter(f => !f.path.includes('/node_modules/'))) {
    put(path.join(CAPTURE, 'source', f.path), fs.readFileSync(path.join(ROOT, f.path)));
    fs.chmodSync(path.join(CAPTURE, 'source', f.path), f.mode);
    const copied = fs.readFileSync(path.join(CAPTURE, 'source', f.path)); assert.equal(copied.length, f.bytes); assert.equal(sha(copied), f.sha256);
  }
  assert.deepEqual(runtime(), snapshot);
  const plan = put(path.join(CAPTURE, 'PLAN.json'), {
    createdAt: new Date().toISOString(), producerRoot: ROOT, runnerSha256: runner.sha256, inputSha256: inputFile.sha256, qualificationHeaderSha256: qualificationHeader.sha256, runtimeManifestSha256: identity.sha256,
    selectionManifestSha256: sha(fs.readFileSync(path.join(ROOT, 'research/arbitrum-funded-selection-v1/capture/manifest.json'))),
    operation: 'One new 100-USDC CCTP call from the selected public contract account at its qualification block; source and hook recipient replace the original zero-balance scenario sender.',
    scope: { developmentExample: true, historicalReplay: false, representativeAccuracy: false, senderKind: 'contract', signingOrContractAuthorizationEstablished: false, broadcast: false, fundsOrAllowanceOverrides: false, destinationCreditVerified: false },
    limits: { targetInvocations: 1, rpcCalls: 20, perResponseBytes: 4194304, totalResponseBytes: 16777216, perRequestMs: 25000, previewMs: 120000, retries: 0, alternateInputsOrProviders: false },
    dependencyArchive: 'Exact dependency bytes were previously preserved in research/arbitrum-viem-deposit-v1; this packet retains their complete current inventory and source copy.'
  });
  console.log(json({ planSha256: plan.sha256, runtimeManifestSha256: identity.sha256, input, files: snapshot.files.length }));
} else if (process.argv[2] === '--run') {
  const planPin = process.argv[3]; verify(planPin);
  put(path.join(CAPTURE, 'STARTED.json'), { planSha256: planPin, at: new Date().toISOString(), pid: process.pid });
  let result, api, adapterInvoked = false, terminalError = null;
  try {
    const { loadArbitrumApi } = await import(pathToFileURL(path.join(ROOT, 'src/arbitrum-loader.js')));
    api = await loadArbitrumApi(); assert(api); verify(planPin);
    adapterInvoked = true;
    result = await api.simulateArbitrum(read(path.join(CAPTURE, 'input.json')));
  } catch (error) {
    terminalError = { code: typeof error?.code === 'string' ? error.code : 'RUNNER_UNAVAILABLE', message: 'The declared adapter attempt could not complete; it was not retried.' };
    result = { status: 'unavailable', error: terminalError, execution: { status: 'unavailable' }, assetChanges: [], rawViem: null, transportEvidence: [], coverage: { inventoryComplete: false, destinationCreditVerified: false }, implementation: api?.implementation ?? null };
  }
  const withhold = code => {
    if (api) api.withholdArbitrumSimulation(result, code);
    else Object.assign(result, { status: 'unavailable', error: { code }, execution: { status: 'unavailable' }, assetChanges: [] });
  };
  const qualificationHeaderConfirmed = isDeepStrictEqual(result.source?.header, read(path.join(CAPTURE, 'qualification-header.json')));
  if (!qualificationHeaderConfirmed) withhold('ARBITRUM_QUALIFICATION_HEADER');
  let sourceUnchanged = false;
  try { verify(planPin); sourceUnchanged = true; } catch { withhold('ARBITRUM_SOURCE_CHANGED'); }
  put(path.join(CAPTURE, 'response.json'), result);
  put(path.join(CAPTURE, 'viem-response.json'), result.rawViem);
  for (const row of result.transportEvidence ?? []) {
    const prefix = path.join(CAPTURE, 'wire', String(row.id).padStart(3, '0'));
    put(prefix + '-request.body', Buffer.from(row.requestText));
    put(prefix + '-response.body', row.responseBase64 ? Buffer.from(row.responseBase64, 'base64') : Buffer.from(row.responseText));
    put(prefix + '-record.json', row);
  }
  put(path.join(CAPTURE, 'verification.json'), { sourceUnchanged, qualificationHeaderConfirmed, adapterInvoked, terminalError, planSha256: planPin, implementation: result.implementation, status: result.status, execution: result.execution, assets: result.assetChanges, usage: result.usage, finishedAt: new Date().toISOString() });
  const manifest = put(path.join(CAPTURE, 'manifest.json'), { planSha256: planPin, files: inventory(CAPTURE) });
  console.log(json({ manifest, sourceUnchanged, qualificationHeaderConfirmed, adapterInvoked, terminalError, status: result.status, execution: result.execution, assets: result.assetChanges, calls: result.usage?.calls, elapsedMs: result.timing?.totalMs }));
} else throw new Error('Use --prepare, then --run EXACT_PLAN_SHA once.');
