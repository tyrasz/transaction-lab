// Intent strata only. This module never consumes execution/product outcomes and
// never promotes a selector or declared address into verified economic effects.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { MAX_CENSUS } from './cohort-accounting.mjs';

export const INTENT_CATEGORIES = Object.freeze(['transfer', 'approval_permit', 'swap', 'lending', 'vault_wrapper', 'other_unknown']);
export const CLASSIFICATION_LIMITS = Object.freeze({ rows: MAX_CENSUS, inputBytes: 64 * 1024 * 1024, calldataBytes: 512 * 1024, abiDecodeBytes: 32 * 1024 });
export class CohortClassificationError extends Error {
  constructor(message) { super(message); this.name = 'CohortClassificationError'; this.code = 'COHORT_CLASSIFICATION_INVALID'; }
}
const need = (ok, why) => { if (!ok) throw new CohortClassificationError(why); };
const own = (o, k) => Object.hasOwn(o, k);
const sha = v => createHash('sha256').update(v).digest('hex');
const freeze = v => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };
const metadataBytes = readFileSync(new URL('./cohort-deployments.json', import.meta.url));
export const DEPLOYMENT_METADATA_SHA256 = sha(metadataBytes);
export const DEPLOYMENT_METADATA = freeze(JSON.parse(metadataBytes));
const methodById = new Map(DEPLOYMENT_METADATA.methods.map(m => [m.id, m]));
const deploymentByAddress = new Map(DEPLOYMENT_METADATA.deployments.map(d => [d.address, d]));
need(DEPLOYMENT_METADATA.chainId === 1 && methodById.size === DEPLOYMENT_METADATA.methods.length && deploymentByAddress.size === DEPLOYMENT_METADATA.deployments.length, 'Frozen deployment metadata is inconsistent.');
for (const m of methodById.values()) {
  need(/^0x[0-9a-f]{8}$/.test(m.selector) && INTENT_CATEGORIES.includes(m.category), 'Frozen method metadata is inconsistent.');
  need(m.flattenedAbiTypes.every((t, i, ts) => /^(address|bytes32|uint(8|16|24|160|256))$/.test(t) || t === 'bytes' && i === ts.length - 1), 'Frozen ABI layout is unsupported.');
}
for (const d of deploymentByAddress.values()) {
  need(/^0x[0-9a-f]{40}$/.test(d.address) && d.methods.every(id => methodById.has(id)), 'Frozen deployment method reference is invalid.');
  need(new Set(d.methods.map(id => methodById.get(id).selector)).size === d.methods.length, 'Frozen deployment contains ambiguous selectors.');
}

const ROW_KEYS = ['transactionHash', 'blockHash', 'blockNumber', 'transactionIndex'];
const ENVELOPE_KEYS = [...ROW_KEYS, 'from', 'to', 'input', 'value'];
function record(v, keys, label) {
  need(v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype, `${label} must be a plain record.`);
  const found = Reflect.ownKeys(v);
  need(found.length === keys.length && found.every(k => keys.includes(k)), `${label} has missing or unsupported fields.`);
  for (const k of keys) { const d = Object.getOwnPropertyDescriptor(v, k); need(d && own(d, 'value') && d.enumerable, `${label} must contain data fields.`); }
}
function list(v, label) {
  need(Array.isArray(v) && v.length <= MAX_CENSUS && Reflect.ownKeys(v).length === v.length + 1, `${label} must be a bounded dense array.`);
  for (let i = 0; i < v.length; i++) { const d = Object.getOwnPropertyDescriptor(v, String(i)); need(d && own(d, 'value') && d.enumerable, `${label} must contain data entries.`); }
}
function hex(v, length, label) { need(typeof v === 'string' && new RegExp(`^0x[0-9a-fA-F]{${length * 2}}$`).test(v), `${label} is malformed.`); return v.toLowerCase(); }
function integer(v, bits, label) { need(typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v) && v.length <= (bits === 64 ? 20 : 78) && BigInt(v) < (1n << BigInt(bits)), `${label} is not a canonical uint${bits} decimal string.`); return v; }
function row(v) { return { transactionHash: hex(v.transactionHash, 32, 'Transaction hash'), blockHash: hex(v.blockHash, 32, 'Block hash'), blockNumber: integer(v.blockNumber, 64, 'Block number'), transactionIndex: integer(v.transactionIndex, 64, 'Transaction index') }; }
const compare = (a, b) => BigInt(a.blockNumber) < BigInt(b.blockNumber) ? -1 : BigInt(a.blockNumber) > BigInt(b.blockNumber) ? 1 : BigInt(a.transactionIndex) < BigInt(b.transactionIndex) ? -1 : BigInt(a.transactionIndex) > BigInt(b.transactionIndex) ? 1 : 0;

// Deliberately bounded ABI subset: static words/static tuples, optionally one
// canonical final bytes tail. No callbacks, multicall children or router commands
// are decoded. Strict canonical shape may leave executable noncanonical ABI unknown.
function abiShape(input, method) {
  if ((input.length - 2) / 2 > CLASSIFICATION_LIMITS.abiDecodeBytes) return { status: 'unexamined', reason: 'abi_decode_bound' };
  const body = input.slice(10), types = method.flattenedAbiTypes, dynamic = types.at(-1) === 'bytes';
  if (body.length < types.length * 64 || !dynamic && body.length !== types.length * 64) return { status: 'invalid', reason: 'abi_length_mismatch' };
  let tailBytes = null;
  for (let i = 0; i < types.length; i++) {
    const word = body.slice(i * 64, (i + 1) * 64), type = types[i], n = BigInt('0x' + word);
    if (type === 'address' && n >= (1n << 160n) || type.startsWith('uint') && n >= (1n << BigInt(type.slice(4)))) return { status: 'invalid', reason: 'abi_noncanonical_word' };
    if (type === 'bytes') {
      if (n !== BigInt(types.length * 32) || body.length < (types.length + 1) * 64) return { status: 'invalid', reason: 'abi_noncanonical_offset' };
      const length = BigInt('0x' + body.slice(types.length * 64, (types.length + 1) * 64));
      if (length > BigInt(CLASSIFICATION_LIMITS.abiDecodeBytes)) return { status: 'invalid', reason: 'abi_tail_out_of_bounds' };
      tailBytes = Number(length);
      const padded = Math.ceil(tailBytes / 32) * 64, tailStart = (types.length + 1) * 64;
      if (body.length !== tailStart + padded || !/^0*$/.test(body.slice(tailStart + tailBytes * 2))) return { status: 'invalid', reason: 'abi_tail_length_or_padding' };
    }
  }
  return { status: 'canonical_shape', ...(tailBytes === null ? {} : { tailBytes }) };
}
function classify(e) {
  const selector = e.input.length >= 10 ? e.input.slice(0, 10) : null;
  const deployment = deploymentByAddress.get(e.to), tags = [], hints = [];
  const result = { ...row(e), category: 'other_unknown', classificationKind: 'declared_intent', confidence: 'unknown', reason: 'unrecognized_call', selector, envelope: e, envelopeSha256: sha(JSON.stringify(e)), declaration: deployment ? { id: deployment.id, name: deployment.name, kind: deployment.kind, address: deployment.address, sourceIds: deployment.sourceIds, identityAtStateVerified: false } : null, method: null, abiShape: null, hints, tags, economicEffectsVerified: false, executionSuccessKnown: false };
  if (e.to === null) { result.reason = 'contract_creation'; tags.push('creation'); return result; }
  if (deployment?.kind === 'router') tags.push('declared_router_destination');
  if (e.input === '0x') {
    if (BigInt(e.value) > 0n) { result.category = 'transfer'; result.confidence = 'envelope_form_only'; result.reason = 'positive_native_value_without_calldata'; tags.push('native_value_intent', 'recipient_code_unknown'); }
    else result.reason = 'empty_calldata_zero_value';
    return result;
  }
  if (BigInt(e.value) > 0n) tags.push('native_value_attached', 'mixed_effects_possible');
  if (!selector) { result.reason = 'short_calldata'; return result; }
  const candidateMethods = DEPLOYMENT_METADATA.methods.filter(m => m.selector === selector);
  for (const m of candidateMethods) hints.push({ category: m.category, signature: m.signature, confidence: 'selector_only', abiShape: abiShape(e.input, m), effectsVerified: false });
  const batch = DEPLOYMENT_METADATA.batchSelectorHints.find(m => m.selector === selector);
  if (batch) { hints.push({ signature: batch.signature, confidence: 'selector_only', abiShape: { status: 'unexamined' }, effectsVerified: false }); tags.push('batch_or_router_selector_hint', 'mixed_effects_possible', 'nested_actions_unexamined'); result.reason = 'batch_or_router_contents_unknown'; }
  const method = deployment?.methods.map(id => methodById.get(id)).find(m => m.selector === selector);
  if (!method) { if (!batch) result.reason = deployment ? 'declared_destination_method_unknown' : hints.length ? 'selector_without_declared_destination' : 'unrecognized_call'; return result; }
  result.method = { id: method.id, signature: method.signature, sourceIds: method.sourceIds };
  result.abiShape = abiShape(e.input, method);
  if (result.abiShape.status !== 'canonical_shape') { result.reason = result.abiShape.reason; return result; }
  if (!method.payable && BigInt(e.value) !== 0n) { result.reason = 'value_attached_to_declared_nonpayable_method'; return result; }
  result.category = method.category; result.confidence = 'declared_address_and_abi_shape'; result.reason = 'declared_method_intent'; tags.push(...method.tags);
  if ((result.abiShape.tailBytes ?? 0) > 0) tags.push('callback_data_present', 'mixed_effects_possible');
  return result;
}

/** Minimal projection from validated census.envelopes.normalizedEnvelope:
 * {transactionHash,blockHash,blockNumber,transactionIndex,from,to,input,value}.
 * Every census row is required exactly once; no product, selection or outcome
 * data is accepted. This does not authenticate those projected envelopes.
 */
export function classifyCohortIntents(input) {
  record(input, ['chainId', 'census', 'envelopes'], 'Classification input');
  need(input.chainId === 1, 'Only Ethereum chainId 1 is supported.');
  list(input.census, 'Census'); list(input.envelopes, 'Envelopes');
  need(input.census.length === input.envelopes.length, 'Every census row needs one envelope.');
  const censusByHash = new Map(), positions = new Set(), numbers = new Map(), blocks = new Map();
  const census = input.census.map(v => {
    record(v, ROW_KEYS, 'Census row'); const r = row(v), position = `${r.blockHash}:${r.transactionIndex}`;
    need(!censusByHash.has(r.transactionHash) && !positions.has(position), 'Duplicate census identity.');
    need(!numbers.has(r.blockNumber) || numbers.get(r.blockNumber) === r.blockHash, 'Conflicting block hash.');
    need(!blocks.has(r.blockHash) || blocks.get(r.blockHash) === r.blockNumber, 'Conflicting block number.');
    censusByHash.set(r.transactionHash, r); positions.add(position); numbers.set(r.blockNumber, r.blockHash); blocks.set(r.blockHash, r.blockNumber); return r;
  }).sort(compare);
  let inputBytes = Buffer.byteLength(JSON.stringify(census));
  const envelopes = new Map();
  for (const v of input.envelopes) {
    record(v, ENVELOPE_KEYS, 'Envelope'); const r = row(v), original = censusByHash.get(r.transactionHash);
    need(original && ROW_KEYS.every(k => original[k] === r[k]) && !envelopes.has(r.transactionHash), 'Missing, foreign, conflicting or duplicate envelope identity.');
    need(typeof v.input === 'string' && v.input.length <= CLASSIFICATION_LIMITS.calldataBytes * 2 + 2 && /^0x(?:[0-9a-fA-F]{2})*$/.test(v.input), 'Calldata must be bounded hex bytes.');
    const e = { ...r, from: hex(v.from, 20, 'Sender'), to: v.to === null ? null : hex(v.to, 20, 'Destination'), input: v.input.toLowerCase(), value: integer(v.value, 256, 'Value') };
    inputBytes += Buffer.byteLength(JSON.stringify(e)); need(inputBytes <= CLASSIFICATION_LIMITS.inputBytes, 'Classification input exceeds its byte bound.'); envelopes.set(e.transactionHash, e);
  }
  const rows = census.map(r => classify(envelopes.get(r.transactionHash))), counts = Object.fromEntries(INTENT_CATEGORIES.map(k => [k, 0]));
  rows.forEach(r => counts[r.category]++);
  const result = { schemaVersion: '1.0', chainId: 1, classificationKind: 'declared_intent', censusSize: census.length, classifiedRows: rows.length, counts, rows,
    metadata: { path: 'research/standard-evm/cohort-deployments.json', sha256: DEPLOYMENT_METADATA_SHA256, reviewedOn: DEPLOYMENT_METADATA.reviewedOn, deployments: DEPLOYMENT_METADATA.deployments, sources: DEPLOYMENT_METADATA.sources, scope: DEPLOYMENT_METADATA.scope, sourceSnapshot: DEPLOYMENT_METADATA.sourceSnapshot },
    policy: { categoryPartition: 'One primary declared-intent category for every N row, including other_unknown; secondary tags overlap.', sourceOfClassification: 'Observed envelope plus frozen declared address/ABI metadata only.', genericSelectorRule: 'Unknown destinations remain other_unknown even with canonical ERC20/ERC4626-looking calldata.', routerRule: 'Undecoded batch/router commands remain other_unknown; nested actions are not inferred.', abiRule: 'Strict bounded canonical shape only; noncanonical or unimplemented shapes remain unknown, not excluded.' },
    limitations: { destinationIdentityAtStateVerified: false, historicalDeploymentRangeVerified: false, codeOrProxyImplementationVerified: false, selectorUniquenessGuaranteed: false, executionSuccessKnown: false, economicEffectsVerified: false, ownershipVerified: false, nestedActionCompletenessEstablished: false, censusAuthenticityEstablished: false, selectionOrOutcomeUsed: false, metadataPredeclarationChronologyVerified: false, securityAssessment: 'not_assessed' },
  };
  return freeze({ ...result, classificationId: sha(JSON.stringify(result)) });
}
