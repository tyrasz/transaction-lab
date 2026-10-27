// Offline validation of an already selected cohort. No transport, discovery,
// outcome-dependent filtering, fallback, signature recovery or body-trie claim.
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { verifyEthereumHeader } from '../../engines/local-evm/ethereum-header.js';
import { createCohortSelection, MAX_CENSUS } from './cohort-accounting.mjs';

export const CENSUS_LIMITS = Object.freeze({ providers: 2, headersPerProvider: 256, censusTransactions: MAX_CENSUS, sampleSize: 16, inputBytes: 64 * 1024 * 1024, fieldBytes: 1024 * 1024, dataNodes: 2_000_000, depth: 16, simulationGas: 5_000_000, simulationCalldataBytes: 32 * 1024, finalityWaitMs: 20 * 60 * 1000 });
export class CohortCensusError extends Error {
  constructor(message) { super(message); this.name = 'CohortCensusError'; this.code = 'COHORT_CENSUS_INVALID'; }
}
const need = (ok, message) => { if (!ok) throw new CohortCensusError(message); };
const has = (o, k) => Object.hasOwn(o, k);
const freeze = o => { if (o && typeof o === 'object') { Object.values(o).forEach(freeze); Object.freeze(o); } return o; };
const sorted = o => Object.fromEntries(Object.keys(o).sort().map(k => [k, o[k]]));
// keccak256(RLP(empty bytes)); this is only the empty-list consistency check,
// not verification of a nonempty transaction trie or its signed envelopes.
const EMPTY_TRIE = '0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421';
const bytes = (v, n, label) => { need(typeof v === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(v) && (n === undefined || v.length === 2 + n * 2), `${label} has invalid hex bytes or width.`); return v.toLowerCase(); };
const hash = (v, label) => bytes(v, 32, label);
const address = (v, label) => bytes(v, 20, label);
function quantity(v, label, bits = 256) {
  need(typeof v === 'string' && /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(v) && v.length <= 66 && BigInt(v) < (1n << BigInt(bits)), `${label} must be a canonical uint${bits} RPC quantity.`);
  return BigInt(v).toString();
}
function decimal(v, label) { need(typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v) && v.length <= 20 && BigInt(v) < (1n << 64n), `${label} must be a canonical uint64 decimal.`); return v; }
function keys(o, expected, label) { need(o && !Array.isArray(o) && typeof o === 'object' && Object.keys(o).length === expected.length && expected.every(k => has(o, k)), `${label} has missing or unsupported fields.`); }
function array(v, max, label) { need(Array.isArray(v) && v.length <= max, `${label} must be a bounded array.`); return v; }
function time(v, label) { need(typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v, `${label} must be an ISO UTC timestamp with milliseconds.`); return Date.parse(v); }

// Traverse descriptors before reading values: sparse arrays, getters, symbols,
// cycles and exotic objects cannot masquerade as recorded JSON evidence.
function copyInput(input) {
  let nodes = 0; const active = new Set();
  function copy(v, depth) {
    need(++nodes <= CENSUS_LIMITS.dataNodes && depth <= CENSUS_LIMITS.depth, 'Input structure exceeds its bound.');
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'number') { need(Number.isSafeInteger(v), 'Input numbers must be safe integers.'); return v; }
    if (typeof v === 'string') { need(Buffer.byteLength(v) <= CENSUS_LIMITS.fieldBytes, 'Input string exceeds its bound.'); return v; }
    need(v && typeof v === 'object' && (Array.isArray(v) || Object.getPrototypeOf(v) === Object.prototype), 'Input must contain only plain JSON data.');
    need(!active.has(v), 'Input cannot contain cycles.'); active.add(v);
    const own = Reflect.ownKeys(v), out = Array.isArray(v) ? [] : {};
    if (Array.isArray(v)) need(own.length === v.length + 1 && v.length <= CENSUS_LIMITS.dataNodes, 'Input arrays must be dense and bounded.');
    for (const k of own) {
      if (Array.isArray(v) && k === 'length') continue;
      const d = Object.getOwnPropertyDescriptor(v, k);
      need(typeof k === 'string' && k !== '__proto__' && k !== 'constructor' && k !== 'prototype' && d.enumerable && has(d, 'value'), 'Input contains an unsupported property.');
      if (Array.isArray(v)) need(/^(0|[1-9][0-9]*)$/.test(k) && Number(k) < v.length, 'Input array contains a non-index property.');
      out[k] = copy(d.value, depth + 1);
    }
    active.delete(v); return out;
  }
  const out = copy(input, 0);
  need(Buffer.byteLength(JSON.stringify(out)) <= CENSUS_LIMITS.inputBytes, 'Input exceeds the parsed JSON byte bound.');
  return out;
}

const BASE_FIELDS = ['hash', 'from', 'to', 'input', 'value', 'gas', 'nonce', 'blockHash', 'blockNumber', 'transactionIndex'];
const KNOWN_FIELDS = new Set([...BASE_FIELDS, 'type', 'chainId', 'gasPrice', 'maxFeePerGas', 'maxPriorityFeePerGas', 'maxFeePerBlobGas', 'blobVersionedHashes', 'accessList', 'authorizationList', 'v', 'r', 's', 'yParity']);
function signatureWord(v, label) {
  // Some clients use fixed 32-byte DATA for r/s, others minimal QUANTITY.
  if (typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v)) return BigInt(v).toString();
  return quantity(v, label);
}
function accessList(v) {
  return array(v, MAX_CENSUS, 'Access list').map(item => {
    keys(item, ['address', 'storageKeys'], 'Access-list entry');
    return { address: address(item.address, 'Access-list address'), storageKeys: array(item.storageKeys, MAX_CENSUS, 'Storage-key list').map(k => hash(k, 'Access-list slot')) };
  });
}
function authorizations(v) {
  return array(v, MAX_CENSUS, 'Authorization list').map(item => {
    keys(item, ['chainId', 'address', 'nonce', 'yParity', 'r', 's'], 'Authorization entry');
    const yParity = quantity(item.yParity, 'Authorization parity'); need(BigInt(yParity) <= 1n, 'Authorization parity is outside 0/1.');
    return { chainId: quantity(item.chainId, 'Authorization chain'), address: address(item.address, 'Authorization address'), nonce: quantity(item.nonce, 'Authorization nonce', 64), yParity, r: signatureWord(item.r, 'Authorization r'), s: signatureWord(item.s, 'Authorization s') };
  });
}
function normalizeEnvelope(tx, header, index) {
  need(tx && typeof tx === 'object' && !Array.isArray(tx) && BASE_FIELDS.every(k => has(tx, k)), 'Target transaction is not a complete envelope.');
  const n = {
    hash: hash(tx.hash, 'Transaction hash'), from: address(tx.from, 'Transaction sender'), to: tx.to === null ? null : address(tx.to, 'Transaction recipient'),
    input: bytes(tx.input, undefined, 'Transaction input'), value: quantity(tx.value, 'Transaction value'), gas: quantity(tx.gas, 'Transaction gas', 64), nonce: quantity(tx.nonce, 'Transaction nonce', 64),
    blockHash: hash(tx.blockHash, 'Transaction block hash'), blockNumber: quantity(tx.blockNumber, 'Transaction block number', 64), transactionIndex: quantity(tx.transactionIndex, 'Transaction index', 64),
    type: has(tx, 'type') ? quantity(tx.type, 'Transaction type', 8) : '0', r: signatureWord(tx.r, 'Transaction r'), s: signatureWord(tx.s, 'Transaction s'),
  };
  need(n.blockHash === header.hash.toLowerCase() && n.blockNumber === BigInt(header.number).toString() && n.transactionIndex === String(index), 'Transaction block identity or contiguous index differs from its position.');
  need(BigInt(n.gas) > 0n && BigInt(n.gas) <= BigInt(header.gasLimit), 'Transaction gas exceeds its containing block or is zero.');
  const type = Number(n.type), legacy = type === 0, dynamic = [2, 3, 4].includes(type);
  for (const k of ['gasPrice', 'maxFeePerGas', 'maxPriorityFeePerGas', 'maxFeePerBlobGas', 'chainId', 'v', 'yParity']) if (has(tx, k)) n[k] = quantity(tx[k], `Transaction ${k}`);
  if (has(tx, 'accessList')) n.accessList = accessList(tx.accessList);
  if (has(tx, 'blobVersionedHashes')) n.blobVersionedHashes = array(tx.blobVersionedHashes, MAX_CENSUS, 'Blob hashes').map(k => hash(k, 'Blob versioned hash'));
  if (has(tx, 'authorizationList')) n.authorizationList = authorizations(tx.authorizationList);
  if (legacy) {
    need(has(n, 'v') && has(n, 'gasPrice'), 'Legacy transaction requires v and gasPrice.');
    const v = BigInt(n.v), protectedChain = v >= 35n ? ((v - 35n) / 2n).toString() : null;
    need(v === 27n || v === 28n || protectedChain === '1', 'Legacy signature encodes an unsupported chain or v.');
    if (has(n, 'chainId')) need(n.chainId === '1' && protectedChain === '1', 'Legacy chainId disagrees with v.');
    n.chainId = protectedChain;
    if (has(n, 'yParity')) need(n.yParity === ((v - (protectedChain ? 35n : 27n)) % 2n).toString(), 'Legacy parity disagrees with v.');
    delete n.yParity;
    need(!['accessList', 'maxFeePerGas', 'maxPriorityFeePerGas', 'maxFeePerBlobGas', 'blobVersionedHashes', 'authorizationList'].some(k => has(n, k)), 'Legacy transaction contains typed-only fields.');
  } else {
    need(n.chainId === '1', 'Typed transaction chainId must be 1.');
    need(has(n, 'v') || has(n, 'yParity'), 'Typed transaction requires signature parity.');
    const parity = n.yParity ?? n.v; need(parity === '0' || parity === '1', 'Typed signature parity must be 0/1.');
    if (has(n, 'v')) need(n.v === parity, 'Typed v and yParity disagree.');
    n.yParity = parity; delete n.v;
    if ([1, 2, 3, 4].includes(type)) need(has(n, 'accessList'), 'Known typed transaction requires accessList.');
    if (type === 1) {
      need(has(n, 'gasPrice') && !['maxFeePerGas', 'maxPriorityFeePerGas', 'maxFeePerBlobGas', 'blobVersionedHashes', 'authorizationList'].some(k => has(n, k)), 'Access-list transaction fee fields are incomplete or inconsistent.');
    }
    if (dynamic) {
      need(has(n, 'maxFeePerGas') && has(n, 'maxPriorityFeePerGas') && BigInt(n.maxPriorityFeePerGas) <= BigInt(n.maxFeePerGas), 'Dynamic transaction fee fields are incomplete or inconsistent.');
      const actual = [BigInt(n.maxFeePerGas), BigInt(header.baseFeePerGas) + BigInt(n.maxPriorityFeePerGas)].reduce((a, b) => a < b ? a : b);
      if (has(n, 'gasPrice')) need(n.gasPrice === actual.toString(), 'Optional effective gasPrice disagrees with the header and fee caps.');
      delete n.gasPrice;
      if (type === 3) need(has(n, 'maxFeePerBlobGas') && n.blobVersionedHashes?.length > 0 && !has(n, 'authorizationList'), 'Blob transaction fields are incomplete or inconsistent.');
      else need(!has(n, 'maxFeePerBlobGas') && !has(n, 'blobVersionedHashes'), 'Non-blob transaction contains blob fields.');
      if (type === 4) need(n.authorizationList?.length > 0, 'Authorization transaction requires authorizations.');
      else need(!has(n, 'authorizationList'), 'Non-authorization transaction contains authorizations.');
    }
  }
  n.extensions = sorted(Object.fromEntries(Object.entries(tx).filter(([k]) => !KNOWN_FIELDS.has(k))));
  return sorted(n);
}

function headerHelpers(header, target) {
  for (const k of ['size', 'totalDifficulty']) if (has(header, k)) quantity(header[k], `Header helper ${k}`);
  if (has(header, 'uncles')) need(array(header.uncles, 0, 'Post-Merge uncles').length === 0, 'Post-Merge uncles must be empty.');
  if (has(header, 'withdrawals')) array(header.withdrawals, 16, 'Withdrawals').forEach(w => {
    keys(w, ['index', 'validatorIndex', 'address', 'amount'], 'Withdrawal');
    for (const k of ['index', 'validatorIndex', 'amount']) quantity(w[k], `Withdrawal ${k}`, 64);
    address(w.address, 'Withdrawal address');
  });
  const txs = array(header.transactions, MAX_CENSUS, 'Header transactions');
  need((txs.length === 0) === (header.transactionsRoot.toLowerCase() === EMPTY_TRIE), 'Transaction list emptiness contradicts its committed trie root.');
  const envelopes = target ? txs.map((tx, i) => normalizeEnvelope(tx, header, i)) : null;
  const hashes = target ? envelopes.map(tx => tx.hash) : txs.map(tx => hash(tx, 'Non-target transaction hash'));
  need(new Set(hashes).size === hashes.length, 'Duplicate transaction hash in a block.');
  return { hashes, envelopes };
}
function projection(envelope, parentHeader) {
  const reasons = [];
  if (envelope.to === null) reasons.push('contract_creation');
  if (envelope.type === '1' || envelope.accessList?.length) reasons.push('access_list_context_unsupported');
  if (envelope.type === '3') reasons.push('blob_context_unsupported');
  if (envelope.type === '4') reasons.push('authorization_context_unsupported');
  if (!['0', '1', '2', '3', '4'].includes(envelope.type)) reasons.push('unknown_transaction_type');
  if (Object.keys(envelope.extensions).length) reasons.push('unrecognized_envelope_fields');
  if (BigInt(envelope.gas) > BigInt(CENSUS_LIMITS.simulationGas)) reasons.push('original_gas_limit_exceeds_profile');
  if ((envelope.input.length - 2) / 2 > CENSUS_LIMITS.simulationCalldataBytes) reasons.push('calldata_exceeds_profile');
  if ([envelope.from, envelope.to].includes('0x000000000000000000000000000000000000ba1a')) reasons.push('reserved_profile_witness_address');
  return {
    status: reasons.length ? 'unsupported' : 'projectable', reasons,
    ...(reasons.length ? {} : { request: { chainId: 1, from: envelope.from, to: envelope.to, data: envelope.input, value: envelope.value, block: parentHeader.hash.toLowerCase() } }),
    profile: 'unsigned_unpriced_parent_block_end', simulationGas: String(CENSUS_LIMITS.simulationGas), originalGasLimit: envelope.gas,
    omittedOuterFields: ['nonce', 'gas', 'gasPrice', 'maxFeePerGas', 'maxPriorityFeePerGas', 'signature', 'transaction_type', 'access_list', 'blob_context', 'authorizations'],
    prerequisites: { senderCode: 'not_checked', executionSupport: 'not_established' },
    originalPositionReplay: false, outerTransactionValidation: false, transactionFeesIncluded: false, syntheticBaseFeePerGas: '0',
  };
}

/** observations must be ordered primary, secondary. Each has chainId 0x1,
 * provider, finalizedObservedAt, finalizedBlockHash and contiguous headers from
 * H through that fixed tip. H+1/H+2 have full tx objects; other headers have hash
 * lists. Caller timestamps and provider finality/body claims are not authenticated.
 */
export function validateCohortCensus(raw) {
  const input = copyInput(raw);
  keys(input, ['chainId', 'anchor', 'targetBlockNumbers', 'anchorObservedAt', 'seed', 'sampleSize', 'observations'], 'Census input');
  need(input.chainId === 1, 'Only chainId 1 is supported.');
  keys(input.anchor, ['blockNumber', 'blockHash'], 'Anchor');
  const anchor = { blockNumber: decimal(input.anchor.blockNumber, 'Anchor number'), blockHash: hash(input.anchor.blockHash, 'Anchor hash') };
  const anchorTime = time(input.anchorObservedAt, 'Anchor observation time');
  const seed = hash(input.seed, 'Seed');
  const targetBlockNumbers = array(input.targetBlockNumbers, 2, 'Target numbers').map(n => decimal(n, 'Target number'));
  need(targetBlockNumbers.length === 2 && targetBlockNumbers.every((n, i) => BigInt(n) === BigInt(anchor.blockNumber) + BigInt(i + 1)), 'Targets must be exactly H+1 and H+2 in order.');
  need(Number.isSafeInteger(input.sampleSize) && input.sampleSize >= 0 && input.sampleSize <= CENSUS_LIMITS.sampleSize, 'Pilot sampleSize exceeds 16.');
  const targets = new Set(targetBlockNumbers), providers = array(input.observations, 2, 'Observations');
  need(providers.length === 2, 'Exactly two provider observations are required.');
  const processed = providers.map(o => {
    keys(o, ['provider', 'chainId', 'finalizedObservedAt', 'finalizedBlockHash', 'headers'], 'Observation');
    need(typeof o.provider === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(o.provider), 'Provider identifier is invalid.');
    need(o.chainId === '0x1', 'Observed chainId must be 0x1.');
    need(time(o.finalizedObservedAt, 'Finalized observation time') >= anchorTime + CENSUS_LIMITS.finalityWaitMs, 'Finality was checked before the declared 20-minute wait.');
    const finalizedBlockHash = hash(o.finalizedBlockHash, 'Finalized hash');
    need(array(o.headers, CENSUS_LIMITS.headersPerProvider, 'Ancestry headers').length >= 3, 'Ancestry must include H, H+1 and H+2.');
    const seen = new Set();
    const verifiedHeaders = o.headers.map((h, i) => {
      let verified;
      try { verified = verifyEthereumHeader({ header: h, expectedHash: h.hash }); } catch (e) { throw new CohortCensusError(`Execution header ${i} failed hash/shape validation: ${e.message}`); }
      need(verified.number === (BigInt(anchor.blockNumber) + BigInt(i)).toString(), 'Ancestry headers are not consecutive from H.');
      need(!seen.has(verified.blockHash), 'Duplicate ancestry header.'); seen.add(verified.blockHash);
      if (i === 0) need(verified.blockHash === anchor.blockHash, 'Observation anchor differs from the preselected anchor.');
      else {
        need(verified.parentHash === o.headers[i - 1].hash.toLowerCase(), 'Header parent does not link to the previous header.');
        need(BigInt(verified.timestamp) > BigInt(o.headers[i - 1].timestamp), 'Header timestamps are not increasing.');
      }
      return { ...verified, ...headerHelpers(h, targets.has(verified.number)) };
    });
    need(verifiedHeaders.at(-1).blockHash === finalizedBlockHash, 'Finalized hash is not the last ancestry header.');
    need(BigInt(verifiedHeaders.at(-1).number) >= BigInt(targetBlockNumbers[1]), 'Reported finalized tip is below the targets.');
    return { provider: o.provider, finalizedBlockHash, finalizedBlockNumber: verifiedHeaders.at(-1).number, finalizedObservedAt: o.finalizedObservedAt, headerCount: verifiedHeaders.length, verifiedHeaders, originalHeaders: o.headers };
  });
  need(processed[0].provider !== processed[1].provider, 'Provider identifiers must be distinct.');
  for (let i = 0; i < Math.min(...processed.map(o => o.headerCount)); i++) {
    const a = processed[0].verifiedHeaders[i], b = processed[1].verifiedHeaders[i];
    need(a.blockHash === b.blockHash, 'Providers disagree on an overlapping execution header.');
    need(isDeepStrictEqual(a.hashes, b.hashes), 'Providers disagree on complete ordered transaction hashes.');
    if (targets.has(a.number)) need(isDeepStrictEqual(a.envelopes, b.envelopes), 'Providers disagree on normalized transaction envelopes.');
  }
  const census = [], envelopes = [], seen = new Set();
  for (const number of targetBlockNumbers) {
    const offset = Number(BigInt(number) - BigInt(anchor.blockNumber)), primary = processed[0].verifiedHeaders[offset];
    for (let i = 0; i < primary.envelopes.length; i++) {
      const tx = primary.envelopes[i]; need(!seen.has(tx.hash), 'Duplicate transaction across target blocks.'); seen.add(tx.hash);
      need(census.length < CENSUS_LIMITS.censusTransactions, 'Census transaction bound exceeded.');
      const row = { transactionHash: tx.hash, blockHash: primary.blockHash, blockNumber: number, transactionIndex: String(i) };
      census.push(row);
      envelopes.push({ ...row, normalizedEnvelope: tx, providerEnvelopes: processed.map(p => ({ provider: p.provider, envelope: p.originalHeaders[offset].transactions[i] })) });
    }
  }
  const selection = createCohortSelection({ chainId: 1, census, seed, sampleSize: input.sampleSize });
  const byHash = new Map(envelopes.map(e => [e.transactionHash, e]));
  const selected = selection.rows.filter(r => r.selected).map(row => {
    const offset = Number(BigInt(row.blockNumber) - BigInt(anchor.blockNumber)) - 1;
    const originalParent = processed[0].originalHeaders[offset];
    const parentHeader = { ...originalParent, transactions: originalParent.transactions.map(tx => typeof tx === 'string' ? tx : tx.hash) };
    return { ...row, parentBlockHash: parentHeader.hash.toLowerCase(), parentHeader, parentHeaderTransformation: 'Primary provider header; full transaction objects, if present, replaced only by their ordered transaction hashes.', projection: projection(byHash.get(row.transactionHash).normalizedEnvelope, parentHeader) };
  });
  const result = {
    schemaVersion: '1.0', chainId: 1, anchor, targetBlockNumbers, anchorObservedAt: input.anchorObservedAt,
    providers: processed, census, envelopes, selection, selected, limits: { ...CENSUS_LIMITS },
    normalizations: [
      'Known hex bytes are case-insensitive; quantities become canonical decimal strings in normalized envelopes only.',
      'Missing transaction type means legacy; legacy chainId is derived from EIP-155 v, or null for unprotected v27/v28.',
      'Typed v/yParity are equivalent after validation; legacy redundant yParity must agree. Signature r/s may be fixed 32-byte DATA or minimal QUANTITY.',
      'Optional typed effective gasPrice is validated against fee caps and header baseFee, then omitted from normalized agreement.',
      'Optional header size, totalDifficulty, withdrawals and uncles are shape-validated but excluded from cross-provider header/body agreement. Header hashes still bind withdrawal and transaction roots.',
      'Unknown envelope extensions are preserved and compared as supplied, and make the unsigned projection unsupported.',
      'Empty transaction lists must match the empty trie root; nonempty transaction tries are not reconstructed.',
    ],
    trust: {
      headerHashesRecomputed: true, contiguousAncestryToEachReportedFinalizedTip: true, twoProviderOrderedBodyAndEnvelopeAgreement: true,
      blockBodyTrieVerified: false, transactionHashesRecomputed: false, signaturesOrSendersVerified: false, consensusFinalityVerified: false,
      providerIndependenceVerified: false, censusCompletenessCryptographicallyEstablished: false, predeclarationChronologyVerified: false, timestampsAuthenticated: false,
      originalPositionReplay: false, economicCompletenessEstablished: false, securityAssessment: 'not_assessed',
      description: 'Both providers supply the same complete-looking bodies and normalized envelopes. Their agreement and finalized tags are evidence, not consensus or transaction-trie proofs. Projection asks a different unsigned parent-state question and does not establish execution support.',
    },
  };
  return freeze({ ...result, censusId: createHash('sha256').update(JSON.stringify(result)).digest('hex') });
}
