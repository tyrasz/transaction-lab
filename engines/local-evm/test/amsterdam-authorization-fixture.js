// Synthetic proof-backed preparation controls. The signed counterpart uses the
// same EthereumJS dependency, so agreement is not independent-client evidence.
import { readFileSync } from 'node:fs';
import { RLP } from '@ethereumjs/rlp';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, createAddressFromString, hexToBytes } from '@ethereumjs/util';
import { lifecycleFixture, word } from './lifecycle-fixture.js';
import { createRpcStateInputs } from '../rpc-state-inputs.js';
import { createProofStateManager } from '../proof-state.js';
import { verifyEthereumHeader } from '../ethereum-header.js';
import { signAuthorization, AUTHORITY, DELEGATE } from './authorization-fixture.js';
import { SENDER, TARGET, FUNDS, commonForStateGas } from './state-gas-fixture.js';
import { applyAmsterdamAuthorizations } from '../amsterdam-authorization.js';

export { signAuthorization, AUTHORITY, DELEGATE, SENDER, TARGET, FUNDS, commonForStateGas, word };
export const CHAIN = 11155111n;
export const authorization = extra => signAuthorization({ chainId: CHAIN, ...extra });
export const address = createAddressFromString;
export const account = (state, key) => state.getAccount(address(key));
export const code = async (state, key) => bytesToHex(await state.getCode(address(key)));

// Input-only declaration for a later independently authorized Geth comparison.
// Empty leaf is deliberately retained: it is the client-divergent candidate.
export const EMPTY_AUTHORITY_CASE = Object.freeze({
  gasLimit: 1000000n, to: TARGET, value: 0n, data: '0x',
  target: Object.freeze({ nonce: 1n, code: '0x00' }),
  accounts: Object.freeze({ [AUTHORITY]: Object.freeze({ nonce: 0n, balance: 0n, code: '0x' }),
    [DELEGATE]: Object.freeze({ nonce: 1n, code: '0x00' }) }),
  authorizationList: Object.freeze([Object.freeze(authorization())]),
});
const template = JSON.parse(readFileSync(new URL('./fixtures/sepolia-network/header-12018196.json', import.meta.url)));
const order = ['parentHash','sha3Uncles','miner','stateRoot','transactionsRoot','receiptsRoot','logsBloom','difficulty','number','gasLimit','gasUsed','timestamp','extraData','mixHash','nonce','baseFeePerGas','withdrawalsRoot','blobGasUsed','excessBlobGas','parentBeaconBlockRoot','requestsHash','blockAccessListHash','slotNumber'];
const integers = new Set(['difficulty','number','gasLimit','gasUsed','timestamp','baseFeePerGas','blobGasUsed','excessBlobGas','slotNumber']);
function hash(header) {
  return bytesToHex(keccak_256(RLP.encode(order.map(key => {
    if (!integers.has(key)) return hexToBytes(header[key]);
    const n = BigInt(header[key]), digits = n.toString(16);
    return n === 0n ? new Uint8Array() : hexToBytes('0x' + digits.padStart(Math.ceil(digits.length / 2) * 2, '0'));
  }))));
}

export async function preparationFixture({ authority = { nonce: 0n, balance: 7n }, accounts = {},
  authorizationList = [authorization()], from = SENDER, to = TARGET, value = '0' } = {}) {
  const f = await lifecycleFixture({ code: '0x00', accounts: {
    [SENDER]: { nonce: 1n, balance: FUNDS }, [TARGET]: { nonce: 1n, code: '0x00' },
    [DELEGATE]: { nonce: 1n, code: '0x00' }, ...(authority === null ? {} : { [AUTHORITY]: authority }), ...accounts,
  } });
  const stateRoot = f.header.stateRoot;
  Object.assign(f.header, template, { stateRoot }); f.header.hash = hash(f.header);
  verifyEthereumHeader({ header: f.header, expectedHash: f.header.hash, chainId: Number(CHAIN) });
  f.inputs = createRpcStateInputs({ chainId: Number(CHAIN), header: f.header, blockHash: f.header.hash, rpc: f.rpc });
  f.stateManager = createProofStateManager({ inputs: f.inputs });
  f.request = { from, to, value, gas: '1000000', data: '0x', authorizationList };
  f.common = commonForStateGas();
  f.begin = async () => {
    await f.stateManager.checkpoint(); // outer attempt
    const sender = await account(f.stateManager, from); sender.nonce++;
    await f.stateManager.putAccount(address(from), sender);
    await f.stateManager.checkpoint(); // preparation, sender increment outside
  };
  f.apply = (extra = {}) => applyAmsterdamAuthorizations({ request: f.request, common: f.common,
    stateManager: f.stateManager, gasLimit: 977184n, stateGasReservoir: 0n, ...extra });
  return f;
}
