// Convert only pre-execution observations into sparse local inputs. Provider
// call traces and post-state diffs are deliberately absent from this interface.
const ADDRESS = /^0x[0-9a-f]{40}$/i, WORD = /^0x[0-9a-f]{64}$/i, BYTES = /^0x(?:[0-9a-f]{2})*$/i;
const METHODS = { nonce: 'eth_getTransactionCount', balance: 'eth_getBalance', code: 'eth_getCode' };
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
function requireInput(condition, message) { if (!condition) throw Object.assign(new Error(message), { code: 'LOCAL_INPUT_PACKET_INVALID' }); }
function quantity(value, bits = 256) {
  requireInput((typeof value === 'string' && value.length <= 80 && /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value)) || (Number.isSafeInteger(value) && value >= 0), 'Malformed unsigned input quantity.');
  const result = BigInt(value); requireInput(result < 1n << BigInt(bits), 'Input quantity exceeds its supported width.'); return result;
}
const normalizedAddress = value => { requireInput(typeof value === 'string' && ADDRESS.test(value), 'Malformed input address.'); return value.toLowerCase(); };
const normalizedWord = value => { requireInput(typeof value === 'string' && WORD.test(value), 'Malformed input word.'); return value.toLowerCase(); };

export function intrinsicCallGas(data) {
  requireInput(typeof data === 'string' && BYTES.test(data) && data.length <= 65538, 'Bounded calldata is required.');
  let gas = 21000n;
  for (let i = 2; i < data.length; i += 2) gas += data.slice(i, i + 2) === '00' ? 4n : 16n;
  return gas;
}

/** Completion entries are {field,address,request:{method,params},result} from
 * independent same-hash basic-state reads. Transport/hash verification belongs
 * to the packet verifier; this conversion does not claim cryptographic proof. */
export function buildPrestateInputs({ prestate, completionReads, envelope, header, pinned, prestateRequest }) {
  requireInput(object(pinned) && pinned.requireCanonical === true && Object.keys(pinned).sort().join() === 'blockHash,requireCanonical', 'An explicit canonical block-hash selector is required.');
  const blockHash = normalizedWord(pinned.blockHash);
  requireInput(object(header) && normalizedWord(header.hash) === blockHash, 'Header does not match the selected state hash.');
  for (const field of ['number', 'timestamp', 'gasLimit', 'baseFeePerGas']) quantity(header[field]);
  normalizedWord(header.parentHash); normalizedWord(header.mixHash); normalizedAddress(header.miner);
  requireInput(object(envelope) && Object.keys(envelope).sort().join() === 'data,from,gas,to,value', 'Only the declared unsigned, unpriced call envelope is accepted.');
  const from = normalizedAddress(envelope.from), to = normalizedAddress(envelope.to), intrinsic = intrinsicCallGas(envelope.data), gas = quantity(envelope.gas);
  requireInput(quantity(envelope.value) === 0n && gas > intrinsic && gas <= 5000000n, 'The captured profile requires zero value and sufficient bounded gas.');
  requireInput(prestateRequest?.method === 'debug_traceCall' && Array.isArray(prestateRequest.params) && prestateRequest.params.length === 3, 'Full prestate request provenance is required.');
  const [call, selector, options] = prestateRequest.params;
  requireInput(JSON.stringify(call) === JSON.stringify(envelope) && JSON.stringify(selector) === JSON.stringify(pinned), 'Prestate envelope and state binding must match exactly.');
  requireInput(object(options) && Object.keys(options).sort().join() === 'timeout,tracer,tracerConfig' && options.timeout === '15s' && options.tracer === 'prestateTracer' && object(options.tracerConfig) && Object.keys(options.tracerConfig).sort().join() === 'diffMode,disableCode,disableStorage,includeEmpty' && options.tracerConfig.diffMode === false && options.tracerConfig.disableCode === false && options.tracerConfig.disableStorage === false && options.tracerConfig.includeEmpty === true, 'Only full, non-overridden pre-execution state is admitted.');
  requireInput(object(prestate) && Object.keys(prestate).length > 0 && Object.keys(prestate).length <= 32 && Array.isArray(completionReads) && completionReads.length <= 96, 'Bounded sparse input observations are required.');
  const inputs = new Map(), used = new Set(), accounts = {}, unresolvedAccounts = [], codeHashClaims = [];
  for (const [key, record] of Object.entries(prestate)) {
    const address = normalizedAddress(key);
    requireInput(!inputs.has(address) && object(record) && Object.keys(record).every(k => ['nonce','balance','code','storage','codeHash'].includes(k)), 'Malformed, duplicate or unfamiliar prestate account.');
    inputs.set(address, record);
  }
  const completions = new Map();
  for (const read of completionReads) {
    const address = normalizedAddress(read.address), record = inputs.get(address), field = read.field;
    requireInput(record && Object.hasOwn(METHODS, field) && !Object.hasOwn(record, field), 'Completion must fill only an omitted basic field of an observed account.');
    const key = address + ':' + field;
    requireInput(!completions.has(key) && read.request?.method === METHODS[field] && JSON.stringify(read.request.params) === JSON.stringify([address, pinned]) && Object.hasOwn(read, 'result'), 'Completion is duplicated, unavailable or bound to another state.');
    completions.set(key, read.result);
  }
  for (const [address, record] of inputs) {
    const values = {};
    for (const field of Object.keys(METHODS)) {
      const key = address + ':' + field;
      requireInput(Object.hasOwn(record, field) || completions.has(key), 'An omitted account field has no observed completion.');
      values[field] = Object.hasOwn(record, field) ? record[field] : completions.get(key);
      if (completions.has(key)) used.add(key);
    }
    const nonce = quantity(values.nonce, 64), balance = quantity(values.balance);
    requireInput(typeof values.code === 'string' && BYTES.test(values.code) && values.code.length <= 524290, 'Runtime code is missing or malformed.');
    const code = values.code.toLowerCase(), storage = {};
    requireInput(record.storage === undefined || object(record.storage), 'Malformed sparse storage.');
    for (const [slot, value] of Object.entries(record.storage ?? {})) {
      const key = normalizedWord(slot); requireInput(!Object.hasOwn(storage, key), 'Duplicate storage word.'); storage[key] = normalizedWord(value);
    }
    if (record.codeHash !== undefined) codeHashClaims.push({ address, codeHash: normalizedWord(record.codeHash) });
    // Nonzero input facts establish a nonempty account. All-zero observations
    // do not identify absence versus empty account existence, so keep unknown.
    if (nonce === 0n && balance === 0n && code === '0x' && Object.values(storage).every(value => BigInt(value) === 0n)) {
      unresolvedAccounts.push({ address, reason: 'empty_account_existence_unproven', observed: { nonce: '0', balance: '0', code, storage } });
      continue;
    }
    accounts[address] = { exists: true, nonce: nonce.toString(), balance: balance.toString(), code, storage };
  }
  requireInput(used.size === completionReads.length, 'Every completion must have an explicit input-field use.');
  return {
    accounts, unresolvedAccounts, codeHashClaims,
    request: { from, to, data: envelope.data.toLowerCase(), value: '0', gasLimit: (gas - intrinsic).toString() },
    block: { ...Object.fromEntries(['number','timestamp','gasLimit','mixHash','miner','parentHash','hash'].map(key => [key, header[key]])), baseFeePerGas: '0' },
    profile: { name: 'captured_unsigned_zero_value_unpriced_call', sourceBlockHash: blockHash, actualBlockBaseFee: quantity(header.baseFeePerGas).toString(), executionBaseFee: '0', sourceGasLimit: gas.toString(), intrinsicGas: intrinsic.toString(), messageGasLimit: (gas - intrinsic).toString(), intrinsicRule: 'Cancun_call_21000_plus_4_per_zero_and_16_per_nonzero_calldata_byte_no_access_list', stateProof: 'not_verified', sourceBinding: 'requires_external_packet_verification', expectedOutputsUsed: false },
  };
}
