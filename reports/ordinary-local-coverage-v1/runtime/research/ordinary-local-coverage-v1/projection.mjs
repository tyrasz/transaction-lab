// Projection is fixed before dispatch and independent of any execution outcome.
import { isDeepStrictEqual as equal } from 'node:util';
import { normalizeEvmContext } from '../../engines/evm-context.js';
import { verifyEthereumHeader } from '../../engines/local-evm/ethereum-header.js';
import { encode, decode } from '../../engines/local-evm/isolated-protocol.js';

export const PROJECTION_POLICY = Object.freeze({ gas: '5000000', calldataBytes: 32768, originalGasCeiling: '5000000', supportedTypes: ['0', '1', '2', '3'] });
const ADDRESS = /^0x[0-9a-f]{40}$/, WORD = /^0x[0-9a-f]{64}$/, DATA = /^0x(?:[0-9a-f]{2})*$/, DECIMAL = /^(0|[1-9][0-9]*)$/;
const need = (v, message) => { if (!v) throw new Error(message); };
export function projectSelectedCase({ row, census }) {
  // Refuse accidental substitution of a row/header independently of projection.
  const selected = census?.selected?.find(r => r.transactionHash === row?.transactionHash);
  need(selected && equal(selected, row) && row.selected === true, 'Selected case is not in the validated census.');
  const found = census.envelopes?.filter(r => r.transactionHash === row.transactionHash);
  need(found?.length === 1, 'Selected envelope is missing or ambiguous.');
  for (const k of ['transactionHash', 'blockHash', 'blockNumber', 'transactionIndex']) need(found[0][k] === row[k], 'Selected envelope identity differs.');
  const e = decode(encode(found[0].normalizedEnvelope, 2 * 1024 * 1024), 2 * 1024 * 1024);
  const header = decode(encode(row.parentHeader, 8 * 1024 * 1024), 8 * 1024 * 1024);
  const verified = verifyEthereumHeader({ header, expectedHash: row.parentBlockHash });
  need(BigInt(verified.number) + 1n === BigInt(row.blockNumber) && WORD.test(row.transactionHash), 'Parent header/transaction identity differs.');
  need(ADDRESS.test(e.from) && (e.to === null || ADDRESS.test(e.to)) && DATA.test(e.input) && typeof e.value === 'string' && DECIMAL.test(e.value) && BigInt(e.value) < 1n << 256n && typeof e.gas === 'string' && DECIMAL.test(e.gas) && BigInt(e.gas) > 0n, 'Validated envelope projection is malformed.');
  const reasons = [];
  if (!PROJECTION_POLICY.supportedTypes.includes(e.type)) reasons.push(e.type === '4' ? 'authorization_context_unsupported' : 'unknown_transaction_type');
  need(e.extensions && Object.getPrototypeOf(e.extensions) === Object.prototype, 'Envelope extension inventory missing.');
  if (Object.keys(e.extensions).length) reasons.push('unrecognized_envelope_fields');
  if (BigInt(e.gas) > 5000000n) reasons.push('original_gas_limit_exceeds_profile');
  if ((e.input.length - 2) / 2 > PROJECTION_POLICY.calldataBytes) reasons.push('calldata_exceeds_profile');
  let context = {};
  try { context = normalizeEvmContext({ ...(Object.hasOwn(e, 'accessList') ? { accessList: e.accessList } : {}), ...(Object.hasOwn(e, 'blobVersionedHashes') ? { blobVersionedHashes: e.blobVersionedHashes } : {}) }); }
  catch { reasons.push('transaction_context_exceeds_profile'); }
  if (e.to === null && Object.hasOwn(e, 'blobVersionedHashes')) reasons.push('blob_creation_unsupported');
  return { status: reasons.length ? 'unsupported' : 'projectable', reasons, transactionHash: row.transactionHash, parentHeader: header,
    ...(reasons.length ? {} : { request: { from: e.from, to: e.to, data: e.input, value: e.value, gas: '5000000', ...context } }),
    originalGasLimit: e.gas, simulationGas: '5000000', profile: 'local_kernel_unsigned_unpriced_parent_block_end',
    originalTransactionReplay: false, signatureVerified: false, feeSettlement: false,
    omittedOuterFields: ['nonce', 'gas', 'signature', 'gasPrice', 'maxFeePerGas', 'maxPriorityFeePerGas', 'maxFeePerBlobGas', 'blob_sidecar', 'authorizationList'],
  };
}
