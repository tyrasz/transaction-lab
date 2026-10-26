// Bounded, one-shot development capture. --check is entirely offline.
// --run requires the exact SHA-256 of the separately reviewed plan.json.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../..');
const planPath = path.join(directory, 'plan.json');
const enginePath = 'engines/standard-evm/unsigned-call.js';
const runnerPath = 'reports/standard-evm-deposits-v2/capture.mjs';
const packageRoot = 'engines/standard-evm';
const nobleRoot = packageRoot + '/node_modules/@noble/hashes';
const nobleIntegrity = 'sha512-X5XaVWZIBCT7HHZGm5I7ZQXDwLG+bGXuSrMQAW+7Zvl87h1kmc1ZB1VSRJcpUfoUrGQp4Fkoxm5kZ+Ms+aW+eA==';
const ENDPOINT = 'https://eth.drpc.org';
const LIMITS = Object.freeze({ totalRpc: 150, caseRpc: 75, responseBytes: 8 * 1024 * 1024, totalResponseBytes: 32 * 1024 * 1024, requestMs: 25000, totalMs: 480000 });
const SELECTED = [
  ['aave-usdc-supply-with-permit', '0x6166280a62cdad28e7b8af05ebb622b42b61deff981b3b6cd83dc03b3bb130b2', '0x4badf912d1bcc7f77197108544be0ab4b8cef7a94fb7a4ee1e65fda816300dc7', 4],
  ['morpho-kiln-usdc-deposit', '0xc46259d8064831c47c68776ca0611af75337adf8c4aee4bee5add0878b8873a7', '0x00cbe8bb974276f900d767a7853e0011817eeebbea1d9525e7c1fb230fd21d61', 8],
];
const METHODS = new Set(['eth_chainId', 'eth_getBlockByHash', 'eth_getBlockByNumber', 'eth_getTransactionCount', 'eth_getBalance', 'eth_getCode', 'debug_traceCall']);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const need = (condition, message) => { if (!condition) throw new Error(message); };
const inside = relative => {
  const resolved = path.resolve(root, relative);
  need(resolved.startsWith(root + path.sep), 'A bound file escaped the repository.');
  return resolved;
};
const quantity = value => '0x' + BigInt(value).toString(16);
const word = address => address.slice(2).padStart(64, '0');
const balanceData = account => '0x70a08231' + word(account);
const allowanceData = (owner, spender) => '0xdd62ed3e' + word(owner) + word(spender);
const runtime = () => ({ node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch });
const terminal = (code, extra = {}) => ({ code, message: ({
  RPC_BUDGET: 'The frozen RPC budget was exhausted.',
  WALL_BUDGET: 'The frozen wall-clock budget was exhausted.',
  BYTE_BUDGET: 'The frozen response byte budget was exhausted.',
  TRANSPORT: 'The public read-only request did not complete.',
  HTTP: 'The public endpoint returned an unsuccessful HTTP status.',
  UTF8: 'The response is not strict UTF-8 JSON.',
  JSON: 'The response is not valid JSON.',
  ENVELOPE: 'The endpoint returned an invalid JSON-RPC envelope.',
  RPC: 'The endpoint returned a JSON-RPC error.',
  UNSAFE_REQUEST: 'The engine attempted a request outside the frozen read-only scope.',
  ENGINE: 'The engine did not return normally.',
})[code], ...extra });
const fail = diagnostic => { const error = new Error(diagnostic.message); error.diagnostic = diagnostic; throw error; };

async function inventory() {
  const found = new Map();
  async function add(relative) {
    const absolute = inside(relative);
    need(await fs.realpath(absolute) === absolute, 'Source inventory does not admit symlinked files.');
    const bytes = await fs.readFile(absolute);
    found.set(relative, { path: relative, bytes: bytes.length, sha256: hash(bytes) });
    return bytes;
  }
  const packageJson = JSON.parse(await add(packageRoot + '/package.json'));
  const lock = JSON.parse(await add(packageRoot + '/package-lock.json'));
  const installed = JSON.parse(await add(nobleRoot + '/package.json'));
  const rootPackage = JSON.parse(await add('package.json'));
  await add(nobleRoot + '/LICENSE');
  need(rootPackage.type === 'module' && packageJson.type === 'module', 'The source ESM package scopes changed.');
  need(equal(packageJson.dependencies, { '@noble/hashes': '2.4.0' }), 'The declared isolated dependency changed.');
  need(lock.lockfileVersion === 3 && equal(lock.packages[''].dependencies, packageJson.dependencies), 'The dependency lock root differs.');
  need(Object.keys(lock.packages).sort().join(',') === ',node_modules/@noble/hashes', 'The isolated dependency lock has an unexpected package.');
  const locked = lock.packages['node_modules/@noble/hashes'];
  need(locked.version === '2.4.0' && locked.integrity === nobleIntegrity && locked.resolved === 'https://registry.npmjs.org/@noble/hashes/-/hashes-2.4.0.tgz', 'The locked dependency identity changed.');
  need(installed.name === '@noble/hashes' && installed.version === '2.4.0' && installed.type === 'module' && installed.exports['./sha3.js'] === './sha3.js' && Object.keys(installed.dependencies ?? {}).length === 0, 'The installed dependency identity or entry point changed.');
  async function collect(relative) {
    if (found.has(relative)) return;
    const bytes = await add(relative);
    const source = bytes.toString('utf8');
    // This admitted closure uses static ESM only. Anchor actual import/export
    // statements; noble's JSDoc contains examples that are not runtime imports.
    need(!/\b(?:import\s*\(|require\s*\()/.test(source), 'Unexpected dynamic engine dependency.');
    for (const match of source.matchAll(/^[ \t]*(?:import|export)\s+(?:(?:[^'";]+?)\s+from\s*)?['"]([^'"]+)['"]/gm)) {
      const specifier = match[1];
      if (specifier.startsWith('node:')) continue;
      let absolute;
      if (specifier.startsWith('.')) absolute = path.resolve(path.dirname(inside(relative)), specifier);
      else {
        need(specifier === '@noble/hashes/sha3.js', 'Unexpected external engine dependency.');
        absolute = createRequire(inside(relative)).resolve(specifier);
        need(absolute === inside(nobleRoot + '/sha3.js'), 'Node resolved the dependency outside the frozen isolated package.');
      }
      const dependency = path.relative(root, absolute);
      await collect(dependency);
    }
  }
  await collect(enginePath);
  for (const required of ['sha3.js', '_u64.js', 'utils.js']) need(found.has(nobleRoot + '/' + required), 'The required hash implementation closure is incomplete.');
  await add(runnerPath);
  await add('reports/standard-evm-deposits-v2/verify.mjs');
  return [...found.values()].sort((a, b) => a.path.localeCompare(b.path));
}

async function archiveSources(sources) {
  const archive = [];
  for (const source of sources) {
    const bytes = await fs.readFile(inside(source.path));
    need(bytes.length === source.bytes && hash(bytes) === source.sha256, 'Source changed before archival.');
    const archiveFile = 'sources/' + source.path;
    const destination = path.join(directory, archiveFile);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, bytes, { flag: 'wx' });
    archive.push({ ...source, archiveFile });
  }
  return archive;
}

async function readEvidence(reference) {
  const bytes = await fs.readFile(inside(reference.path));
  need(bytes.length === reference.bytes && hash(bytes) === reference.sha256, 'A frozen discovery metadata file changed.');
  const metadata = JSON.parse(bytes.toString('utf8'));
  const bodyPath = path.posix.join('reports/standard-evm-discovery', metadata.raw.file);
  const body = await fs.readFile(inside(bodyPath));
  need(bodyPath === reference.body.path && body.length === reference.body.bytes && hash(body) === reference.body.sha256, 'A frozen discovery response body changed.');
  need(metadata.raw.bytes === body.length && metadata.raw.sha256 === hash(body), 'Discovery metadata does not bind its response body.');
  if (metadata.request.body?.jsonrpc === '2.0') {
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body));
    need(equal(parsed, metadata.response), 'Discovery parsed JSON differs from its raw body.');
  }
  return metadata.response?.result;
}

async function check() {
  const bytes = await fs.readFile(planPath), plan = JSON.parse(bytes.toString('utf8'));
  need(plan.schemaVersion === '2' && plan.endpoint === ENDPOINT && plan.chainId === '1', 'Unexpected survey chain or endpoint.');
  need(equal(plan.limits, LIMITS) && plan.engine === enginePath, 'The frozen execution limits or engine changed.');
  need(plan.cases?.length === SELECTED.length && plan.receiptsAreComparisonOnly === true && plan.profile === 'unsigned_unpriced_parent_block_end', 'Unexpected capture scope.');
  const priorPlanBytes = await fs.readFile(inside(plan.previousPlan.path));
  const priorCaptureBytes = await fs.readFile(inside(plan.previousCapture.path));
  need(hash(priorPlanBytes) === '18ca6712e4142cdb52ee80564ed2709437a19422942a151feb58311f628117df' && hash(priorPlanBytes) === plan.previousPlan.sha256, 'The first-attempt plan changed.');
  need(hash(priorCaptureBytes) === 'e0bde3899b5dc2795206ed70b6faa82f2a8bcaa5f8f82a79c3151f2fa093f778' && hash(priorCaptureBytes) === plan.previousCapture.sha256, 'The first-attempt capture changed.');
  need(equal(plan.cases, JSON.parse(priorPlanBytes).cases), 'The adapter follow-up changed a case, envelope, or query role.');
  need(plan.sourceBinding === 'frozen', 'Final engine release and explicit source binding are still pending.');
  need(plan.dependency.name === '@noble/hashes' && plan.dependency.version === '2.4.0' && plan.dependency.packageRoot === nobleRoot && plan.dependency.entry === '@noble/hashes/sha3.js' && plan.dependency.lockIntegrity === nobleIntegrity, 'The plan dependency identity changed.');
  const selection = await fs.readFile(inside(plan.discoverySelection.path));
  need(selection.length === plan.discoverySelection.bytes && hash(selection) === plan.discoverySelection.sha256, 'The frozen discovery selection changed.');
  const sources = await inventory();
  need(equal(sources, plan.sourceInventory), 'Engine or runner source changed; a new explicit review/binding is required.');
  for (let i = 0; i < SELECTED.length; i++) {
    const c = plan.cases[i], [id, txHash, parent, count] = SELECTED[i];
    need(c.id === id && c.originalTransactionHash === txHash && c.blockHash === parent && c.queries.length === count, 'Selected cases or query counts changed.');
    const evidence = {};
    for (const [name, reference] of Object.entries(c.references)) evidence[name] = await readEvidence(reference);
    const { transaction: tx, receipt, originalBlock, parentBlock } = evidence;
    need(tx.hash === txHash && tx.chainId === '0x1' && tx.value === '0x0', 'The original transaction envelope is not the selected zero-value Ethereum call.');
    need(tx.blockHash === originalBlock.hash && tx.blockNumber === originalBlock.number && originalBlock.parentHash === parent && parentBlock.hash === parent && BigInt(parentBlock.number) + 1n === BigInt(originalBlock.number), 'Original and parent block identities do not agree.');
    need(receipt.transactionHash === txHash && receipt.blockHash === tx.blockHash && receipt.from === tx.from && receipt.to === tx.to && receipt.status === '0x1', 'Original receipt identity is inconsistent.');
    need(receipt.blockNumber === tx.blockNumber && receipt.transactionIndex === tx.transactionIndex && originalBlock.transactions[Number(BigInt(tx.transactionIndex))] === txHash, 'Original transaction position references are inconsistent.');
    need(equal(c.request, { from: tx.from, to: tx.to, data: tx.input, gas: '0x4c4b40', value: '0x0' }), 'The unsigned request changed original calldata or accounts.');
    need(c.blockNumber === BigInt(parentBlock.number).toString() && c.parentTimestamp === BigInt(parentBlock.timestamp).toString(), 'Frozen parent metadata does not agree.');
    const keys = new Set();
    for (const query of c.queries) {
      need(query.kind === 'balanceOf' || query.kind === 'allowance', 'Unsupported query kind.');
      need(/^0x[0-9a-f]{40}$/.test(query.token) && /^0x[0-9a-f]{40}$/.test(query.account ?? query.owner), 'Malformed query account.');
      if (query.kind === 'allowance') need(/^0x[0-9a-f]{40}$/.test(query.spender), 'Malformed query spender.');
      const data = query.kind === 'balanceOf' ? balanceData(query.account) : allowanceData(query.owner, query.spender);
      need(equal(query.call, { to: query.token, data }) && !keys.has(query.token + data), 'Malformed or duplicate encoded query.');
      keys.add(query.token + data);
      need(Array.isArray(query.roleEvidence) && query.roleEvidence.length > 0, 'Query roles lack recorded provenance.');
      for (const proof of query.roleEvidence) {
        if (proof.source === 'transaction') need(tx[proof.field] === proof.equals, 'Transaction role evidence differs.');
        else if (proof.source === 'calldataWord') need('0x' + tx.input.slice(10 + proof.word * 64 + 24, 10 + (proof.word + 1) * 64) === proof.equals, 'Calldata account evidence differs.');
        else if (proof.source === 'receiptLog') {
          const log = receipt.logs[proof.arrayIndex];
          need(log && log.address === proof.address && log.topics[0] === proof.topic0 && log.topics[proof.topicIndex] === '0x' + word(proof.equals), 'Receipt role evidence differs.');
        } else throw new Error('Unknown role evidence type.');
      }
    }
  }
  return { plan, planSha256: hash(bytes), sources };
}

function validateRpcRequest(method, params, c) {
  need(METHODS.has(method) && Array.isArray(params), 'Unapproved RPC method.');
  if (method === 'eth_chainId') need(params.length === 0, 'Unexpected chain query.');
  else if (method === 'eth_getBlockByHash') need(equal(params, [c.blockHash, false]), 'Unpinned header query.');
  else if (method === 'eth_getBlockByNumber') need(equal(params, [quantity(c.blockNumber), false]), 'Unpinned canonical header query.');
  else need(equal(params[1], { blockHash: c.blockHash, requireCanonical: true }), 'Unpinned state query.');
}

async function run(checked) {
  const { plan, planSha256, sources } = checked;
  const runtimeIdentity = runtime();
  await fs.writeFile(path.join(directory, 'STARTED.json'), json({ startedAt: new Date().toISOString(), planSha256, sources, runtime: runtimeIdentity }), { flag: 'wx' });
  const started = performance.now(), rawDirectory = path.join(directory, 'raw');
  await fs.mkdir(rawDirectory, { recursive: false });
  const capture = { schemaVersion: '2', kind: 'experimental_standard_evm_deposit_capture', startedAt: new Date().toISOString(), planSha256, plan, sourceInventoryBefore: sources, runtime: runtimeIdentity, cases: [], limits: LIMITS, accounting: { attemptedRpc: 0, completedBodies: 0, observedResponseBytes: 0, retainedResponseBytes: 0 }, warnings: plan.warnings };
  capture.sourceArchive = await archiveSources(sources);
  const { simulateUnsignedCall } = await import(pathToFileURL(inside(enginePath)).href);
  let stopReason = null;
  for (const c of plan.cases) {
    const entry = { id: c.id, provider: 'ethereum-drpc-public', originalTransactionHash: c.originalTransactionHash, blockHash: c.blockHash, request: c.request, queryRoles: c.queries, receiptReference: c.references.receipt, rpcCalls: [], startedAt: new Date().toISOString() };
    capture.cases.push(entry);
    const rpc = { async call(method, params) {
      const elapsed = performance.now() - started;
      if (stopReason) fail(stopReason);
      if (elapsed >= LIMITS.totalMs) { stopReason = terminal('WALL_BUDGET'); fail(stopReason); }
      if (capture.accounting.attemptedRpc >= LIMITS.totalRpc || entry.rpcCalls.length >= LIMITS.caseRpc) fail(terminal('RPC_BUDGET'));
      if (capture.accounting.retainedResponseBytes >= LIMITS.totalResponseBytes) { stopReason = terminal('BYTE_BUDGET'); fail(stopReason); }
      try { validateRpcRequest(method, params, c); } catch { fail(terminal('UNSAFE_REQUEST')); }
      const id = ++capture.accounting.attemptedRpc;
      const request = { jsonrpc: '2.0', id, method, params: structuredClone(params) }, requestText = JSON.stringify(request);
      const item = { sequence: id, caseSequence: entry.rpcCalls.length + 1, startedAt: new Date().toISOString(), request: { url: ENDPOINT, method: 'POST', headers: { 'content-type': 'application/json' }, body: request, bodyText: requestText, bodyBytes: Buffer.byteLength(requestText), bodySha256: hash(requestText) } };
      entry.rpcCalls.push(item);
      const callStart = performance.now(), controller = new AbortController();
      const timeoutMs = Math.max(1, Math.min(LIMITS.requestMs, LIMITS.totalMs - elapsed));
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const chunks = []; let received = 0, retained = 0, complete = false;
      const receivedHash = createHash('sha256');
      try {
        const response = await fetch(ENDPOINT, { method: 'POST', headers: item.request.headers, body: requestText, signal: controller.signal, redirect: 'error' });
        item.http = { status: response.status, headers: Object.fromEntries(response.headers) };
        const reader = response.body.getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) { complete = true; break; }
          const bytes = Buffer.from(value); received += bytes.length; receivedHash.update(bytes); capture.accounting.observedResponseBytes += bytes.length;
          const room = Math.min(LIMITS.responseBytes - retained, LIMITS.totalResponseBytes - capture.accounting.retainedResponseBytes);
          const keep = bytes.subarray(0, Math.max(0, room));
          chunks.push(keep); retained += keep.length; capture.accounting.retainedResponseBytes += keep.length;
          if (keep.length !== bytes.length) { controller.abort(); if (capture.accounting.retainedResponseBytes >= LIMITS.totalResponseBytes) stopReason = terminal('BYTE_BUDGET'); fail(terminal('BYTE_BUDGET')); }
        }
        if (performance.now() - started >= LIMITS.totalMs) { stopReason = terminal('WALL_BUDGET'); fail(stopReason); }
        const body = Buffer.concat(chunks); let responseText;
        try { responseText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body); } catch { fail(terminal('UTF8')); }
        item.responseText = responseText;
        if (!response.ok) fail(terminal('HTTP', { httpStatus: response.status }));
        let parsed; try { parsed = JSON.parse(responseText); } catch { fail(terminal('JSON')); }
        item.response = parsed;
        if (!parsed || Array.isArray(parsed) || parsed.jsonrpc !== '2.0' || parsed.id !== id || Object.hasOwn(parsed, 'result') === Object.hasOwn(parsed, 'error')) fail(terminal('ENVELOPE'));
        if (Object.hasOwn(parsed, 'error')) fail(terminal('RPC', Number.isSafeInteger(parsed.error?.code) ? { rpcCode: parsed.error.code } : {}));
        return parsed.result;
      } catch (error) {
        item.error = error.diagnostic ?? terminal('TRANSPORT');
        fail(item.error);
      } finally {
        clearTimeout(timer);
        const body = Buffer.concat(chunks), filename = `${String(id).padStart(3, '0')}.body`;
        await fs.writeFile(path.join(rawDirectory, filename), body, { flag: 'wx' });
        item.transport = { complete, receivedBytes: received, retainedBytes: body.length, observedPrefixSha256: receivedHash.digest('hex'), retainedSha256: hash(body), rawFile: `raw/${filename}`, rawBase64: body.toString('base64'), durationMs: performance.now() - callStart, timeoutMs };
        if (complete) { item.transport.responseSha256 = hash(body); capture.accounting.completedBodies++; }
        // Raw errors are untrusted local evidence. Only fixed diagnostics are printed.
        if (item.responseText === undefined) { try { item.responseText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body); } catch {} }
        item.finishedAt = new Date().toISOString();
        await fs.writeFile(path.join(rawDirectory, `${String(id).padStart(3, '0')}.json`), json(item), { flag: 'wx' });
      }
    } };
    try { entry.result = await simulateUnsignedCall({ rpc, chainId: plan.chainId, blockHash: c.blockHash, request: structuredClone(c.request), queries: c.queries.map(q => structuredClone(q.call)) }); }
    catch { entry.error = terminal('ENGINE'); }
    entry.finishedAt = new Date().toISOString();
    await fs.writeFile(path.join(directory, `${c.id}.json`), json(entry), { flag: 'wx' });
    console.log(JSON.stringify({ id: c.id, rpcCalls: entry.rpcCalls.length, execution: entry.result?.execution?.status ?? 'unavailable', measurements: entry.result?.measurements?.map(m => m.status) ?? [], failure: entry.error?.code ?? null }));
  }
  try { capture.sourceInventoryAfter = await inventory(); capture.sourceUnchanged = equal(capture.sourceInventoryBefore, capture.sourceInventoryAfter); }
  catch { capture.sourceInventoryAfter = null; capture.sourceUnchanged = false; capture.sourceValidationError = 'Final source inventory could not be validated.'; }
  capture.finishedAt = new Date().toISOString();
  capture.accounting.durationMs = performance.now() - started;
  capture.accounting.sourceBound = capture.sourceUnchanged;
  await fs.writeFile(path.join(directory, 'capture.json'), json(capture), { flag: 'wx' });
  const bytes = await fs.readFile(path.join(directory, 'capture.json'));
  console.log(JSON.stringify({ capture: 'reports/standard-evm-deposits-v2/capture.json', sha256: hash(bytes), sourceUnchanged: capture.sourceUnchanged, accounting: capture.accounting }));
  if (!capture.sourceUnchanged) process.exitCode = 1;
}

const [mode, approval, ...extra] = process.argv.slice(2);
need(extra.length === 0 && ['--check', '--run', '--bind-source'].includes(mode), 'Use --check, --bind-source, or --run --approved-plan-sha256=<reviewed hash>.');
if (mode === '--bind-source') {
  need(approval === undefined, 'Source binding is offline and takes no approval argument.');
  await fs.access(path.join(directory, 'STARTED.json')).then(() => { throw new Error('A started capture cannot be rebound.'); }, error => { if (error.code !== 'ENOENT') throw error; });
  const plan = JSON.parse(await fs.readFile(planPath, 'utf8')); plan.sourceInventory = await inventory(); plan.sourceBinding = 'frozen';
  await fs.writeFile(planPath, json(plan));
}
const checked = await check();
if (mode !== '--run') {
  need(approval === undefined, 'Offline checks take no approval argument.');
  console.log(JSON.stringify({ checked: true, networkRequests: 0, planSha256: checked.planSha256, sourceFiles: checked.sources.length, cases: checked.plan.cases.map(c => ({ id: c.id, blockHash: c.blockHash, queryCount: c.queries.length })) }));
} else {
  need(approval === `--approved-plan-sha256=${checked.planSha256}`, 'Live execution requires the exact explicitly reviewed plan hash.');
  await run(checked);
}
