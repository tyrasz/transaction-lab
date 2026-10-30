// Offline evidence audit. No fetch, sockets, subprocess execution or VM replay.
// Expected manifest identity must come from the separately sealed handoff.
import { createHash } from 'node:crypto';
import { normalizeEvmContext } from '../../engines/evm-context.js';
import { createReadStream } from 'node:fs';
import { readFile, readdir, lstat, realpath } from 'node:fs/promises';
import { join, resolve, posix, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual as equal } from 'node:util';
import { verifyFrozenSources, verifyNodeRuntime } from './cohort-freeze.mjs';

export class CohortVerificationError extends Error {
  constructor(message) { super(message); this.name = 'CohortVerificationError'; this.code = 'COHORT_EVIDENCE_INVALID'; }
}
const need = (ok, message) => { if (!ok) throw new CohortVerificationError(message); };
const sha = v => createHash('sha256').update(v).digest('hex');
const own = (o, k) => Object.hasOwn(o, k);
const record = v => v && typeof v === 'object' && !Array.isArray(v);
const HEX = /^[0-9a-f]{64}$/, WORD = /^0x[0-9a-f]{64}$/;
const EMPTY_CODE_HASH = '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470';
const PROVIDERS = { drpc: 'https://eth.drpc.org/', publicnode: 'https://ethereum-rpc.publicnode.com/' };
const LIMITS = { files: 30000, fileBytes: 256 * 1024 * 1024, totalBytes: 8 * 1024 * 1024 * 1024, wireBytes: 8 * 1024 * 1024, calls: 6144 };
const integer = v => Number.isSafeInteger(v) && v >= 0;
const finite = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const timestamp = v => typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const digest = (v, label) => { need(typeof v === 'string' && HEX.test(v), label + ' hash is invalid.'); return v; };
function pathName(path) {
  need(typeof path === 'string' && path.length > 0 && path.length <= 1024 && !isAbsolute(path) && !path.includes('\\') && !path.includes('\0') && posix.normalize(path) === path && !path.split('/').some(v => !v || v === '.' || v === '..'), 'Noncanonical evidence path.'); return path;
}
async function regular(root, path) {
  pathName(path); const parts = path.split('/');
  for (let i = 1; i < parts.length; i++) { const s = await lstat(join(root, ...parts.slice(0, i))); need(s.isDirectory() && !s.isSymbolicLink(), 'Linked evidence directory.'); }
  const s = await lstat(join(root, path)); need(s.isFile() && !s.isSymbolicLink() && s.size <= LIMITS.fileBytes, 'Evidence is not a bounded regular file.'); return s;
}
async function fileHash(path) { const h = createHash('sha256'); for await (const b of createReadStream(path)) h.update(b); return h.digest('hex'); }
async function listEvidence(root, sub = '') {
  const found = [];
  for (const e of await readdir(join(root, sub), { withFileTypes: true })) {
    const path = sub ? `${sub}/${e.name}` : e.name;
    if (!sub && ['runtime', 'evidence-manifest.json'].includes(e.name)) continue;
    pathName(path); need(!e.isSymbolicLink(), 'Evidence symlinks are unsupported.');
    if (e.isDirectory()) found.push(...await listEvidence(root, path));
    else { need(e.isFile(), 'Nonregular evidence file.'); found.push(path); }
    need(found.length <= LIMITS.files, 'Evidence file bound exceeded.');
  }
  return found.sort();
}

/** Validate exact retained bytes, including failed/truncated records. Hashes of
 * bytes that were observed but not retained cannot be independently rederived. */
export function verifyCohortWireRecord(wire) {
  need(record(wire) && own(PROVIDERS, wire.provider) && wire.url === PROVIDERS[wire.provider] && ['census', 'local', 'product'].includes(wire.profile), 'Wire provider/profile differs.');
  need(integer(wire.globalId) && wire.globalId > 0 && wire.globalId <= LIMITS.calls && integer(wire.id) && wire.id > 0 && typeof wire.dispatched === 'boolean', 'Wire identity is invalid.');
  need(record(wire.request) && wire.request.jsonrpc === '2.0' && wire.request.id === wire.id && typeof wire.request.method === 'string' && Array.isArray(wire.request.params), 'Wire request envelope is invalid.');
  need(typeof wire.requestText === 'string' && wire.requestText === JSON.stringify(wire.request) && wire.requestBytes === Buffer.byteLength(wire.requestText) && wire.requestBytes <= LIMITS.wireBytes && sha(wire.requestText) === wire.requestSha256, 'Wire request bytes differ.');
  need(timestamp(wire.startedAt) && record(wire.transport) && typeof wire.transport.complete === 'boolean' && finite(wire.transport.durationMs), 'Wire timing/completeness is invalid.');
  const t = wire.transport;
  need(integer(t.retainedBytes) && integer(t.observedBytes) && t.retainedBytes <= LIMITS.wireBytes && t.observedBytes >= t.retainedBytes, 'Wire byte counts are invalid.');
  need(typeof wire.rawBase64 === 'string' && wire.rawBase64.length <= Math.ceil(LIMITS.wireBytes / 3) * 4, 'Wire retained body is missing or excessive.');
  const raw = Buffer.from(wire.rawBase64, 'base64');
  need(raw.toString('base64') === wire.rawBase64 && raw.length === t.retainedBytes && sha(raw) === t.retainedSha256, 'Wire retained bytes/hash differ.');
  digest(t.observedSha256, 'Observed body');
  if (t.observedBytes === t.retainedBytes) need(t.observedSha256 === sha(raw), 'Wire observed hash differs from complete retained bytes.');
  if (t.complete) need(t.observedBytes === t.retainedBytes, 'Complete body is truncated.');
  if (own(wire, 'responseSha256')) need(wire.responseSha256 === sha(raw), 'Wire response hash differs.');
  let parsed;
  if (own(wire, 'responseText')) {
    let text; try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw); } catch { need(false, 'Claimed response text contains invalid UTF-8.'); }
    need(wire.responseText === text, 'Response text differs from retained bytes.');
    try { parsed = JSON.parse(text); } catch { /* A retained encoding/JSON failure is legitimate. */ }
  }
  if (own(wire, 'parsed')) need(parsed !== undefined && equal(wire.parsed, parsed), 'Parsed wire result differs from raw body.');
  const validEnvelope = record(parsed) && parsed.jsonrpc === '2.0' && parsed.id === wire.id && own(parsed, 'result') !== own(parsed, 'error');
  if (wire.status === 'completed') need(wire.dispatched && t.complete && wire.httpStatus >= 200 && wire.httpStatus < 300 && validEnvelope && own(parsed, 'result') && equal(wire.parsed, parsed) && !own(wire, 'error'), 'Completed wire lacks a valid successful response.');
  else {
    need(wire.status === 'failed' && ['deadline', 'byte_budget', 'response_byte_budget', 'missing_body', 'http_error', 'transport_or_encoding_error', 'jsonrpc_envelope', 'rpc_error', 'ancestor_header_invalid'].includes(wire.error), 'Unknown wire failure state.');
    if (wire.error === 'ancestor_header_invalid') need(wire.profile === 'local' && wire.request.method === 'eth_getBlockByHash' && wire.ancestorVerification === 'rejected' && t.complete && validEnvelope && own(parsed, 'result'), 'Ancestor failure lacks its captured header response.');
    if (wire.error === 'rpc_error') need(t.complete && validEnvelope && own(parsed, 'error'), 'RPC-error label contradicts retained envelope.');
    if (wire.error === 'jsonrpc_envelope') need(t.complete && parsed !== undefined && !validEnvelope, 'Malformed-envelope label contradicts bytes.');
    if (wire.error === 'http_error') need(integer(wire.httpStatus) && (wire.httpStatus < 200 || wire.httpStatus >= 300), 'HTTP-error label contradicts status.');
  }
  if (!wire.dispatched) need(t.observedBytes === 0 && !own(wire, 'httpStatus'), 'Undispatched wire contains a response.');
  return { globalId: wire.globalId, provider: wire.provider, profile: wire.profile, status: wire.status, observedBytes: t.observedBytes, retainedBytes: t.retainedBytes, complete: t.complete, unretainedObservedHashVerified: t.observedBytes === t.retainedBytes };
}

async function packet(outputDirectory, expectedManifestSha256) {
  digest(expectedManifestSha256, 'Expected evidence manifest');
  const root = await realpath(resolve(outputDirectory));
  await regular(root, 'evidence-manifest.json'); const raw = await readFile(join(root, 'evidence-manifest.json'));
  need(raw.length <= 8 * 1024 * 1024 && sha(raw) === expectedManifestSha256, 'Evidence manifest identity differs.');
  const manifest = JSON.parse(raw);
  need(manifest.schemaVersion === '1.0' && Array.isArray(manifest.files) && manifest.files.length <= LIMITS.files, 'Evidence manifest shape is invalid.');
  digest(manifest.planSha256, 'Plan'); digest(manifest.sourceManifestSha256, 'Source manifest');
  const byPath = new Map(), folded = new Set(); let total = 0;
  for (const entry of manifest.files) {
    pathName(entry.path); need(entry.path !== 'evidence-manifest.json' && !entry.path.startsWith('runtime/') && !folded.has(entry.path.toLowerCase()), 'Duplicate or excluded evidence path.'); folded.add(entry.path.toLowerCase());
    need(integer(entry.bytes) && entry.bytes <= LIMITS.fileBytes && HEX.test(entry.sha256), 'Evidence inventory entry is invalid.');
    total += entry.bytes; need(total <= LIMITS.totalBytes, 'Evidence total byte bound exceeded.');
    const stat = await regular(root, entry.path); need(stat.size === entry.bytes && await fileHash(join(root, entry.path)) === entry.sha256, 'Evidence file bytes/hash differ: ' + entry.path); byPath.set(entry.path, entry);
  }
  need(equal([...byPath.keys()].sort(), await listEvidence(root)), 'Evidence membership differs from manifest.');
  need(byPath.get('plan.json')?.sha256 === manifest.planSha256 && byPath.get('source-manifest.json')?.sha256 === manifest.sourceManifestSha256, 'Plan/source manifest not bound by evidence manifest.');
  const read = async path => { need(byPath.has(path), 'Required artifact absent: ' + path); const bytes = await readFile(join(root, path)); need(bytes.length === byPath.get(path).bytes && sha(bytes) === byPath.get(path).sha256, 'Artifact changed during verification.'); return JSON.parse(bytes); };
  return { root, manifest, byPath, read, total };
}

export function verifyCollectorBindings(selection, wires, events, plan, verifyHeader) {
  need(['complete', 'selection_failed'].includes(selection?.status) && record(selection.artifacts), 'Selection artifact is invalid.');
  const a = selection.artifacts;
  need(a.parsedResultsOnly === true && Array.isArray(a.attempts) && Array.isArray(a.stages) && Array.isArray(a.observations), 'Selection artifacts are incomplete.');
  need(equal(events, a.stages), 'Durable selection events differ from returned stages.');
  let previous = -Infinity;
  for (let i = 0; i < events.length; i++) { const e = events[i]; need(e.index === i && timestamp(e.at) && Date.parse(e.at) >= previous, 'Selection event order/time is invalid.'); previous = Date.parse(e.at); }
  let cursor = 0, parsedBytes = 0;
  for (let i = 0; i < a.attempts.length; i++) {
    const attempt = a.attempts[i]; need(attempt.index === i && ['drpc', 'publicnode'].includes(attempt.provider) && typeof attempt.transportInvoked === 'boolean', 'Selection attempt identity is invalid.');
    const planned = events.filter(e => e.kind === 'call_planned' && e.details.index === i);
    need(planned.length === 1 && equal(planned[0].details, Object.fromEntries(['index', 'provider', 'method', 'params', 'purpose', 'startedAt'].map(k => [k, attempt[k]]).concat([['status', 'planned'], ['transportInvoked', false]]))), 'Selection call lacks an exact declared event.');
    const terminal = events.filter(e => ['call_completed', 'call_failed'].includes(e.kind) && e.details.index === i);
    need(terminal.length <= 1 && (terminal.length === 0 || equal(terminal[0].details, attempt)), 'Selection terminal event differs from retained attempt.');
    if (selection.status === 'complete') need(terminal.length === 1 && terminal[0].kind === 'call_completed', 'Completed selection lacks its durable read result.');
    if (!attempt.transportInvoked) { need(attempt.status === 'planned', 'Uninvoked selection attempt claims completion.'); continue; }
    const w = wires[cursor];
    // Admission denials have no public wire. They can only terminate selection;
    // a complete selection must have an exact wire for every invoked read.
    if (!w || w.provider !== attempt.provider || w.request.method !== attempt.method || !equal(w.request.params, attempt.params)) { need(selection.status === 'selection_failed' && i === a.attempts.length - 1 && attempt.status === 'failed', 'Selection attempt does not bind to its next census wire.'); continue; }
    cursor++;
    if (attempt.status === 'completed') {
      need(w.status === 'completed' && equal(attempt.result, w.parsed.result), 'Selection parsed result differs from actual wire.');
      const size = Buffer.byteLength(JSON.stringify(attempt.result)); need(attempt.parsedResultBytes === size, 'Selection parsed byte count differs.'); parsedBytes += size;
    } else need(attempt.status === 'failed' && selection.status === 'selection_failed', 'Successful selection contains a failed read.');
  }
  need(cursor === wires.length && a.parsedResultBytes === parsedBytes, 'Unbound census wire or parsed-byte mismatch.');
  const declaration = a.anchorDeclaration;
  if (!declaration) {
    need(selection.status === 'selection_failed' && selection.census === null && a.attempts.length <= 2 && a.observations.length === 0, 'Missing prospective anchor.');
    const first = a.attempts[0], second = a.attempts[1];
    if (first) need(first.provider === 'drpc' && first.method === 'eth_chainId' && equal(first.params, []), 'Pre-anchor read differs from primary chain check.');
    if (second) need(first.status === 'completed' && first.result === '0x1' && second.provider === 'drpc' && second.method === 'eth_getBlockByNumber' && equal(second.params, ['latest', false]), 'Pre-anchor latest read differs.');
    return null;
  }
  const anchorEvent = events.find(e => e.kind === 'anchor_declared');
  need(anchorEvent && equal(anchorEvent.details, declaration) && declaration.sampleSize === 16 && declaration.seed === plan.seed, 'Anchor declaration differs from frozen seed or durable event.');
  need(timestamp(declaration.anchorObservedAt) && timestamp(declaration.waitDeadline) && Date.parse(declaration.waitDeadline) - Date.parse(declaration.anchorObservedAt) === 1200000, 'Prospective wait deadline differs.');
  const initial = a.attempts.slice(0, 2);
  need(initial.length === 2 && initial[0].provider === 'drpc' && initial[0].method === 'eth_chainId' && equal(initial[0].params, []) && initial[0].result === '0x1' && initial[1].provider === 'drpc' && initial[1].method === 'eth_getBlockByNumber' && equal(initial[1].params, ['latest', false]) && equal(initial[1].result, declaration.latestHeader), 'Initial prospective observations differ.');
  const H = BigInt(declaration.anchor.blockNumber);
  const anchorProof = verifyHeader({ header: declaration.latestHeader, expectedHash: declaration.anchor.blockHash });
  need(equal(anchorProof, declaration.verifiedHeader) && anchorProof.number === H.toString(), 'Anchor identity differs from independently hashed latest header.');
  need(anchorEvent.index > events.find(e => e.kind === 'call_completed' && e.details.index === 1)?.index, 'Anchor declaration did not follow its actual latest read.');
  need(equal(declaration.targetBlockNumbers, [(H + 1n).toString(), (H + 2n).toString()]), 'Target numbers were substituted.');
  for (const attempt of a.attempts.slice(2)) need(timestamp(attempt.startedAt) && Date.parse(attempt.startedAt) >= Date.parse(declaration.waitDeadline), 'Future observation preceded the20-minute wait.');
  for (const e of events.filter(e => e.kind === 'wait_chunk_started')) need(e.index > anchorEvent.index && integer(e.details.durationMs) && e.details.durationMs <= 60000 && Date.parse(e.details.until) - Date.parse(e.at) === e.details.durationMs, 'Wait chunk differs from its declared bound.');
  need(Array.isArray(a.finalizedObservations) && a.finalizedObservations.length <= 2 && new Set(a.finalizedObservations.map(x => x.provider)).size === a.finalizedObservations.length, 'Finalized tips were repeated or replaced.');
  for (const provider of ['drpc', 'publicnode']) need(a.attempts.filter(x => x.provider === provider && x.method === 'eth_getBlockByNumber' && x.params[0] === 'finalized').length <= 1, 'Finalized tag was retried.');
  // Reconstruct every retained branch from the actual next attempt. This binds
  // observations to bytes rather than trusting a separately editable array.
  const expect = (i, provider, method, params) => {
    const call = a.attempts[i]; if (!call) return null;
    need(call.provider === provider && call.method === method && equal(call.params, params), 'Collector call order departed from fixed selection.'); return call;
  };
  let next = 2;
  const secondary = expect(next++, 'publicnode', 'eth_chainId', []);
  if (!secondary || secondary.status !== 'completed' || secondary.result !== '0x1') { need(selection.status === 'selection_failed' && next - 1 >= a.attempts.length - 1 && a.finalizedObservations.length === 0 && a.observations.length === 0, 'Partial selection continued after chain failure.'); return null; }
  const tips = [];
  for (const provider of ['drpc', 'publicnode']) {
    const call = expect(next++, provider, 'eth_getBlockByNumber', ['finalized', false]);
    if (!call || call.status !== 'completed') { need(selection.status === 'selection_failed' && next - 1 >= a.attempts.length - 1, 'Partial selection continued after finalized failure.'); return null; }
    const retained = a.finalizedObservations[tips.length]; need(retained?.provider === provider && equal(retained.header, call.result) && timestamp(retained.observedAt) && Date.parse(retained.observedAt) >= Date.parse(declaration.waitDeadline), 'Fixed finalized observation differs from actual wire.'); tips.push(retained);
  }
  let validTips = true;
  for (const tip of tips) {
    try {
      const proof = verifyHeader({ header: tip.header, expectedHash: tip.header.hash }), count = BigInt(proof.number) - H + 1n;
      if (count < 3n || count > 256n) validTips = false;
      if (tip.verifiedHeader) need(equal(proof, tip.verifiedHeader), 'Finalized header proof differs.');
    } catch { validTips = false; }
  }
  if (!validTips) { need(selection.status === 'selection_failed' && a.attempts.length === 5 && a.observations.length === 0, 'Invalid finalized tips led to body reads.'); return null; }
  let retainedProviders = 0;
  for (const tip of tips) {
    const headers = [], top = BigInt(tip.header.number); let expectedHash = tip.header.hash.toLowerCase();
    for (let number = top; number >= H; number--) {
      const target = number === H + 1n || number === H + 2n; let header;
      if (number === H && tip.provider === 'drpc') { if (expectedHash !== declaration.anchor.blockHash) { need(selection.status === 'selection_failed' && next === a.attempts.length, 'Anchor branch was replaced.'); return null; } header = declaration.latestHeader; }
      else if (number === top && !target) header = tip.header;
      else {
        const call = expect(next++, tip.provider, 'eth_getBlockByHash', [expectedHash, target]);
        if (!call || call.status !== 'completed') { need(selection.status === 'selection_failed' && next - 1 >= a.attempts.length - 1 && a.observations.length === retainedProviders, 'Collector continued after failed ancestry read.'); return null; } header = call.result;
      }
      let proof; try { proof = verifyHeader({ header, expectedHash }); } catch { need(selection.status === 'selection_failed' && next === a.attempts.length && a.observations.length === retainedProviders, 'Collector continued after invalid header.'); return null; }
      if (proof.number !== number.toString()) { need(selection.status === 'selection_failed' && next === a.attempts.length, 'Collector accepted substituted header height.'); return null; }
      headers.push(header); expectedHash = proof.parentHash;
    }
    const expected = { provider: tip.provider, chainId: '0x1', finalizedObservedAt: tip.observedAt, finalizedBlockHash: tip.header.hash.toLowerCase(), headers: headers.reverse() };
    need(equal(a.observations[retainedProviders++], expected), 'Collected ancestry differs from fixed actual reads.');
  }
  need(next === a.attempts.length && a.observations.length === 2, 'Collector contains extra reads or observations.');
  return { chainId: 1, anchor: declaration.anchor, targetBlockNumbers: declaration.targetBlockNumbers, anchorObservedAt: declaration.anchorObservedAt, seed: declaration.seed, sampleSize: 16, observations: a.observations };
}

function wireIds(phase, wires, claimed, expectedProfile, parentHash) {
  const ids = phase.transportWireIds ?? [];
  need(Array.isArray(ids) && new Set(ids).size === ids.length && ids.every(id => integer(id) && id > 0), 'Phase wire IDs are malformed.');
  const result = ids.map(id => { const w = wires.get(id); need(w && !claimed.has(id) && w.profile === expectedProfile && w.provider === 'drpc', 'Phase wire ID is missing, reused or misattributed.'); claimed.add(id); return w; });
  need(result.every((w, i) => i === 0 || w.globalId > result[i - 1].globalId), 'Phase wire IDs are not ordered.');
  for (const w of result) if (expectedProfile === 'local') need((['eth_getProof', 'eth_getCode'].includes(w.request.method) && equal(w.request.params.at(-1), { blockHash: parentHash, requireCanonical: true })) || (w.request.method === 'eth_getBlockByHash' && w.request.params.length === 2 && WORD.test(w.request.params[0]) && w.request.params[1] === false), 'Local input read is not a pinned state or hash-selected ancestor request.');
  if (phase.transportUsage) {
    const u = phase.transportUsage;
    need(u.attempts === result.length && u.dispatches === result.filter(w => w.dispatched).length && u.observedBytes === result.reduce((n, w) => n + w.transport.observedBytes, 0), 'Phase transport accounting differs.');
  }
  return result;
}

export function verifyProductBindings(product, wires, request) {
  if (!product.request) { need(product.dispatch !== 'completed' && wires.length === 0, 'Product without request evidence cannot claim wires.'); return { independentlyJoinedWireRecords: 0, phaseDeclaredOnlyWireRecords: 0 }; }
  const p = product.request;
  need(p.method === 'POST' && p.path === '/api/evm/simulate' && p.contentType === 'application/json' && p.bodyText === JSON.stringify(request) && p.bodySha256 === sha(p.bodyText), 'Actual product HTTP request differs from projection.');
  if (product.response) {
    const r = product.response; need(typeof r.bodyText === 'string' && r.bytes === Buffer.byteLength(r.bodyText) && r.sha256 === sha(r.bodyText), 'Product response bytes differ.');
    if (product.dispatch === 'completed') need(product.httpStatus === r.status && equal(product.report, JSON.parse(r.bodyText)), 'Product report differs from actual HTTP body.');
  } else need(product.dispatch !== 'completed', 'Completed product lacks actual response bytes.');
  if (product.report?.transportEvidence) {
    const retained = product.report.transportEvidence;
    need(Array.isArray(retained), 'Product internal wire inventory differs.');
    let cursor = 0, denied = 0;
    for (let i = 0; i < retained.length; i++) {
      const e = retained[i], w = wires[cursor];
      if (!w || e.id !== w.id) {
        const d = product.transportDenied?.[denied++];
        need(d && d.method === e.request?.method && !own(e, 'responseText') && record(e.error), 'Product evidence lacks its wire or a retained admission denial.'); continue;
      }
      cursor++;
      need(e.id === w.id && e.requestText === w.requestText && e.requestSha256 === w.requestSha256 && e.requestBytes === w.requestBytes && equal(e.request, w.request), 'Product internal request differs from captured wire.');
      if (own(e, 'responseText')) need(w.transport.complete && e.responseText === w.responseText && e.transport?.responseSha256 === sha(w.responseText) && e.transport?.observedBytes === w.transport.observedBytes, 'Product internal response differs from captured bytes.');
    }
    need(cursor === wires.length, 'Unbound product wire remains.');
    return { independentlyJoinedWireRecords: wires.length, phaseDeclaredOnlyWireRecords: 0 };
  }
  // A timeout or HTTP error can legitimately retain outer transport records
  // while the handler emits no internal evidence. Preserve the unavailable
  // outcome, but never describe those phase declarations as independent joins.
  return { independentlyJoinedWireRecords: 0, phaseDeclaredOnlyWireRecords: wires.length };
}

export async function verifyLocalBindings(local, wires, header, modules) {
  const headerWires = wires.filter(w => w.request.method === 'eth_getBlockByHash');
  if (headerWires.length) {
    need(typeof modules.createAuthenticatedAncestry === 'function', 'Archived ancestor verifier is missing.');
    const ancestry = modules.createAuthenticatedAncestry(header); let failed = false;
    for (const w of wires) {
      need(!failed, 'Local input reads continued after an ancestor failure.');
      if (w.request.method !== 'eth_getBlockByHash') continue;
      need(equal(w.request.params, [ancestry.nextHash(), false]), 'Ancestor wire was not selected from the committed next parent.');
      if (w.status === 'completed') { need(w.ancestorVerification === 'verified', 'Completed ancestor lacks its verification marker.'); ancestry.accept(w.parsed.result, w.request.id); }
      else {
        if (w.error === 'ancestor_header_invalid') {
          let rejected = false; try { ancestry.accept(w.parsed.result, w.request.id); } catch { rejected = true; }
          need(rejected, 'Ancestor rejection differs from the actual header bytes.');
        }
        failed = true;
      }
    }
  }
  const attempt = local.attempt;
  if (!attempt) { need(local.dispatch !== 'completed' && wires.length === 0, 'Local phase without an attempt cannot claim wires.'); return { proofsVerified: 0 }; }
  const broker = attempt.broker;
  need(record(broker) && Array.isArray(broker.records) && broker.calls === broker.records.length, 'Local broker inventory is missing.');
  if (attempt.status === 'unavailable' && attempt.error?.code === 'LOCAL_ISOLATED_INPUT' && attempt.isolation === null && attempt.inputs === null && broker.calls === 0) {
    need(equal(broker, { calls: 0, records: [], pendingAtReturn: 0 }) && wires.length === 0 && local.dispatch === 'unavailable', 'Invalid-input local attempt contains execution evidence.'); return { proofsVerified: 0 };
  }
  const dispatched = broker.records.filter(e => e.dispatched);
  need(broker.dispatches === dispatched.length && broker.pendingAtReturn === 0, 'Local broker dispatch/drain count differs.');
  let cursor = 0, denied = 0; const bound = new Map();
  for (let i = 0; i < dispatched.length; i++) {
    const e = dispatched[i], w = wires[cursor];
    if (!w || e.request.method !== w.request.method || !equal(e.request.params, w.request.params)) {
      const d = local.transportDenied?.[denied++]; need(d && d.method === e.request.method && e.status === 'unavailable', 'Local broker request lacks wire or retained admission denial.'); continue;
    }
    cursor++; bound.set(e.id, w);
    need(e.id > 0 && e.request.method === w.request.method && equal(e.request.params, w.request.params), 'Local broker request differs from actual input wire.');
    if (e.status === 'received') need(w.status === 'completed' && e.resultSha256 === sha(JSON.stringify(w.parsed.result)) && e.resultBytes === Buffer.byteLength(JSON.stringify(w.parsed.result)), 'Local broker result differs from captured proof/code bytes.');
  }
  need(cursor === wires.length, 'Unbound local input wire remains.');
  if (!attempt.inputs) { need(attempt.status === 'unavailable', 'Local inputs missing without unavailable outcome.'); return { proofsVerified: 0 }; }
  need(equal(attempt.inputs.context.header, header) && attempt.inputs.context.blockHash === header.hash && attempt.inputs.context.stateRoot === header.stateRoot && attempt.inputs.context.expectedOutputsUsed === false, 'Local initial state context differs.');
  need(Array.isArray(attempt.inputEvidence) && attempt.inputEvidence.length === broker.records.length, 'Local worker evidence inventory differs.');
  let proofsVerified = 0;
  for (let i = 0; i < attempt.inputEvidence.length; i++) {
    const e = attempt.inputEvidence[i], b = broker.records[i], w = bound.get(b.id);
    need(e.id === i + 1 && b.id === i + 1 && equal(e.request, b.request) && e.requestText === JSON.stringify(e.request) && e.requestSha256 === sha(e.requestText), 'Local input evidence differs from broker.');
    if (own(e, 'result')) need(w?.status === 'completed' && equal(e.result, w.parsed.result) && e.resultSha256 === sha(JSON.stringify(e.result)), 'Worker input result differs from actual wire.');
  }
  if (attempt.inputs.ancestry !== undefined || headerWires.length) {
    need(typeof modules.validateAncestryEvidence === 'function', 'Archived ancestor evidence verifier is missing.');
    modules.validateAncestryEvidence(header, attempt.inputs.ancestry, attempt.inputEvidence);
  }
  for (const p of attempt.inputs.provenance ?? []) {
    const derived = record(p) && own(p, 'codeDerivation');
    need(record(p) && equal(Object.keys(p).sort(), ['account', 'accountProof', 'proofEvidenceId', 'codeEvidenceId', 'storage', ...(derived ? ['codeDerivation'] : [])].sort()), 'Account provenance shape differs.');
    need(integer(p.proofEvidenceId) && p.proofEvidenceId > 0, 'Account proof evidence ID differs.');
    const proof = attempt.inputEvidence[p.proofEvidenceId - 1];
    need(proof?.request.method === 'eth_getProof' && proof.request.params[0] === p.account && own(proof, 'result'), 'Proven account lacks exact proof evidence.');
    let code;
    if (derived) {
      need(p.codeEvidenceId === null && ['verified_account_absence', 'verified_account_empty_code_hash'].includes(p.codeDerivation), 'Derived code provenance differs.');
      code = '0x';
    } else {
      need(integer(p.codeEvidenceId) && p.codeEvidenceId > p.proofEvidenceId, 'Account code evidence ID differs.');
      const evidence = attempt.inputEvidence[p.codeEvidenceId - 1];
      need(evidence?.request.method === 'eth_getCode' && evidence.request.params[0] === p.account && own(evidence, 'result'), 'Proven account lacks exact code evidence.');
      code = evidence.result;
    }
    // Even an empty runtime is checked against the authenticated account leaf.
    // A child-provided derivation label never substitutes for the proof.
    const v = await modules.verifyStateProof({ stateRoot: header.stateRoot, address: p.account, storageKeys: proof.request.params[1], proof: proof.result, code });
    if (derived) need(v.account.codeHash === EMPTY_CODE_HASH && p.codeDerivation === (v.account.exists ? 'verified_account_empty_code_hash' : 'verified_account_absence'), 'Derived code label contradicts proven account.');
    need(equal(v.account, p.accountProof), 'Account facts differ from independently checked proof.'); proofsVerified++;
    const stored = attempt.inputs.accounts[p.account];
    if (!v.account.exists) {
      need(equal(stored, { exists: false }), 'Absent account was materialized in input facts.');
      for (const slot of p.storage) need(WORD.test(slot.key) && slot.value === '0x' + '0'.repeat(64) && slot.exists === false && slot.evidenceId === p.proofEvidenceId, 'Absent-account storage was not derived from its exclusion proof.');
    }
    else {
      need(stored?.exists === true && stored.nonce === v.account.nonceRaw && stored.balance === v.account.balanceRaw && stored.code === code, 'Input account basics differ from proof.');
      for (const slot of p.storage) {
        const e = attempt.inputEvidence[slot.evidenceId - 1]; need(e?.request.method === 'eth_getProof' && e.request.params[0] === p.account && own(e, 'result'), 'Storage fact lacks its proof.');
        const s = await modules.verifyStateProof({ stateRoot: header.stateRoot, address: p.account, storageKeys: e.request.params[1], proof: e.result, code });
        need(equal(s.account, v.account), 'Storage proof account differs.');
        const fact = s.storage.find(x => x.key === slot.key); need(fact && fact.valueWord === slot.value && fact.exists === slot.exists && stored.storage[slot.key] === slot.value, 'Storage input differs from verified proof.'); proofsVerified++;
      }
      need(equal(Object.keys(stored.storage).sort(), p.storage.map(s => s.key).sort()), 'Input storage has unproven entries.');
    }
  }
  need(equal(Object.keys(attempt.inputs.accounts).sort(), (attempt.inputs.provenance ?? []).map(p => p.account).sort()), 'Input account inventory contains unproven entries.');
  return { proofsVerified };
}

function verifyPhaseSummary(summary, phase, artifact) {
  const expected = { dispatch: phase.dispatch, artifact, ...(phase.reason ? { reason: phase.reason } : {}), ...(phase.httpStatus ? { httpStatus: phase.httpStatus } : {}), executionStatus: phase.attempt?.output?.execution?.status ?? phase.report?.execution?.status ?? null };
  need(equal(summary, expected), 'Compact phase summary or artifact reference differs.');
}

/** Verify a sealed packet and recompute accounting. The archived implementations
 * are hash-bound before import. This is an evidence audit, not a new VM run. */
export async function verifyCohortEvidence({ outputDirectory, expectedManifestSha256 }) {
  const p = await packet(outputDirectory, expectedManifestSha256);
  const sources = await verifyFrozenSources({ outputDirectory: p.root, expectedManifestSha256: p.manifest.sourceManifestSha256 });
  await verifyNodeRuntime(sources.manifest.runtime);
  const archived = async path => { need(sources.manifest.files.some(e => e.path === path), 'Required archived verifier dependency absent.'); return import(pathToFileURL(join(p.root, 'runtime', path))); };
  const modules = Object.assign({}, ...await Promise.all(['cohort-census.mjs', 'cohort-classification.mjs', 'cohort-outcomes.mjs', 'cohort-accounting.mjs', 'cohort-runner.mjs', 'cohort-pilot.mjs'].map(n => archived('research/standard-evm/' + n))), await archived('engines/local-evm/verified-state-proof.js'), await archived('engines/local-evm/ethereum-header.js'));
  if (sources.manifest.files.some(e => e.path === 'engines/local-evm/authenticated-ancestry.js')) Object.assign(modules, await archived('engines/local-evm/authenticated-ancestry.js'));
  const plan = await p.read('plan.json'), frozen = await p.read('FROZEN.json'), started = await p.read('STARTED.json'), results = await p.read('results.json');
  await modules.loadPilotPlan({ outputDirectory: p.root, expectedPlanSha256: p.manifest.planSha256 });
  need(results.planSha256 === p.manifest.planSha256 && results.sourceManifestSha256 === p.manifest.sourceManifestSha256 && plan.sourceManifestSha256 === p.manifest.sourceManifestSha256, 'Run/plan source binding differs.');
  need(frozen.planSha256 === p.manifest.planSha256 && started.planSha256 === p.manifest.planSha256 && started.sourceManifestSha256 === p.manifest.sourceManifestSha256 && equal(started.runtime, plan.runtime), 'Frozen/start plan identity differs.');
  need(started.schemaVersion === '1.0' && results.schemaVersion === '1.0' && integer(started.pid) && started.pid > 0 && timestamp(started.startedAt) && results.startedAt === started.startedAt && timestamp(results.finishedAt) && Date.parse(results.finishedAt) >= Date.parse(started.startedAt) && Date.parse(started.startedAt) >= Date.parse(plan.frozenAt) && finite(results.durationMs), 'Run chronology/identity is malformed.');
  need(['complete', 'selection_failed', 'interrupted'].includes(results.status) && Array.isArray(results.failures) && equal(results.scope, plan.scope) && finite(results.executionWindowMs) && results.executionWindowMs <= results.durationMs, 'Run status or declared scope differs.');
  need(typeof results.sourceUnchanged === 'boolean' && typeof results.runtimeUnchanged === 'boolean' && (results.status === 'interrupted' || (results.sourceUnchanged && results.runtimeUnchanged && results.failures.length === 0)), 'Run cannot claim stable source/runtime.');
  need(equal(results.budget?.limits, { calls: plan.policy.totalCalls, totalBytes: plan.policy.totalResponseBytes, wallMs: plan.policy.collectionAndExecutionMs }), 'Run budget policy differs.');
  const wirePaths = [...p.byPath.keys()].filter(path => /^wire\/\d{6}\.json$/.test(path)).sort(), wires = [], summaries = [], byId = new Map();
  for (const path of wirePaths) { const w = await p.read(path); need(path === `wire/${String(w.globalId).padStart(6, '0')}.json` && !byId.has(w.globalId), 'Wire filename/ID differs.'); summaries.push(verifyCohortWireRecord(w)); wires.push(w); byId.set(w.globalId, w); }
  need(integer(results.budget?.calls) && results.budget.calls >= wires.length && results.budget.calls <= 6144 && results.budget.dispatches >= wires.filter(w => w.dispatched).length && results.budget.observedBytes >= wires.reduce((s, w) => s + w.transport.observedBytes, 0), 'Final wire budget undercounts retained evidence.');
  const selection = await p.read('selection.json'), eventPaths = [...p.byPath.keys()].filter(path => /^events\/\d{5}\.json$/.test(path)).sort(), events = [];
  for (const path of eventPaths) { need(path === `events/${String(events.length + 1).padStart(5, '0')}.json`, 'Selection event file numbering differs.'); events.push(await p.read(path)); }
  const censusWires = wires.filter(w => w.profile === 'census'), input = verifyCollectorBindings(selection, censusWires, events, plan, modules.verifyEthereumHeader);
  need(results.selectionStatus === selection.status, 'Results selection status differs.');
  const claimed = new Set(censusWires.map(w => w.globalId)); let census = null, proofCount = 0, phaseDeclaredOnlyWireRecords = 0;
  if (selection.status === 'complete') {
    need(input && selection.census && selection.artifacts.failure === null, 'Completed selection is incomplete.');
    census = modules.validateCohortCensus(input); need(equal(census, selection.census), 'Recomputed census/selection differs.');
    const classificationInput = modules.classificationInput(census);
    need(equal(modules.classifyCohortIntents(classificationInput), await p.read('classification.json')), 'Recomputed all-population classification differs.');
    const run = results.caseRun; need(run && Array.isArray(run.rows) && run.rows.length === census.selected.length, 'Selected case ledger is incomplete.');
    const outcomes = []; let previousPhaseEnd = censusWires.at(-1)?.globalId ?? 0;
    for (let i = 0; i < census.selected.length; i++) {
      const row = census.selected[i], id = String(i + 1).padStart(3, '0'), entry = run.rows[i], requestPath = `cases/${id}/request.json`;
      need(entry.id === id && entry.transactionHash === row.transactionHash && equal(entry.projection, row.projection), 'Case ledger differs from selected row.');
      const interrupted = () => {
        need(run.status === 'interrupted' && run.accounting === null && record(run.fatal), 'Selected case evidence missing.');
        const reason = id === run.fatal.caseId ? 'Case evidence could not be safely completed; run interrupted' : 'Run interrupted; no replacement or further attempt';
        const expected = { outcome: { transactionHash: row.transactionHash, execution: 'provider_unavailable', comparison: 'not_comparable' }, channels: {}, reasons: [reason], allChannelsComplete: false };
        need(id >= run.fatal.caseId && equal(entry.adjudication, expected), 'Missing evidence was promoted to an outcome.'); outcomes.push(expected.outcome);
      };
      if (!p.byPath.has(requestPath)) { interrupted(); continue; }
      need(equal(await p.read(requestPath), { transactionHash: row.transactionHash, parentHeader: row.parentHeader, projection: row.projection }), 'Case projected request/header differs.');
      let adjudication;
      if (row.projection.status === 'unsupported') adjudication = { outcome: { transactionHash: row.transactionHash, execution: 'unsupported', comparison: 'not_comparable' }, channels: {}, reasons: ['Envelope cannot be represented by the frozen unsigned profile: ' + row.projection.reasons.join(', ')], allChannelsComplete: false };
      else {
        const localPath = `cases/${id}/local.json`, productPath = `cases/${id}/product.json`;
        if (!p.byPath.has(localPath) || !p.byPath.has(productPath)) { interrupted(); continue; }
        const local = await p.read(localPath), product = await p.read(productPath), localWires = wireIds(local, byId, claimed, 'local', row.parentBlockHash), productWires = wireIds(product, byId, claimed, 'product', row.parentBlockHash);
        verifyPhaseSummary(entry.local, local, localPath); verifyPhaseSummary(entry.product, product, productPath);
        const phaseWires = [...localWires, ...productWires];
        if (phaseWires.length) { need(phaseWires[0].globalId > previousPhaseEnd, 'Case execution preceded its census or previous case.'); previousPhaseEnd = phaseWires.at(-1).globalId; }
        if (localWires.length && productWires.length) need(localWires.at(-1).globalId < productWires[0].globalId, 'Product reads preceded completion of local input collection.');
        proofCount += (await verifyLocalBindings(local, localWires, row.parentHeader, modules)).proofsVerified;
        const productBinding = verifyProductBindings(product, productWires, row.projection.request);
        phaseDeclaredOnlyWireRecords += productBinding.phaseDeclaredOnlyWireRecords;
        const api = row.projection.request;
        adjudication = modules.adjudicateCohortOutcome({ transactionHash: row.transactionHash, request: { from: api.from, to: api.to, data: api.data, value: api.value, gas: '5000000', ...normalizeEvmContext(api) }, header: row.parentHeader, expectedProductImplementation: sources.manifest.productImplementation, expectedLocalImplementation: sources.manifest.localImplementation, local, product });
        if (productBinding.phaseDeclaredOnlyWireRecords) need(adjudication.outcome.execution === 'provider_unavailable' && adjudication.outcome.comparison === 'not_comparable' && adjudication.allChannelsComplete === false, 'Missing internal wire evidence was promoted into a comparison.');
      }
      need(equal(adjudication, await p.read(`cases/${id}/outcome.json`)) && equal(modules.compactAdjudication(adjudication), entry.adjudication), 'Recomputed case adjudication differs.'); outcomes.push(adjudication.outcome);
    }
    const accounting = modules.accountCohortOutcomes(census.selection, outcomes);
    if (run.status === 'complete') need(run.fatal === null && equal(run.accounting, results.status === 'interrupted' ? null : accounting) && run.interruptedLedger === null, 'Recomputed outcome accounting differs.');
    else need(run.status === 'interrupted' && run.accounting === null && equal(run.interruptedLedger, accounting.ledger), 'Interrupted ledger was repaired into metrics.');
  } else need(selection.census === null && record(selection.artifacts.failure) && results.caseRun === null && !p.byPath.has('classification.json') && ![...p.byPath.keys()].some(k => k.startsWith('cases/')), 'Failed selection fabricated a census, classification, cases or metrics.');
  const expectedStatus = results.failures.length || results.caseRun?.status === 'interrupted' ? 'interrupted' : selection.status === 'complete' ? 'complete' : 'selection_failed';
  need(results.status === expectedStatus, 'Top-level status masks a retained failure.');
  need(claimed.size === wires.length || results.caseRun?.status === 'interrupted', 'Unattributed public wires remain.');
  if (results.status === 'complete') need(wires.length === results.budget.calls && wires.every((w, i) => w.globalId === i + 1) && results.budget.dispatches === wires.filter(w => w.dispatched).length && results.budget.observedBytes === wires.reduce((s, w) => s + w.transport.observedBytes, 0), 'Complete run wire budget is not exact.');
  const unattributedWireRecords = wires.length - claimed.size, unboundWireRecords = unattributedWireRecords + phaseDeclaredOnlyWireRecords;
  return { status: 'verified', reportStatus: results.status, selectionStatus: selection.status, expectedManifestSha256, sourceManifestSha256: p.manifest.sourceManifestSha256, planSha256: p.manifest.planSha256, filesVerified: p.byPath.size, sourceFilesVerified: sources.manifest.files.length, wiresVerified: wires.length, proofChecks: proofCount, censusTransactions: census?.census.length ?? null, selectedTransactions: census?.selected.length ?? null, outcomesRecomputed: census !== null, unboundWireRecords, unattributedWireRecords, phaseDeclaredOnlyWireRecords, independentlyJoinedWireRecords: wires.length - unboundWireRecords, completeWireBinding: unboundWireRecords === 0, limitations: { newIndependentExecution: false, executionReplayed: false, consensusOrFinalityProven: false, sourceSafetyAttested: false, unretainedBodyBytesVerified: summaries.every(s => s.unretainedObservedHashVerified), originalTransactionReplay: false, allEffectsAccuracyEstablished: false } };
}
