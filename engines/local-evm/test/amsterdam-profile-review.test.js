// Independent arithmetic/metadata controls only. No VM execution or RPC.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Common, Sepolia, Hardfork } from '@ethereumjs/common';
import { privateToAddress, bytesToHex, hexToBytes, bigIntToUnpaddedBytes } from '@ethereumjs/util';
import { createTx } from '../../fixture-evm/node_modules/@ethereumjs/tx/dist/esm/index.js';
import { getCalldataFloorGas } from '../../fixture-evm/node_modules/@ethereumjs/tx/dist/esm/util/intrinsic.js';
import { ethereumCallGas, ethereumContextProfile } from '../ethereum-profile.js';

const key = hexToBytes('0x' + '03'.repeat(32)), from = bytesToHex(privateToAddress(key)), target = '0x' + '44'.repeat(20);
const common = fork => new Common({ chain: Sepolia, hardfork: fork });
const request = patch => ({ from, to: target, value: '0', data: '0x', gas: '5000000', ...patch });

test('CREATE profile metadata reflects the selected intrinsic and initcode word charges', () => {
  const r = request({ to: null, value: '5', data: '0x' + '01'.repeat(33) });
  for (const [fork, creationGas] of [[Hardfork.Osaka, '32000'], [Hardfork.Amsterdam, '12000']]) {
    const c = common(fork), costs = ethereumCallGas(r.data, c, r), profile = ethereumContextProfile(r, {}, c);
    assert.equal(profile.operation, 'create'); assert.equal(profile.creationIntrinsicGas, creationGas);
    assert.equal(profile.creationIntrinsicGas, costs.creationIntrinsic.toString());
    assert.equal(profile.initcodeBytes, '33'); assert.equal(profile.initcodeWordGas, '4');
    assert.equal(profile.initcodeWordGas, costs.initcodeWordGas.toString());
  }
});

test('signed type-4 intrinsic/floor calculations agree for self transfers, repeated auth and access lists', () => {
  const tuple = { chainId: '0xaa36a7', address: target, nonce: '0x0', yParity: '0x0', r: '0x1', s: '0x1' };
  const accessList = [{ address: target, storageKeys: ['0x' + '00'.repeat(32), '0x' + '00'.repeat(32)] }, { address: target, storageKeys: [] }];
  let cases = 0;
  for (const to of [from, target]) for (const value of ['0', '17']) for (const count of [1, 16]) for (const data of ['0x', '0x000102']) {
    const list = Array.from({ length: count }, (_, i) => ({ ...tuple, ...(i % 2 ? { chainId: '0x2' } : {}) }));
    const r = request({ to, value, data, accessList, authorizationList: list }), c = common(Hardfork.Amsterdam);
    const costs = ethereumCallGas(data, c, r);
    const tx = createTx({ type: 4, chainId: 11155111n, nonce: 1n, gasLimit: 5000000n, to,
      value: BigInt(value), data, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, accessList,
      authorizationList: list.map(t => ['chainId','address','nonce','yParity','r','s'].map(k => k === 'address' ? hexToBytes(t[k]) : bigIntToUnpaddedBytes(BigInt(t[k])))),
    }, { common: c }).sign(key);
    assert.equal(tx.getSenderAddress().toString(), from);
    assert.equal(tx.getIntrinsicGas(), costs.intrinsic); assert.equal(getCalldataFloorGas(tx), costs.floor);
    const profile = ethereumContextProfile(r, {}, c);
    assert.equal(profile.authorizationIntrinsicGas, (7816n * BigInt(count)).toString());
    assert.equal(profile.accessListIntrinsicGas, (costs.accessListAccessGas + costs.accessListDataGas).toString());
    cases++;
  }
  assert.equal(cases, 16);
});

test('Amsterdam envelope validation does not invoke hostile getters or proxy traps', () => {
  const c = common(Hardfork.Amsterdam); let touched = 0;
  for (const field of ['from','to','value','accessList','authorizationList']) {
    const r = request({}); Object.defineProperty(r, field, { enumerable: true, get() { touched++; throw Error('must not execute'); } });
    assert.throws(() => ethereumCallGas('0x', c, r));
  }
  const r = new Proxy(request({}), { get() { touched++; throw Error('must not execute'); }, ownKeys() { touched++; throw Error('must not execute'); } });
  assert.throws(() => ethereumCallGas('0x', c, r)); assert.equal(touched, 0);
});
