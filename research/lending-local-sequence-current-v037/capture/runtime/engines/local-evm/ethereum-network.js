import { types } from 'node:util';
import { Common, Mainnet, Sepolia } from '@ethereumjs/common';

// Only chain/fork selection lives here. Availability of a fork in Common is
// not admission to the transaction execution profile.
export const ETHEREUM_NETWORK_SCHEDULES = Object.freeze({
  1: 'pinned_ethereumjs_common_10.1.3_mainnet',
  11155111: 'pinned_ethereumjs_common_10.1.3_sepolia_amsterdam_1791294816',
});
export const SEPOLIA_AMSTERDAM = Object.freeze({
  timestamp: '1791294816',
  repository: 'https://github.com/ethereum/go-ethereum',
  commit: '1df30b18d9ed35ee9d28ffd4648442c2204554ad',
  path: 'params/chainspecs/sepolia.json',
  sha256: 'a5917e237e111dc392018ca6a2221ae67fd31b2745a1f55137a3586543705807',
});
const SUPPORTED = new Set(['shanghai', 'cancun', 'prague', 'osaka', 'bpo1', 'bpo2', 'amsterdam']);
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
function quantity(header, key) {
  const descriptor = Object.getOwnPropertyDescriptor(header, key), value = descriptor?.value;
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || typeof value !== 'string'
    || value.length > 80 || !/^(?:0x(?:0|[1-9a-f][0-9a-f]*)|0|[1-9][0-9]*)$/i.test(value)
    || BigInt(value) >= 1n << 64n) fail('LOCAL_ETHEREUM_INPUT_INVALID', 'Fork selection requires canonical uint64 block number and timestamp.');
  return BigInt(value);
}

/** A fresh, independently selected Common. The chain must come from admitted
 * parent input, not from an RPC header or child claim. This does not establish
 * consensus, finality or network membership of a header. */
export function ethereumNetworkCommon(header, chainId = 1) {
  if (chainId !== 1 && chainId !== 11155111) fail('LOCAL_ETHEREUM_CHAIN_UNSUPPORTED', 'The local Ethereum network must be chain 1 or Sepolia chain 11155111.');
  if (!header || typeof header !== 'object' || types.isProxy(header) || Array.isArray(header)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(header))) fail('LOCAL_ETHEREUM_INPUT_INVALID', 'A plain header is required for fork selection.');
  const blockNumber = quantity(header, 'number'), timestamp = quantity(header, 'timestamp');
  const chain = structuredClone(chainId === 1 ? Mainnet : Sepolia);
  if (chainId === 11155111) {
    const activation = chain.hardforks.find(entry => entry.name === 'amsterdam');
    if (!activation || activation.block !== null || activation.timestamp !== undefined) fail('LOCAL_ETHEREUM_FORK_UNSUPPORTED', 'The pinned Sepolia schedule no longer matches its reviewed overlay.');
    activation.timestamp = SEPOLIA_AMSTERDAM.timestamp;
  }
  const common = new Common({ chain });
  const hardfork = common.setHardforkBy({ blockNumber, timestamp });
  if (!SUPPORTED.has(hardfork)) fail('LOCAL_ETHEREUM_FORK_UNSUPPORTED', 'Only the pinned Shanghai-through-Amsterdam header schedules are supported.');
  return common;
}
