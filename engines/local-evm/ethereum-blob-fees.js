import { types } from 'node:util';
import { ethereumNetworkCommon } from './ethereum-network.js';

export const BLOB_FEE_LIMITS = Object.freeze({ iterations: 1024, gasPerBlob: 131072n });
const MAX = (1n << 256n) - 1n;
// The table is deliberately finite. BPO block limits do not replace Osaka's
// separate six-blob transaction limit. Both supported header schedules use
// these parameters. The pinned Geth Sepolia chainspec (SHA a5917e23…5807)
// leaves Amsterdam on BPO2; config.go:593-595 forbids a named-fork override.
const PARAMETERS = Object.freeze({
  cancun: [3n, 6n, 6n, 3338477n],
  prague: [6n, 9n, 9n, 5007716n],
  osaka: [6n, 9n, 6n, 5007716n],
  bpo1: [10n, 15n, 6n, 8346193n],
  bpo2: [14n, 21n, 6n, 11684671n],
  amsterdam: [14n, 21n, 6n, 11684671n],
});
function fail(code = 'LOCAL_ETHEREUM_INPUT_INVALID') {
  throw Object.assign(new Error(code === 'LOCAL_ETHEREUM_BLOB_PRICE_LIMIT'
    ? 'Blob base fee exceeds the bounded exact calculation profile.'
    : 'The fork-selected blob fee context is malformed or unsupported.'), { code });
}
function quantity(header, key) {
  const d = Object.getOwnPropertyDescriptor(header, key), value = d?.value;
  if (!d?.enumerable || !Object.hasOwn(d, 'value') || typeof value !== 'string' || value.length > 22
    || !/^(?:0x(?:0|[1-9a-f][0-9a-f]*)|0|[1-9][0-9]*)$/i.test(value)) fail();
  const n = BigInt(value); if (n >= 1n << 64n) fail(); return n;
}

/** Exact EIP-4844 integer series, with no floating point or approximation.
 * A partial sum already above uint256 proves the final positive sum is too
 * large. Checking before each multiplication bounds intermediates to344bits.
 * An exhausted work bound never returns a truncated price. */
function blobPrice(excess, denominator) {
  let accumulator = denominator, sum = 0n;
  const saturation = (MAX + 1n) * denominator;
  for (let i = 1n; i <= BigInt(BLOB_FEE_LIMITS.iterations); i++) {
    sum += accumulator;
    if (sum >= saturation) fail('LOCAL_ETHEREUM_BLOB_PRICE_LIMIT');
    accumulator = accumulator * excess / (denominator * i);
    if (accumulator === 0n) return sum / denominator;
  }
  fail('LOCAL_ETHEREUM_BLOB_PRICE_LIMIT');
}

/** Derive only from fields committed in the selected current header. This
 * does not validate consensus, a parent excess transition, or body totals.
 * EIP-7918 changes the parent->child excess transition, not this price formula.
 * The caller verifies the header hash independently before exposing results. */
export function ethereumBlobContext(header, chainId = 1) {
  if (chainId !== 1 && chainId !== 11155111) fail('LOCAL_ETHEREUM_CHAIN_UNSUPPORTED');
  if (header === null || typeof header !== 'object' || types.isProxy(header) || Array.isArray(header)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(header))) fail();
  quantity(header, 'number'); quantity(header, 'timestamp');
  // Only the trusted argument selects the network; request/header claims do
  // not. Header support here does not admit that fork to public execution.
  const hardfork = ethereumNetworkCommon(header, chainId).hardfork();
  if (hardfork === 'shanghai') return null;
  if (!Object.hasOwn(PARAMETERS, hardfork)) fail('LOCAL_ETHEREUM_FORK_UNSUPPORTED');
  const [targetBlobsPerBlock, maxBlobsPerBlock, maxBlobsPerTransaction, baseFeeUpdateFraction] = PARAMETERS[hardfork];
  const excessBlobGas = quantity(header, 'excessBlobGas'), used = quantity(header, 'blobGasUsed');
  if (used % BLOB_FEE_LIMITS.gasPerBlob !== 0n || used > maxBlobsPerBlock * BLOB_FEE_LIMITS.gasPerBlob) fail();
  return Object.freeze({ hardfork, excessBlobGas, blobBaseFeePerGas: blobPrice(excessBlobGas, baseFeeUpdateFraction),
    gasPerBlob: BLOB_FEE_LIMITS.gasPerBlob, targetBlobsPerBlock, maxBlobsPerBlock, maxBlobsPerTransaction, baseFeeUpdateFraction });
}
