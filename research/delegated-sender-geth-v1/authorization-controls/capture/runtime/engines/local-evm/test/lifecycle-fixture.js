// Synthetic authenticated starting state for real bytecode lifecycle controls.
// No provider execution, predicted poststate or public-chain observation.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createMPT } from '@ethereumjs/mpt';
import { RLP } from '@ethereumjs/rlp';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { createRpcStateInputs } from '../rpc-state-inputs.js';
import { createProofStateManager } from '../proof-state.js';
import { A, B, bytes, hex, word, integer, minimalProof } from './proof-fixture.js';
export { A as FACTORY, B as SENDER, word, bytes, hex };
const raw = readFileSync(new URL('../../../reports/ethereum-proof-capability/capture.json', import.meta.url));
if (createHash('sha256').update(raw).digest('hex') !== 'd0965c21ce4f75e1c1db5df31e1a21970c9f11ffb985f24f7b911359caf0df6e') throw Error('fixture source changed');
const reference = JSON.parse(raw).selectedHeader;
const order = ['parentHash','sha3Uncles','miner','stateRoot','transactionsRoot','receiptsRoot','logsBloom','difficulty','number','gasLimit','gasUsed','timestamp','extraData','mixHash','nonce','baseFeePerGas','withdrawalsRoot','blobGasUsed','excessBlobGas','parentBeaconBlockRoot','requestsHash'];
const numeric = new Set(['difficulty','number','gasLimit','gasUsed','timestamp','baseFeePerGas','blobGasUsed','excessBlobGas']);
const uint16 = n => n.toString(16).padStart(4, '0');
export const RUNTIME = '60005460005260206000f3';
export function initcode(runtime = RUNTIME, prefix = '602a600055') {
  const length = uint16(runtime.length / 2), offset = uint16(prefix.length / 2 + 15);
  return prefix + `61${length}61${offset}60003961${length}6000f3` + runtime;
}
export function factoryCode(init, { kind = 'CREATE', value = 5, salt = word(123), repeat = 1, tail = '60005260206000f3' } = {}) {
  const length = uint16(init.length / 2);
  const create = `${kind === 'CREATE2' ? '7f' + salt.slice(2) : ''}61${length}600060${value.toString(16).padStart(2,'0')}${kind === 'CREATE2' ? 'f5' : 'f0'}`;
  const body = Array.from({length: repeat}, (_, i) => create + (i < repeat - 1 ? '50' : '')).join('') + tail;
  return '0x' + `61${length}61${uint16(9 + body.length / 2)}600039` + body + init;
}
export function createdAddress({ creator = A, nonce = 7n, kind = 'CREATE', salt = word(123), init = initcode() } = {}) {
  return hex(keccak_256(kind === 'CREATE2'
    ? bytes('0xff' + creator.slice(2) + salt.slice(2) + hex(keccak_256(bytes('0x' + init))).slice(2))
    : RLP.encode([bytes(creator), integer(nonce)])).slice(12));
}
export async function lifecycleFixture({ code = factoryCode(initcode()), accounts = {}, limits } = {}) {
  const specifications = { [A]: {nonce:7n,balance:1000n,code}, [B]: {nonce:1n,balance:1000000n,code:'0x'}, ...accounts };
  const state = await createMPT({useKeyHashing:true}), entries = new Map();
  const empty = (await createMPT({useKeyHashing:true})).root();
  for (const [address, input] of Object.entries(specifications)) {
    const spec = {nonce:0n,balance:0n,code:'0x',storage:{},...input};
    const storage = await createMPT({useKeyHashing:true});
    for (const [slot, value] of Object.entries(spec.storage)) if (BigInt(value) !== 0n) await storage.put(bytes(slot), RLP.encode(integer(BigInt(value))));
    const codeHash = keccak_256(bytes(spec.code));
    await state.put(bytes(address), RLP.encode([integer(spec.nonce), integer(spec.balance), storage.root(), codeHash]));
    entries.set(address, {...spec, storageTrie:storage, codeHash});
  }
  const header = {...reference,stateRoot:hex(state.root())};
  header.hash = hex(keccak_256(RLP.encode(order.map(key => numeric.has(key) ? integer(BigInt(header[key])) : bytes(header[key])))));
  const calls = [];
  const rpc = {async call(method,params) {
    calls.push({method,params:structuredClone(params)});
    if (!['eth_getProof','eth_getCode'].includes(method) || JSON.stringify(params.at(-1)) !== JSON.stringify({blockHash:header.hash,requireCanonical:true})) throw Error('unexpected execution input');
    const account = entries.get(params[0]);
    if (method === 'eth_getCode') return account?.code ?? '0x';
    return {address:params[0],accountProof:await minimalProof(state,params[0]),balance:'0x'+(account?.balance??0n).toString(16),nonce:'0x'+(account?.nonce??0n).toString(16),codeHash:hex(account?.codeHash??keccak_256(new Uint8Array())),storageHash:hex(account?.storageTrie.root()??empty),
      storageProof:await Promise.all(params[1].map(async key=>({key,value:'0x'+BigInt(account?.storage[key]??0n).toString(16),proof:account?await minimalProof(account.storageTrie,key):[]})))};
  }};
  const inputs = createRpcStateInputs({chainId:1,blockHash:header.hash,header,rpc,...(limits?{limits}:{})});
  return {request:{from:B,to:A,data:'0x',value:'0',gas:'5000000'},header,rpc,inputs,stateManager:createProofStateManager({inputs}),calls};
}
