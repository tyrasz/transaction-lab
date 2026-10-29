import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PREFIX, sha, json, save, entry, freezeSources, checkSources, BINARY_SHA } from './archive.mjs';
import { compareEvidence } from './compare.mjs';
import { IDS, SYSTEM_SCAFFOLDING, PRODUCT_LIMITS, declaration } from './cases.mjs';

export const LIMITS = Object.freeze({ totalMs: 180000, processMs: 15000, processBytes: 2097152,
  outputFileBytes: 4194304, outputFiles: 8, totalOutputBytes: 50331648, cases: 6, productProcesses: 6, isolatedChildProcesses: 6, gethProcesses: 6 });
export const SCOPE = Object.freeze({ classification: 'six_predeclared_amsterdam_authorization_development_cases',
  isolatedParentValidatedProduct: true, publicApiHttpTested: false, publicRpc: false,
  populationAccuracy: false, canonicalConsensusEstablished: false, withinFiveMillionGasBudget: true,
  unsignedProductVersusSignedType4: true, sameAmendedInitialAllocation: true,
  systemScaffolding: 'four_disclosed_inert_STOP_accounts', productSystemCallsExecuted: false, gethSystemCallsExecuted: true,
  gethReturnDataCompared: 'five_entered_product_message_cases_only', gethRootMessageGasComparedWithExplicitPreparationCharge: 'five_entered_product_message_cases_only', committedLogsAndBloomCompared: true, gethSeparateGasDimensionsObserved: false, authorizationOogChannelsUnavailable: ['returnData','messageGas'], authorizationOogRowRetainedAsUnavailable: true,
  gethBlockGasMeaning: 'max(cumulative_execution_dimension,cumulative_state_dimension)',
  receiptGasComparedSeparately: true, allProductObservationsSealedBeforeGeth: true,
  productDeltaAppliedToFreshMPT: true, fullVmExpectedOutputConsumed: false,
  rawOpcodeTraceRetained: true, automaticExecutionPathEquivalenceClaimed: false });
export const decode = bytes => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
export function validTime(wall, mono, bound) { return [wall, mono].every(n => Number.isFinite(n) && n >= 0 && n <= bound); }
export function validProcess(raw) {
  const p = raw.process;
  return p.status === 0 && p.signal === null && p.error === null && validProcessBounds(raw);
}
export function validProcessBounds(raw) {
  const p = raw.process;
  return Number.isSafeInteger(p.timeoutMs) && p.timeoutMs > 0 && p.timeoutMs <= LIMITS.processMs
    && validTime(p.wallElapsedMs, p.elapsedMs, p.timeoutMs) && p.error?.code !== 'ENOBUFS'
    && [raw.stdout.bytes, raw.stderr.bytes].every(n => Number.isSafeInteger(n) && n >= 0)
    && raw.stdout.bytes + raw.stderr.bytes <= LIMITS.processBytes;
}
export function rawBytes(stream) {
  const bytes = Buffer.from(stream.base64, 'base64'); assert.equal(bytes.toString('base64'), stream.base64);
  assert.equal(bytes.length, stream.bytes); assert.equal(sha(bytes), stream.sha256); return bytes;
}
export function observation(raw) { assert(validProcess(raw)); rawBytes(raw.stderr); return decode(rawBytes(raw.stdout)); }
export function readSealedObservation(capture, p) {
  const bytes = fs.readFileSync(path.join(capture, p)), seal = json(path.join(capture, p + '.seal.json'));
  assert.equal(bytes.length, seal.bytes); assert.equal(sha(bytes), seal.sha256); return { bytes, seal };
}
export class OutputBoundsError extends Error {
  constructor(files, totalBytes) { super('Produced output kind, size, count or aggregate bound exceeded'); this.name = 'OutputBoundsError'; this.files = files; this.totalBytes = totalBytes; }
}
export function scanOutput(directory, currentBytes) {
  // The transition tool is configured for flat outputs. Stat/count all entries
  // before any body read; rejected bodies remain on disk, explicitly unhashed.
  const files = fs.readdirSync(directory).sort().map(name => {
    const s = fs.lstatSync(path.join(directory, name));
    return { path: name, kind: s.isFile() ? 'file' : s.isSymbolicLink() ? 'symlink' : 'other', bytes: s.size, mode: s.mode & 0o777 };
  });
  const totalBytes = files.reduce((n, f) => n + f.bytes, currentBytes);
  if (files.length > LIMITS.outputFiles || files.some(f => f.kind !== 'file' || f.bytes > LIMITS.outputFileBytes)
      || !Number.isSafeInteger(totalBytes) || totalBytes > LIMITS.totalOutputBytes) throw new OutputBoundsError(files, totalBytes);
  return { files, totalBytes };
}
const hex = (v, n) => { assert.equal(typeof v, 'string'); assert.match(v, new RegExp('^0x[0-9a-f]{' + n * 2 + '}$')); return v; };
const qty = v => { assert.equal(typeof v, 'string'); assert.match(v, /^0x[0-9a-f]+$/); return BigInt(v); };
const maximum = (a, b) => BigInt(a) > BigInt(b) ? BigInt(a) : BigInt(b);
export function compare(input,expected,raw,outputs){
 if(!validProcess(raw))return{status:'unavailable',channels:null,reason:'Geth process did not finish cleanly within declared bounds'};
 try{return compareEvidence(input,expected,outputs);}catch(error){return{status:'unavailable',channels:null,reason:'Malformed, rejected or unbound transition evidence: '+error.message};}
}
export async function freeze(root, capture) {
  const source = freezeSources(root, capture), declarations = [];
  // Construct declarations from the saved module, avoiding a stale live import
  // if the caller loaded this entry point before the final source review.
  const archived = await import(pathToFileURL(path.join(capture, 'runtime', PREFIX, 'cases.mjs')).href);
  assert.deepEqual(archived.IDS, IDS);
  for (let i = 0; i < IDS.length; i++) {
    const input = await archived.declaration(i), prefix = 'inputs/' + String(i + 1).padStart(3, '0'), files = {};
    for (const [key, suffix, value] of [['declaration', '.json', input], ['alloc', '-alloc.json', input.allocation], ['env', '-env.json', input.environment], ['txs', '-txs.rlp', input.transactionBody]]) {
      const p = prefix + suffix; files[key] = { path: p, ...save(path.join(capture, p), value) };
    }
    declarations.push({ id: input.id, files });
  }
  checkSources(capture, source.identity.sha256);
  const plan = { schemaVersion: 1, at: new Date().toISOString(), sourceManifestSha256: source.identity.sha256, declarations, limits: LIMITS, productLimits: PRODUCT_LIMITS, scope: SCOPE,
    fork: 'Amsterdam', chainId: 11155111, rewards: -1, withdrawals: [], inputConstruction: 'fixed_initial_allocations_and_synthetic_signed_type4' };
  const identity = save(path.join(capture, 'plan.json'), plan);
  return { planSha256: identity.sha256, sourceSha256: source.identity.sha256, cases: declarations.length, sourceFiles: source.manifest.files.length };
}
export function checkPlan(capture, pin) {
  assert.match(pin, /^[a-f0-9]{64}$/); const bytes = fs.readFileSync(path.join(capture, 'plan.json')); assert.equal(sha(bytes), pin); const plan = decode(bytes);
  assert.deepEqual(plan.limits, LIMITS); assert.deepEqual(plan.productLimits, PRODUCT_LIMITS); assert.deepEqual(plan.scope, SCOPE); assert.deepEqual(plan.declarations.map(d => d.id), IDS);
  assert.equal(plan.fork, 'Amsterdam'); assert.equal(plan.chainId, 11155111); assert.equal(plan.rewards, -1); assert.deepEqual(plan.withdrawals, []);
  const source = checkSources(capture, plan.sourceManifestSha256);
  const inputs = plan.declarations.map(d => {
    for (const f of Object.values(d.files)) { const b = fs.readFileSync(path.join(capture, f.path)); assert.equal(b.length, f.bytes); assert.equal(sha(b), f.sha256); }
    const input = json(path.join(capture, d.files.declaration.path)); assert.equal(input.id, d.id);
    assert.deepEqual(json(path.join(capture, d.files.alloc.path)), input.allocation); assert.deepEqual(json(path.join(capture, d.files.env.path)), input.environment);
    assert.equal(json(path.join(capture, d.files.txs.path)), input.transactionBody); return input;
  });
  return { plan, source, inputs };
}
export function run(capture, pin) {
  assert.equal(fs.realpathSync(fileURLToPath(import.meta.url)), fs.realpathSync(path.join(capture, 'runtime', PREFIX, 'run.mjs')), 'Only the frozen archived driver may dispatch');
  const { plan, source, inputs } = checkPlan(capture, pin), runtime = path.join(capture, 'runtime');
  const ledger = new Map(), unhashed = new Map(), admit = p => { const f = entry(capture, p); ledger.set(p, f); return f; };
  const put = (p, value) => { const f = save(path.join(capture, p), value); admit(p); return f; };
  const checkLedger = () => { for (const [p, f] of ledger) assert.deepEqual(entry(capture, p), f); };
  for (const p of ['plan.json', 'source-manifest.json', ...plan.declarations.flatMap(d => Object.values(d.files).map(f => f.path))]) admit(p);
  const wall0 = Date.now(), mono0 = performance.now(); let previousWall = 0, previousMono = 0, reversed = false, totalBytes = 0, fatal = null;
  const timing = () => { const wallMs = Date.now() - wall0, monotonicMs = performance.now() - mono0; reversed ||= wallMs < previousWall || monotonicMs < previousMono; previousWall = wallMs; previousMono = monotonicMs; return { wallMs, monotonicMs, clockReversed: reversed }; };
  const remaining = () => { const t = timing(); assert(!t.clockReversed && validTime(t.wallMs, t.monotonicMs, LIMITS.totalMs)); const n = Math.floor(Math.min(LIMITS.processMs, LIMITS.totalMs - Math.max(t.wallMs, t.monotonicMs))); assert(n > 0); return n; };
  const guard = () => { checkLedger(); checkPlan(capture, pin); assert(totalBytes <= LIMITS.totalOutputBytes); return remaining(); };
  const dispatch = (executable, args) => {
    guard(); assert.equal(sha(fs.readFileSync(executable)), executable === source.node.executable ? source.node.sha256 : BINARY_SHA);
    const timeoutMs = remaining(), wallStart = Date.now(), monoStart = performance.now();
    const r = spawnSync(executable, args, { cwd: runtime, encoding: null, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: LIMITS.processBytes, env: { PATH: process.env.PATH ?? '', TZ: 'UTC', LANG: 'C' } });
    const pack = b => { b ??= Buffer.alloc(0); totalBytes += b.length; return { bytes: b.length, sha256: sha(b), base64: b.toString('base64') }; };
    return { process: { executable, args, timeoutMs, wallElapsedMs: Date.now() - wallStart, elapsedMs: performance.now() - monoStart,
      status: r.status, signal: r.signal, error: r.error ? { name: r.error.name, code: r.error.code ?? null, message: r.error.message } : null }, stdout: pack(r.stdout), stderr: pack(r.stderr) };
  };
  put('STARTED.json', { at: new Date(wall0).toISOString(), planSha256: pin });
  const rows = IDS.map(id => ({ id, status: 'not_attempted', channels: null, reason: null })), observations = [];
  try {
    // Complete and fsync all six exact-input product observations before any Geth process.
    for (let i = 0; i < IDS.length; i++) {
      const p = 'product/' + String(i + 1).padStart(3, '0') + '.json';
      const raw = dispatch(source.node.executable, ['--max-old-space-size=256', path.join(runtime, PREFIX, 'worker.mjs'), path.join(capture, plan.declarations[i].files.declaration.path)]);
      const identity = put(p, raw); put(p + '.seal.json', { ...identity, at: new Date().toISOString() }); observations.push(p);
      assert(validProcessBounds(raw), 'Product process output or elapsed bound failed');
      if(validProcess(raw)) assert.equal(observation(raw).processClosureValid,true,'Isolated child closure/drain is unconfirmed');
    }
    for (let i = 0; i < IDS.length; i++) {
      guard(); const input = inputs[i], d = plan.declarations[i], p = 'geth/' + String(i + 1).padStart(3, '0'), out = path.join(capture, p);
      const { bytes: b } = readSealedObservation(capture, observations[i]);
      let expected = null; try { expected = observation(decode(b)).comparisonInput; assert(expected); } catch { /* Retained failed VM observation cannot become an expected result. */ }
      assert(!fs.existsSync(out)); fs.mkdirSync(out, { recursive: true }); rows[i] = { ...rows[i], status: 'unavailable', reason: 'Dispatch started' };
      const args = ['t8n', '--state.fork=Amsterdam', '--state.chainid=11155111', '--state.reward=-1',
        '--input.alloc=' + path.join(capture, d.files.alloc.path), '--input.env=' + path.join(capture, d.files.env.path), '--input.txs=' + path.join(capture, d.files.txs.path),
        '--output.basedir=' + out, '--output.alloc=alloc.json', '--output.result=result.json', '--output.body=body.rlp', '--trace', '--trace.callframes', '--trace.memory'];
      const raw = dispatch(source.geth.binary.path, args); put(p + '-process.json', { ...raw, productSealedSha256: sha(b) });
      let outputs = null, shapeError = null;
      try {
        const scan = scanOutput(out, totalBytes); totalBytes = scan.totalBytes; for (const f of scan.files) admit(p + '/' + f.path);
        assert.deepEqual(scan.files.map(f => f.path), ['alloc.json', 'body.rlp', 'result.json', `trace-0-${input.transactionHash}.jsonl`]);
        outputs = { result: decode(fs.readFileSync(path.join(out, 'result.json'))), body: decode(fs.readFileSync(path.join(out, 'body.rlp'))), allocation: decode(fs.readFileSync(path.join(out, 'alloc.json'))), trace: fs.readFileSync(path.join(out, `trace-0-${input.transactionHash}.jsonl`)) };
      } catch (error) {
        if (error instanceof OutputBoundsError) {
          totalBytes = error.totalBytes; for (const f of error.files) { const name = p + '/' + f.path; unhashed.set(name, { ...f, path: name, kind: 'unhashed_output', observedKind: f.kind, sha256: null, reason: 'declared_output_bound_exceeded' }); }
          put(p + '-output-bound-failure.json', { message: error.message, totalBytes, files: [...unhashed.values()] }); throw error;
        }
        shapeError = error.message;
      }
      assert(validProcessBounds(raw), 'Geth process output or elapsed bound failed'); guard();
      const comparison = shapeError || !expected ? { status: 'unavailable', channels: null, reason: shapeError ?? 'Product observation unavailable' } : compare(input, expected, raw, outputs);
      rows[i] = { id: input.id, ...comparison }; put(p + '-comparison.json', rows[i]); console.log(JSON.stringify(rows[i]));
    }
  } catch (error) { fatal = { name: error?.name ?? null, message: error?.message ?? String(error) }; }
  let sourceUnchanged = false, artifactsUnchanged = false;
  try { checkPlan(capture, pin); sourceUnchanged = true; checkLedger(); artifactsUnchanged = unhashed.size === 0; } catch (error) { fatal ??= { name: error.name, message: error.message }; }
  const terminalTiming = timing(); terminalTiming.valid = !terminalTiming.clockReversed && validTime(terminalTiming.wallMs, terminalTiming.monotonicMs, LIMITS.totalMs) && totalBytes <= LIMITS.totalOutputBytes;
  if (!terminalTiming.valid) fatal ??= { name: 'BoundsError', message: 'Terminal clock, time or aggregate output bound failed' };
  const results = { schemaVersion: 1, planSha256: pin, sourceManifestSha256: plan.sourceManifestSha256, status: fatal ? 'interrupted' : 'complete',
    comparisonsUsable: fatal === null && sourceUnchanged && artifactsUnchanged, sourceUnchanged, artifactsUnchanged, fatal, terminalTiming, totalOutputBytes: totalBytes,
    artifactHashCoverageComplete: unhashed.size === 0, rows, counts: Object.fromEntries(['matched', 'mismatched', 'unavailable', 'not_attempted'].map(s => [s, rows.filter(r => r.status === s).length])), scope: SCOPE };
  put('results.json', results);
  const files = [...ledger.values(), ...unhashed.values(), ...source.files.map(f => ({ ...f, path: 'runtime/' + f.path })), ...source.toolFiles.map(f => entry(capture, 'toolchain/' + f.path))].sort((a, b) => a.path < b.path ? -1 : 1);
  const manifest = save(path.join(capture, 'manifest.json'), { schemaVersion: 1, planSha256: pin, artifactHashCoverageComplete: unhashed.size === 0, files });
  return { ...results.counts, comparisonsUsable: results.comparisonsUsable, manifestSha256: manifest.sha256 };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  if (process.argv[2] === 'freeze') console.log(JSON.stringify(await freeze(root, path.join(root, PREFIX, 'capture')), null, 2));
  else if (process.argv[2] === 'check') { const r = checkPlan(path.resolve(process.argv[3]), process.argv[4]); console.log(JSON.stringify({ sourceUnchanged: true, cases: r.inputs.length })); }
  else if (process.argv[2] === 'run') console.log(JSON.stringify(run(path.resolve(process.argv[3]), process.argv[4]), null, 2));
  else throw Error('Use freeze, check CAPTURE EXTERNAL_PLAN_SHA, or archived run CAPTURE EXTERNAL_PLAN_SHA');
}
