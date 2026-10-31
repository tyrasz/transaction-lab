// Offline input/signature/root/source checks only. Python is always given
// --prepare-only, whose return precedes every execution-environment creation.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {CASES, SYSTEMS, SCOPE, declaration, fixture} from './cases.mjs';
import {SEQUENCE_BYTECODE_CHECKS, SEQUENCE_SENDER, SEQUENCE_TOKEN, SEQUENCE_VAULT,
  SEQUENCE_SELECTORS, TOKEN_RUNTIME, VAULT_RUNTIME, encodeSequenceCall} from '../../engines/local-evm/test/sequence-fixture.js';
import {createTx, createTxFromRLP} from '../../engines/fixture-evm/node_modules/@ethereumjs/tx/dist/esm/index.js';
import {TEST_KEY} from '../../engines/local-evm/test/fee-fixture.js';
import {verifyEthereumHeader} from '../../engines/local-evm/ethereum-header.js';
import {RLP} from '../../engines/local-evm/node_modules/@ethereumjs/rlp/dist/esm/index.js';
import {keccak_256 as keccak} from '../../engines/local-evm/node_modules/@noble/hashes/sha3.js';
import {allocationRoot, bytes, hex, word} from '../amsterdam-storage-creation-v033/observations.mjs';
import {verifyToolchain, TOOLCHAIN_SHA256 as TOOLCHAIN_SHA} from './toolchain.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.resolve(DIR, '../..');
const MANIFEST = path.join(DIR, 'toolchain.json');
const sha = raw => createHash('sha256').update(raw).digest('hex');
let promise; const inputs = () => promise ??= Promise.all(CASES.map((_, i) => declaration(i)));

test('new current Python inventory binds all external bytes and discloses prior runtime drift', () => {
  const v=verifyToolchain();assert.equal(v.entries,5080);assert.equal(v.sha256,TOOLCHAIN_SHA);
  assert.equal(v.manifest.drift.sourceChanged,0);assert.equal(v.manifest.drift.venvRegularFilesChanged,0);
  assert.equal(v.manifest.drift.stdlibPycChanged,187);assert.equal(v.manifest.drift.stdlibNativeExtensionsChanged,3);
  assert.equal(v.manifest.drift.runtimeBinariesChanged,2);assert.equal(v.manifest.drift.earlierCapturedRuntimeRestored,false);
});

test('four fixed JSON-stable declarations retain all three positions and no expected output', async () => {
  assert(Object.isFrozen(CASES) && CASES.every(c => Object.isFrozen(c) && Object.isFrozen(c.methods)));
  assert.deepEqual(CASES.map(c => [c.fork, ...c.methods]), [
    ['Osaka','approve','deposit','withdraw'], ['Amsterdam','approve','deposit','withdraw'],
    ['Osaka','approve','depositThenRevert','withdraw'], ['Amsterdam','approve','depositThenRevert','withdraw'],
  ]);
  for (const [i, d] of (await inputs()).entries()) {
    assert.deepEqual(JSON.parse(JSON.stringify(d)), d);
    assert.deepEqual(await declaration(i), d);
    assert.equal(d.index, i); assert.equal(d.id, CASES[i].id); assert.deepEqual(d.scope, SCOPE);
    assert.equal(d.steps.length, 3); assert.deepEqual(d.steps.map(s => s.position), [0,1,2]);
    for (const item of [d, ...d.steps]) for (const key of ['expectedPostState','expectedResult','receipt','executionStatus','postStateRoot','queryOutputs','result'])
      assert.equal(Object.hasOwn(item, key), false);
    assert.deepEqual(d.productQueries, [{kind:'native_balance',account:SEQUENCE_SENDER}]);
  }
  for (const i of [-1, 4, 0.5]) await assert.rejects(fixture(i));
});

test('twelve signed type2 envelopes preserve exact requests, nonce order, same header and fees', async () => {
  for (const [i, d] of (await inputs()).entries()) {
    const f = await fixture(i);
    assert.equal(verifyEthereumHeader({header:d.header,expectedHash:d.headerHash,chainId:d.chainId}).hardfork,d.fork.toLowerCase());
    assert.equal(d.environment.currentBaseFee,'0x7'); assert.deepEqual(d.environment.withdrawals,[]);
    assert.equal(d.chainId, i % 2 === 0 ? 1 : 11155111);
    for (const s of d.steps) {
      const tx = createTxFromRLP(bytes(s.signedBytes), {common:f.common});
      assert(tx.verifySignature()); assert.equal(tx.getSenderAddress().toString(), SEQUENCE_SENDER);
      assert.equal(bytes(s.signedBytes)[0],2); assert.equal(hex(tx.serialize()),s.signedBytes);
      assert.equal(hex(keccak(bytes(s.signedBytes))),s.transactionHash);
      assert.equal(hex(RLP.encode([bytes(s.signedBytes)])),s.transactionBody);
      assert.deepEqual(JSON.parse(JSON.stringify(tx.toJSON())),s.transaction);
      assert.equal(tx.nonce,BigInt(s.position + 1)); assert.equal(tx.gasLimit,5000000n);
      assert.equal(tx.value,0n); assert.equal(tx.maxFeePerGas,13n); assert.equal(tx.maxPriorityFeePerGas,3n);
      assert.equal(tx.to.toString(),s.request.to); assert.equal(hex(tx.data),s.request.data);
      assert.equal(tx.common.chainId(),BigInt(d.chainId)); assert.deepEqual(tx.accessList,[]);
      assert.equal(s.inputGas.intrinsic,tx.getIntrinsicGas().toString());
      assert.deepEqual(s.request.fees,{maxFeePerGas:'13',maxPriorityFeePerGas:'3'});
    }
  }
});

test('initial roots and four STOP additions preserve exact synthetic token/vault allocation', async () => {
  for (const d of await inputs()) {
    assert.equal(await allocationRoot(d.allocation),d.initialStateRoot);
    assert.equal(await allocationRoot(d.originalAllocation),d.originalStateRoot);
    assert.equal(d.header.stateRoot,d.initialStateRoot); assert.notEqual(d.initialStateRoot,d.originalStateRoot);
    const original = structuredClone(d.allocation);
    for (const address of SYSTEMS) {
      assert.deepEqual(original[address],{nonce:'0x1',balance:'0x0',code:'0x00',storage:{}});
      assert.equal(Object.hasOwn(d.originalAllocation,address),false); delete original[address];
    }
    assert.deepEqual(original,d.originalAllocation); assert.deepEqual(d.amendment.addresses,SYSTEMS);
    assert.equal(d.allocation[SEQUENCE_TOKEN].code,TOKEN_RUNTIME); assert.equal(d.allocation[SEQUENCE_VAULT].code,VAULT_RUNTIME);
    assert.deepEqual(d.allocation[SEQUENCE_TOKEN].storage,{[d.slots.senderBalance]:word(1000),[d.slots.tokenSupply]:word(1000)});
    assert.deepEqual(d.allocation[SEQUENCE_VAULT].storage,{});
    assert.equal(d.allocation[SEQUENCE_SENDER].nonce,'0x1'); assert.equal(d.allocation[SEQUENCE_SENDER].balance,'0xe8d4a51000');
  }
});

test('approval spender and failure selector bind fixture bytecode and declared amounts without execution', async () => {
  for (const [i, d] of (await inputs()).entries()) {
    assert.equal(d.steps[0].request.to,SEQUENCE_TOKEN);
    assert.equal(d.steps[0].request.data,encodeSequenceCall('approve',[SEQUENCE_VAULT,100n]));
    assert.equal(d.steps[1].request.to,SEQUENCE_VAULT);
    assert.equal(d.steps[1].request.data,encodeSequenceCall(i < 2 ? 'deposit' : 'depositThenRevert',[100n]));
    assert.equal(d.steps[2].request.data,encodeSequenceCall('withdraw',[40n]));
    assert.equal(d.steps[2].request.to,SEQUENCE_VAULT);
  }
  assert.notEqual(SEQUENCE_SELECTORS.deposit,SEQUENCE_SELECTORS.depositThenRevert);
  assert(SEQUENCE_BYTECODE_CHECKS.length > 0);
  assert.equal((TOKEN_RUNTIME.length - 2) / 2,791); assert.equal((VAULT_RUNTIME.length - 2) / 2,759);
});

function preparation(input, {expectedSha, args = []} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'sequence-reference-preparation-'));
  try {
    const file = path.join(dir,'input.json'), raw = Buffer.from(JSON.stringify(input)); fs.writeFileSync(file,raw);
    const manifest = fs.readFileSync(MANIFEST); assert.equal(sha(manifest),TOOLCHAIN_SHA);
    const tool = JSON.parse(manifest);
    return spawnSync(tool.python,['-I','-B',path.join(DIR,'eels-worker.py'),file,MANIFEST,expectedSha ?? sha(raw),'--prepare-only',...args],
      {encoding:'utf8',timeout:15000,maxBuffer:2*1024*1024,env:{PATH:path.dirname(tool.python)}});
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
}

test('all four stock EELS preparation checks bind twelve signatures and initial roots without execution', async () => {
  for (const d of await inputs()) {
    const p = preparation(d); assert.equal(p.error,undefined); assert.equal(p.status,0,p.stderr);
    assert.equal(p.stderr,''); const out = JSON.parse(p.stdout);
    assert.equal(out.status,'prepared_no_execution'); assert.equal(out.id,d.id);
    assert.equal(out.initialStateRoot,d.initialStateRoot); assert.equal(out.originalStateRoot,d.originalStateRoot);
    assert.equal(out.headerHash,d.headerHash); assert.deepEqual(out.signedInputHashes,d.steps.map(s=>s.transactionHash));
    assert.equal(Object.hasOwn(out,'steps'),false); assert.equal(Object.hasOwn(out,'finalStateRoot'),false);
  }
});

test('input-only refusal catches changed bytes, signed request mismatch, lost positions and product-output injection', async () => {
  const d = (await inputs())[0];
  for (const [mutate, options, expected] of [
    [x=>x,{expectedSha:'0'.repeat(64)},/Input SHA256 mismatch/],
    [x=>{x.steps[1].request.data='0x';return x;},{},/Fixed method\/address\/argument bytes/],
    [x=>{x.steps.pop();return x;},{},/Three fixed positions/],
    [x=>{x.productResult={steps:[]};return x;},{},/Declaration fields/],
  ]) {
    const p = preparation(mutate(structuredClone(d)),options);
    assert.notEqual(p.status,0); assert.match(p.stderr,expected); assert.equal(p.stdout,'');
  }
});

test('preparation refuses coherently re-signed different amounts/spender/destination and relabelled methods', async () => {
  const d = (await inputs())[0], f = await fixture(0);
  for (const [position, changes] of [
    [1,{data:encodeSequenceCall('deposit',[101n])}],
    [2,{data:encodeSequenceCall('withdraw',[41n])}],
    [0,{data:encodeSequenceCall('approve',[SEQUENCE_SENDER,100n])}],
    [1,{to:SEQUENCE_TOKEN}],
  ]) {
    const input = structuredClone(d), s = input.steps[position]; Object.assign(s.request,changes);
    const r = s.request, tx = createTx({type:2,chainId:BigInt(input.chainId),nonce:BigInt(position+1),gasLimit:5000000n,
      value:0n,to:r.to,data:r.data,maxFeePerGas:13n,maxPriorityFeePerGas:3n},{common:f.common}).sign(bytes(TEST_KEY));
    s.transaction=JSON.parse(JSON.stringify(tx.toJSON()));s.signedBytes=hex(tx.serialize());s.transactionHash=hex(tx.hash());
    s.transactionBody=hex(RLP.encode([bytes(s.signedBytes)]));
    const p = preparation(input); assert.notEqual(p.status,0); assert.match(p.stderr,/Fixed method\/address\/argument bytes/); assert.equal(p.stdout,'');
  }
  const input=structuredClone(d);input.steps[1].method='depositThenRevert';
  const p=preparation(input);assert.notEqual(p.status,0);assert.match(p.stderr,/Position\/method binding/);assert.equal(p.stdout,'');
});

test('prepare-only return dominates every execution environment and reference target call in the adapter source', () => {
  const source = fs.readFileSync(path.join(DIR,'eels-worker.py'),'utf8');
  const gate = source.indexOf('if len(sys.argv) == 5:\n        report["status"] = "prepared_no_execution"\n        return report');
  assert(gate > 0);
  for (const call of ['tracker.BlockState(', 'vm.BlockEnvironment(', 'fork.apply_body(', 'bal.BlockAccessListBuilder(']) {
    assert(source.includes(call)); assert(source.indexOf(call) > gate);
  }
  assert(source.includes('state = loader.json_to_state(allocation)'));
  assert(source.includes('prior_root, stopped = post_root, not receipt.succeeded'));
  assert(!source.includes('subprocess')); assert(!source.includes('runTx('));
});
