// Pure development normalizer. No RPC, file access, execution or replay-index
// inference. Caller-supplied provenance must be authenticated/sealed upstream.
import { isDeepStrictEqual } from 'node:util';

const HASH = /^0x[0-9a-f]{64}$/i, ADDRESS = /^0x[0-9a-f]{40}$/i, HEX = /^0x(?:[0-9a-f]{2})*$/i;
const SHA = /^[0-9a-f]{64}$/i;
export const BLOCK_VIEW_LIMITS = Object.freeze({ maxListEntries: 4096, maxLookupsPerProvider: 4096, maxJsonNodes: 200000, maxInputStringBytes: 16 * 1024 * 1024, maxCalldataBytes: 128 * 1024 });
export const SYSTEM_IDENTITY_FIELDS = Object.freeze(['type', 'chainId', 'nonce', 'gasPrice', 'gas', 'from', 'to', 'value', 'input', 'blockHash', 'blockNumber', 'transactionIndex']);
const REPRESENTATION_FIELDS = ['hash', 'r', 's', 'v'];
const BASE_FIELDS = [...SYSTEM_IDENTITY_FIELDS, ...REPRESENTATION_FIELDS];
const lower = value => typeof value === 'string' ? value.toLowerCase() : value;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => { if (typeof value !== 'string' || !HASH.test(value)) throw new TypeError('Invalid hash.'); return lower(value); };
const address = value => { if (typeof value !== 'string' || !ADDRESS.test(value)) throw new TypeError('Invalid address.'); return lower(value); };
function quantity(value) {
  if (typeof value === 'number') { if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Invalid quantity.'); return String(value); }
  if (typeof value !== 'string' || value.length > 80 || !/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value) || BigInt(value) >= 1n << 256n) throw new TypeError('Invalid quantity.');
  return BigInt(value).toString();
}
function jsonCopy(input) {
  let nodes = 0, bytes = 0;
  const ancestors = new Set();
  function copy(value, depth) {
    if (++nodes > BLOCK_VIEW_LIMITS.maxJsonNodes || depth > 32) throw new RangeError('Block-view input exceeds its structural limit; no partial normalization was produced.');
    if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      bytes += Buffer.byteLength(value);
      if (bytes > BLOCK_VIEW_LIMITS.maxInputStringBytes) throw new RangeError('Block-view input exceeds its byte limit; no partial normalization was produced.');
      return value;
    }
    if (!object(value) && !Array.isArray(value) || ancestors.has(value)) throw new TypeError('Block-view input must be acyclic JSON data.');
    if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError('Block-view input contains a non-JSON record.');
    ancestors.add(value);
    const keys = Reflect.ownKeys(value).filter(key => !(Array.isArray(value) && key === 'length'));
    if (Array.isArray(value) && (value.length > BLOCK_VIEW_LIMITS.maxJsonNodes || keys.length !== value.length || keys.some((key, index) => key !== String(index)))) throw new TypeError('Sparse or decorated arrays are not JSON lists.');
    for (const key of keys) {
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || !property.enumerable || !Object.hasOwn(property, 'value')) throw new TypeError('Block-view input contains unsupported properties.');
      bytes += Buffer.byteLength(key);
      if (bytes > BLOCK_VIEW_LIMITS.maxInputStringBytes) throw new RangeError('Block-view input exceeds its byte limit; no partial normalization was produced.');
    }
    const result = Array.isArray(value) ? value.map(item => copy(item, depth + 1)) : Object.fromEntries(keys.map(key => [key, copy(value[key], depth + 1)]));
    ancestors.delete(value); return result;
  }
  return copy(input, 0);
}
function packetAvailable(packet) {
  const p = packet?.provenance, request = packet?.request;
  return packet?.status === 'available' && Object.hasOwn(packet, 'result') && object(p) && ['endpoint', 'artifact', 'observedAt'].every(key => typeof p[key] === 'string' && p[key].length > 0) &&
    Number.isFinite(Date.parse(p.observedAt)) && ['captureSha256', 'responseSha256'].every(key => typeof p[key] === 'string' && SHA.test(p[key])) && object(request) && Number.isSafeInteger(request.id) && request.id >= 1 && typeof request.method === 'string' && Array.isArray(request.params);
}
function boundRequest(packet, target, system = false) {
  if (!packetAvailable(packet)) return false;
  const { method, params } = packet.request;
  const byHash = system ? 'eth_getSystemTxsByBlockHash' : 'eth_getBlockByHash';
  const byNumber = system ? 'eth_getSystemTxsByBlockNumber' : 'eth_getBlockByNumber';
  if (params.length !== (system ? 1 : 2) || !system && typeof params[1] !== 'boolean') return false;
  try { return method === byHash ? hash(params[0]) === target.hash : method === byNumber && quantity(params[0]) === target.number; }
  catch { return false; }
}
function headerIdentity(packet, target) {
  try {
    const block = packet.result;
    if (!boundRequest(packet, target) || !object(block) || hash(block.hash) !== target.hash || quantity(block.number) !== target.number || !Array.isArray(block.transactions)) return null;
    hash(block.parentHash); quantity(block.timestamp);
    return Object.fromEntries(Object.entries(block).filter(([key]) => !['transactions', 'size'].includes(key)).map(([key, value]) => [key, typeof value === 'string' ? lower(value) : value]));
  } catch { return null; }
}
function envelope(raw, target) {
  if (!object(raw)) throw new TypeError('Full transaction envelope is unavailable.');
  const type = quantity(raw.type), typed = type === '1' || type === '2';
  if (!['0', '1', '2'].includes(type)) throw new TypeError('Unrecognized transaction semantics.');
  const required = [...BASE_FIELDS, ...(typed ? ['accessList'] : []), ...(type === '2' ? ['maxFeePerGas', 'maxPriorityFeePerGas'] : [])];
  if (required.some(key => !Object.hasOwn(raw, key)) || Object.keys(raw).some(key => !required.includes(key) && !(typed && key === 'yParity'))) throw new TypeError('Missing or unfamiliar envelope fields.');
  const out = {};
  for (const key of Object.keys(raw).sort()) {
    const value = raw[key];
    if (['hash', 'blockHash'].includes(key)) out[key] = hash(value);
    else if (key === 'from' || key === 'to') out[key] = key === 'to' && value === null ? null : address(value);
    else if (key === 'input') {
      if (typeof value !== 'string' || value.length > BLOCK_VIEW_LIMITS.maxCalldataBytes * 2 + 2 || !HEX.test(value)) throw new TypeError('Malformed or excessive calldata.');
      out[key] = lower(value);
    } else if (key === 'accessList') {
      if (!Array.isArray(value) || value.length > 1024) throw new TypeError('Malformed or excessive access list.');
      out[key] = value.map(entry => {
        if (!object(entry) || Object.keys(entry).sort().join() !== 'address,storageKeys' || !Array.isArray(entry.storageKeys) || entry.storageKeys.length > 4096) throw new TypeError('Malformed access-list entry.');
        return { address: address(entry.address), storageKeys: entry.storageKeys.map(hash) };
      });
    } else out[key] = quantity(value);
  }
  if (out.chainId !== target.chainId || out.blockHash !== target.hash || out.blockNumber !== target.number || Object.hasOwn(out, 'yParity') && !['0', '1'].includes(out.yParity)) throw new TypeError('Envelope is not bound to the selected chain/block.');
  return out;
}
function systemCore(tx) { return Object.fromEntries(SYSTEM_IDENTITY_FIELDS.map(key => [key, tx[key]])); }
function diagnosedAlias(reference, candidate) {
  return Object.keys(reference).length === 16 && Object.keys(candidate).length === 16 && reference.type === '0' && candidate.type === '0' && reference.hash !== candidate.hash &&
    reference.r === '0' && reference.s === '0' && reference.v === '2033' && candidate.r === '1' && candidate.s === BigInt(candidate.from).toString() && candidate.v === '2034' && isDeepStrictEqual(systemCore(reference), systemCore(candidate));
}

/**
 * normalizeBlockViews({ block:{chainId,number,hash},
 *   providers:[{id:'A'|'B', block:packet, transactions:[packet]}],
 *   official:{ordinary:packet, system:packet} })
 * packet={status:'available'|'unavailable',request:{id,method,params},result?,
 *   provenance:{endpoint,artifact,captureSha256,responseSha256,observedAt}}
 * Provenance is retained, not cryptographically attested by this pure function.
 */
export function normalizeBlockViews(input) {
  const sources = jsonCopy(input);
  if (!object(sources) || !object(sources.block) || !Array.isArray(sources.providers) || sources.providers.length !== 2 || !isDeepStrictEqual(sources.providers.map(provider => provider.id).sort(), ['A', 'B']) || !object(sources.official)) throw new TypeError('Explicit A/B and official views are required.');
  const target = { chainId: quantity(sources.block.chainId), number: quantity(sources.block.number), hash: hash(sources.block.hash) };
  if (target.chainId !== '999') throw new TypeError('Only the diagnosed HyperEVM chain is in this normalizer scope.');
  for (const provider of sources.providers) if (!Array.isArray(provider.transactions) || provider.transactions.length > BLOCK_VIEW_LIMITS.maxLookupsPerProvider) throw new RangeError('Provider lookup bound exceeded; no entries were trimmed.');
  for (const list of [sources.official.ordinary?.result?.transactions, sources.official.system?.result, ...sources.providers.map(provider => provider.block?.result?.transactions)]) if (Array.isArray(list) && list.length > BLOCK_VIEW_LIMITS.maxListEntries) throw new RangeError('Block-list bound exceeded; no entries were trimmed.');
  const issues = [], occurrences = [], referenceActions = [], parsed = new Map(), sourceHeaders = new Map();
  const issue = (code, sourceId, severity = 'partial', ids = []) => issues.push({ code, sourceId, severity, occurrenceIds: ids });
  function occurrence(sourceId, provider, role, ordinal, raw, provenance) {
    const id = `${sourceId}:${ordinal}`, rawHash = typeof raw === 'string' ? raw : raw?.hash;
    const result = { id, sourceId, provider, role, listOrdinal: role === 'lookup' ? null : ordinal, hash: typeof rawHash === 'string' && HASH.test(rawHash) ? lower(rawHash) : null,
      reportedTransactionIndex: null, replayBoundary: 'unknown', raw, provenance, mapping: { status: 'unresolved', candidates: [] } };
    try { if (object(raw) && Object.hasOwn(raw, 'transactionIndex')) result.reportedTransactionIndex = quantity(raw.transactionIndex); } catch {}
    occurrences.push(result); return result;
  }
  function parse(occ, value) {
    try { const tx = envelope(value, target); parsed.set(occ.id, tx); occ.reportedTransactionIndex = tx.transactionIndex; return tx; }
    catch { return null; }
  }
  const ordinaryHeader = headerIdentity(sources.official.ordinary, target);
  const ordinaryAvailable = Boolean(ordinaryHeader), systemAvailable = boundRequest(sources.official.system, target, true) && Array.isArray(sources.official.system.result) &&
    (sources.official.system.result.length > 0 || sources.official.system.request.method === 'eth_getSystemTxsByBlockHash');
  if (!ordinaryAvailable) issue('official_ordinary_enumeration_unavailable', 'official:ordinary');
  else sourceHeaders.set('official:ordinary', ordinaryHeader);
  if (!systemAvailable) issue('official_system_enumeration_unavailable', 'official:system');
  for (const [kind, packet, list, available] of [
    ['ordinary', sources.official.ordinary, sources.official.ordinary?.result?.transactions, ordinaryAvailable],
    ['hypercore_system', sources.official.system, sources.official.system?.result, systemAvailable],
  ]) for (const [ordinal, raw] of (Array.isArray(list) ? list : []).entries()) {
    const sourceId = kind === 'ordinary' ? 'official:ordinary' : 'official:system';
    const occ = occurrence(sourceId, 'official', 'reference', ordinal, raw, packet?.provenance ?? null);
    const tx = typeof raw === 'string' ? null : parse(occ, raw);
    const valid = available && occ.hash !== null && (kind === 'ordinary' && typeof raw === 'string' || tx !== null);
    const id = `${target.hash}:${kind}:${occ.hash ?? 'invalid'}:${ordinal}`;
    const action = { id, kind, referenceOrdinal: ordinal, referenceHash: occ.hash, referenceEnvelope: typeof raw === 'string' ? null : raw, referenceOccurrenceId: occ.id,
      referenceStatus: valid ? 'valid' : 'unresolved', representations: [occ.id], mappingEvidence: [], executionOrder: 'unknown', replayBoundary: 'unknown', execution: 'not_assessed' };
    referenceActions.push(action);
    occ.mapping = { status: valid ? 'reference' : 'unresolved', candidates: [id] };
    if (!valid) issue('reference_identity_unavailable', sourceId, 'partial', [occ.id]);
  }
  const views = [];
  for (const provider of sources.providers) {
    const sourceId = `provider:${provider.id}:block`, header = headerIdentity(provider.block, target), list = provider.block?.result?.transactions;
    if (header) sourceHeaders.set(sourceId, header); else issue('provider_block_unavailable_or_unbound', sourceId);
    const view = { provider: provider.id, sourceId, classification: 'unresolved', provenance: provider.block?.provenance ?? null, occurrenceIds: [], ordinaryReferenceOrder: [], systemReferenceOrder: [] };
    views.push(view);
    for (const [ordinal, raw] of (Array.isArray(list) ? list : []).entries()) {
      const occ = occurrence(sourceId, provider.id, 'list', ordinal, raw, provider.block?.provenance ?? null);
      view.occurrenceIds.push(occ.id);
      if (typeof raw !== 'string' && !parse(occ, raw)) occ.unbound = true;
      if (!header) occ.unbound = true;
    }
    for (const [ordinal, packet] of provider.transactions.entries()) {
      const occ = occurrence(`provider:${provider.id}:lookup`, provider.id, 'lookup', ordinal, packet?.result ?? null, packet?.provenance ?? null);
      occ.request = packet?.request ?? null;
      try {
        if (!packetAvailable(packet) || packet.request.method !== 'eth_getTransactionByHash' || packet.request.params.length !== 1 || hash(packet.request.params[0]) !== hash(packet.result?.hash)) throw new TypeError();
        parse(occ, packet.result);
      } catch { occ.unbound = true; }
      if (occ.unbound || !parsed.has(occ.id)) issue('lookup_unavailable_or_unbound', occ.sourceId, 'partial', [occ.id]);
    }
  }
  for (const [sourceId, header] of sourceHeaders) if (ordinaryHeader && !isDeepStrictEqual(header, ordinaryHeader)) issue('conflicting_header_fields', sourceId, 'conflicting');
  const referenceHashes = new Map(), hashes = new Map();
  for (const occ of occurrences) {
    if (!occ.hash) continue;
    if (!hashes.has(occ.hash)) hashes.set(occ.hash, []); hashes.get(occ.hash).push(occ);
  }
  for (const action of referenceActions) if (action.referenceHash) {
    if (!referenceHashes.has(action.referenceHash)) referenceHashes.set(action.referenceHash, []);
    referenceHashes.get(action.referenceHash).push(action);
  }
  for (const refs of referenceHashes.values()) if (refs.length > 1) issue('duplicate_or_overlapping_reference_hash', 'official', 'conflicting', refs.map(ref => ref.referenceOccurrenceId));
  const systems = referenceActions.filter(action => action.kind === 'hypercore_system' && action.referenceStatus === 'valid'), systemFields = new Map();
  for (const action of systems) {
    const key = JSON.stringify(systemCore(parsed.get(action.referenceOccurrenceId)));
    if (!systemFields.has(key)) systemFields.set(key, []); systemFields.get(key).push(action);
  }
  for (const matches of systemFields.values()) if (matches.length > 1) issue('ambiguous_system_action_fields', 'official:system', 'conflicting', matches.map(action => action.referenceOccurrenceId));
  const conflictingHashes = new Set();
  for (const [key, entries] of hashes) {
    const envelopes = entries.filter(occ => parsed.has(occ.id));
    if (envelopes.some(occ => !isDeepStrictEqual(parsed.get(occ.id), parsed.get(envelopes[0].id)))) {
      conflictingHashes.add(key); issue('conflicting_same_hash_envelopes', 'all', 'conflicting', entries.map(occ => occ.id));
    }
    for (const provider of ['A', 'B']) for (const role of ['list', 'lookup']) {
      const duplicates = entries.filter(occ => occ.provider === provider && occ.role === role);
      if (duplicates.length > 1) issue('duplicate_provider_occurrence', provider, 'conflicting', duplicates.map(occ => occ.id));
    }
  }
  for (const occ of occurrences.filter(occ => occ.provider !== 'official')) {
    let tx = parsed.get(occ.id);
    if (!tx && occ.role === 'list' && occ.hash) {
      const lookups = (hashes.get(occ.hash) ?? []).filter(other => other.provider === occ.provider && other.role === 'lookup' && !other.unbound && parsed.has(other.id));
      if (lookups.length === 1) { tx = parsed.get(lookups[0].id); occ.envelopeOccurrenceId = lookups[0].id; occ.reportedTransactionIndex = tx.transactionIndex; }
    }
    if (occ.unbound || !tx || conflictingHashes.has(occ.hash)) {
      occ.mapping.reason = conflictingHashes.has(occ.hash) ? 'conflicting_same_hash_envelopes' : 'required_bound_envelope_unavailable';
      continue;
    }
    const exact = (referenceHashes.get(occ.hash) ?? []).filter(action => action.referenceStatus === 'valid' && (action.kind === 'ordinary' || isDeepStrictEqual(parsed.get(action.referenceOccurrenceId), tx)));
    const aliases = (systemFields.get(JSON.stringify(systemCore(tx))) ?? []).filter(action => diagnosedAlias(parsed.get(action.referenceOccurrenceId), tx));
    const candidates = [...new Map([...exact, ...aliases].map(action => [action.id, action])).values()];
    occ.mapping.candidates = candidates.map(action => action.id);
    if (candidates.length !== 1) { occ.mapping.reason = candidates.length ? 'ambiguous_reference_correspondence' : 'no_permitted_reference_correspondence'; continue; }
    const action = candidates[0], alias = aliases.includes(action);
    occ.mapping = { status: 'matched', candidates: [action.id], referenceId: action.id, basis: alias ? 'diagnosed_system_12_field_correspondence' : action.kind === 'ordinary' ? 'exact_reference_hash_and_consistent_observed_full_envelope' : 'exact_system_envelope' };
    action.representations.push(occ.id);
    action.mappingEvidence.push({ occurrenceId: occ.id, basis: occ.mapping.basis, matchedFields: alias ? [...SYSTEM_IDENTITY_FIELDS] : Object.keys(tx),
      representationDifferences: alias ? Object.fromEntries(REPRESENTATION_FIELDS.map(field => [field, { reference: parsed.get(action.referenceOccurrenceId)[field], observed: tx[field] }])) : {}, cryptographicEquivalence: 'not_assessed' });
  }
  const expectedOrdinary = referenceActions.filter(action => action.kind === 'ordinary').map(action => action.id), expectedSystem = referenceActions.filter(action => action.kind === 'hypercore_system').map(action => action.id);
  const occurrenceById = new Map(occurrences.map(occ => [occ.id, occ])), referenceById = new Map(referenceActions.map(action => [action.id, action]));
  for (const view of views) {
    const entries = view.occurrenceIds.map(id => occurrenceById.get(id));
    for (const occ of entries) {
      const action = referenceById.get(occ.mapping.referenceId);
      if (action) (action.kind === 'ordinary' ? view.ordinaryReferenceOrder : view.systemReferenceOrder).push(action.id);
    }
    if (entries.some(occ => occ.mapping.status !== 'matched') || !sourceHeaders.has(view.sourceId)) continue;
    if (!isDeepStrictEqual(view.ordinaryReferenceOrder, expectedOrdinary)) issue('ordinary_list_missing_duplicated_or_reordered', view.sourceId, 'conflicting', view.occurrenceIds);
    else if (!view.systemReferenceOrder.length) view.classification = 'ordinary_only';
    else if (isDeepStrictEqual(view.systemReferenceOrder, expectedSystem)) view.classification = 'system_inclusive';
    else issue('system_list_missing_duplicated_or_reordered', view.sourceId, 'conflicting', view.occurrenceIds);
  }
  const unresolvedOccurrences = occurrences.filter(occ => !['reference', 'matched'].includes(occ.mapping.status));
  const conflicting = issues.some(entry => entry.severity === 'conflicting');
  const complete = !conflicting && issues.length === 0 && unresolvedOccurrences.length === 0 && views.every(view => view.classification !== 'unresolved');
  const enumeration = !ordinaryAvailable || !systemAvailable ? 'unavailable' : issues.some(entry => entry.sourceId.startsWith('official') && entry.severity === 'conflicting') ? 'conflicting' : 'complete';
  return { schemaVersion: '1.0', rulesVersion: 'hypercore-observed-views-1', block: target, sources, views, referenceActions, occurrences,
    unresolvedOccurrences: unresolvedOccurrences.map(occ => occ.id), issues,
    enumeration: { status: enumeration, ordinaryReferences: expectedOrdinary.length, systemReferences: expectedSystem.length, scope: 'RPC-enumerated references; completeness of all chain activity is not independently proven.' },
    identityMapping: { status: conflicting ? 'conflicting' : complete ? 'complete' : 'partial', provenanceValidation: 'caller_supplied_not_cryptographically_attested' },
    denominator: { completeness: complete ? 'complete_for_enumerated_references' : 'inconclusive', N_enumerated: complete ? referenceActions.length : null, knownReferenceRows: referenceActions.length, unresolvedOccurrences: unresolvedOccurrences.length, distinctObservedHashes: hashes.size, fraction: null },
    limitations: ['Representation correspondence does not prove execution order, replay boundary, receipt/trace availability, state equivalence, authorization or cryptographic hash equivalence.', 'Reported transactionIndex and list ordinal remain separate observations; every replay boundary is unknown.', 'Each response is classified independently. Different captures may expose different views for the same provider and block hash.', 'Unknown system targets and unsupported execution remain reference rows; no ordinary-only denominator replaces all enumerated EVM actions.', 'Unknown or incomplete ordinary envelopes remain unresolved; supported envelope validation does not establish broad transaction-type coverage.', 'An empty system list requires a block-hash request because no returned envelope can bind a number-only empty response to the selected hash.', 'Finality, parent continuity, authenticated provenance, query/execution validation, budgets and output sealing remain required outside this pure normalizer.'] };
}
