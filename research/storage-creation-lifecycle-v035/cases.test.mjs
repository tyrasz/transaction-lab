// Input-only checks: no runCall, isolated child, runTx or reference execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import {CASES,SYSTEMS,PRODUCT_LIMITS,fixture,declaration,storageRoot,CONSTRUCTOR_PREFIX,READ_TOPIC,MAIN_SALT,QUERY_SALT,BENEFICIARY,QUERY_HELPER,SELF_GETTER,REVERT_GETTER,RETAIN_GETTER} from './cases.mjs';
import {createTxFromRLP} from '../../engines/fixture-evm/node_modules/@ethereumjs/tx/dist/esm/index.js';
import {RLP} from '../../engines/local-evm/node_modules/@ethereumjs/rlp/dist/esm/index.js';
import {keccak_256 as keccak} from '../../engines/local-evm/node_modules/@noble/hashes/sha3.js';
import {verifyEthereumHeader} from '../../engines/local-evm/ethereum-header.js';
import {allocationRoot,bytes,hex,word} from '../amsterdam-storage-creation-v033/observations.mjs';
const FACTORY='0x'+'44'.repeat(20),COINBASE='0x'+'99'.repeat(20);
let prepared;const inputs=()=>prepared??=Promise.all(CASES.map((_,i)=>declaration(i)));
function instructions(code){const b=bytes(code),out=[];for(let pc=0;pc<b.length;){const at=pc,op=b[pc++],size=op>=0x60&&op<=0x7f?op-0x5f:0;assert(pc+size<=b.length,'Truncated PUSH');out.push({pc:at,op,value:size?BigInt(hex(b.slice(pc,pc+size))):null});pc+=size;}return out;}
const values=ops=>ops.map(({op,value})=>[op,value]);
const push=(ops,i,value)=>{assert(ops[i]?.op>=0x60&&ops[i].op<=0x7f);assert.equal(ops[i].value,BigInt(value));};
function copiedPayload(code,payload){const ops=instructions(code),i=ops.findIndex(o=>o.op===0x39);assert(i>=3);push(ops,i-3,bytes(payload).length);const start=Number(ops[i-2].value);push(ops,i-1,0);assert(start>ops[i].pc);assert.equal(hex(bytes(code).slice(start)),payload);return instructions(hex(bytes(code).slice(0,start)));}
function createTarget(creator,salt,init){return hex(keccak(bytes('0xff'+creator.slice(2)+salt.slice(2)+hex(keccak(bytes(init))).slice(2))).slice(-20));}
function checkCreate(ops,init,salt,value){const i=ops.findIndex(o=>o.op===0xf5);assert(i>=4);push(ops,i-4,BigInt(salt));push(ops,i-3,bytes(init).length);push(ops,i-2,0);push(ops,i-1,value);assert.equal(ops.filter(o=>o.op===0xf5).length,1);return i;}
function checkCall(ops,to,{gas,input=0,value=0}={}){const i=ops.findIndex(o=>o.op===0xf1);assert(i>=7);push(ops,i-7,0);push(ops,i-6,0);push(ops,i-5,input);push(ops,i-4,0);push(ops,i-3,value);push(ops,i-2,BigInt(to));push(ops,i-1,gas);assert.equal(ops[i+1].op,0x50);return i;}
function checkJumps(ops){for(let i=0;i<ops.length;i++)if([0x56,0x57].includes(ops[i].op)){assert(ops[i-1].value!==null);const target=Number(ops[i-1].value);assert.equal(ops.find(o=>o.pc===target)?.op,0x5b,'Jump must land at instruction-boundary JUMPDEST');}}

test('eight fixed declarations are JSON-stable initial inputs with no execution prediction',async()=>{
  assert(Object.isFrozen(CASES)&&CASES.every(Object.isFrozen));assert.deepEqual(CASES.map(c=>[c.fork,c.mode]),[
    ['Shanghai','constructor_self'],['Osaka','constructor_self'],['Amsterdam','constructor_self'],['Amsterdam','constructor_sweep'],
    ['Shanghai','query_self'],['Osaka','query_self'],['Amsterdam','query_self'],['Amsterdam','query_creation']]);
  assert.equal(new Set(CASES.map(c=>c.id)).size,8);
  for(const[i,d]of(await inputs()).entries()){
    assert.deepEqual(await declaration(i),d);assert.deepEqual(JSON.parse(JSON.stringify(d)),d);
    assert.equal(d.index,i);assert.equal(d.kind,'CREATE2');assert.equal(d.rootCreate,false);assert.equal(d.scenario,'success');
    for(const key of['expectedPostState','expectedResult','stateRoot','receipt','executionStatus','queryOutputs','querySignedBytes'])assert.equal(Object.hasOwn(d,key),false);
    assert(d.queries.length<=8);assert.deepEqual(PRODUCT_LIMITS.execution,{wallMs:10000});
  }
  for(const i of[-1,8,0.5])await assert.rejects(fixture(i));
});

test('signed original type2 matches the exact priced unsigned envelope and trusted fork header',async()=>{
  for(const[i,d]of(await inputs()).entries()){
    const f=await fixture(i),tx=createTxFromRLP(bytes(d.signedBytes),{common:f.common});
    assert.equal(bytes(d.signedBytes)[0],2);assert(tx.verifySignature());assert.equal(tx.getSenderAddress().toString(),d.request.from);
    assert.equal(hex(tx.serialize()),d.signedBytes);assert.equal(hex(keccak(bytes(d.signedBytes))),d.transactionHash);
    assert.equal(hex(RLP.encode([bytes(d.signedBytes)])),d.transactionBody);assert.deepEqual(JSON.parse(JSON.stringify(tx.toJSON())),d.transaction);
    assert.equal(tx.nonce,1n);assert.equal(tx.gasLimit,5000000n);assert.equal(tx.value,0n);assert.equal(tx.to.toString(),FACTORY);assert.equal(hex(tx.data),'0x');
    assert.equal(tx.common.chainId(),BigInt(d.chainId));assert.equal(d.chainId,d.fork==='Amsterdam'?11155111:1);
    assert.equal(tx.maxFeePerGas,13n);assert.equal(tx.maxPriorityFeePerGas,3n);assert.deepEqual(tx.accessList,[]);
    assert.deepEqual(d.request.fees,{maxFeePerGas:'13',maxPriorityFeePerGas:'3'});assert.equal(d.request.executionProfile,'unsigned_eip1559_block_end');assert.equal(d.request.gas,'5000000');
    assert.equal(d.inputGas.intrinsic,tx.getIntrinsicGas().toString());assert.equal(d.inputGas.calldataFloor===null,d.fork==='Shanghai');
    assert.equal(verifyEthereumHeader({header:d.header,expectedHash:d.headerHash,chainId:d.chainId}).hardfork,d.fork.toLowerCase());
    assert.equal(d.environment.currentBaseFee,'0x7');assert.equal(d.environment.currentCoinbase,i<4?d.target:COINBASE);
    assert.equal(Object.hasOwn(d.environment,'currentExcessBlobGas'),d.fork!=='Shanghai');assert.equal(Object.hasOwn(d.environment,'slotNumber'),d.fork==='Amsterdam');
    assert.deepEqual(d.environment.withdrawals,[]);
  }
});

test('full initial roots, storage-only targets, and exactly four inert scaffold additions bind',async()=>{
  for(const d of await inputs()){
    assert.equal(await allocationRoot(d.allocation),d.initialStateRoot);assert.equal(d.header.stateRoot,d.initialStateRoot);
    assert.equal(await allocationRoot(d.originalAllocation),d.originalStateRoot);assert.notEqual(d.originalStateRoot,d.initialStateRoot);
    const original=structuredClone(d.allocation);
    for(const address of SYSTEMS){assert.equal(Object.hasOwn(d.originalAllocation,address),false);assert.deepEqual(original[address],{nonce:'0x1',balance:'0x0',code:'0x00',storage:{}});delete original[address];}
    assert.deepEqual(original,d.originalAllocation);assert.deepEqual(d.amendment.addresses,SYSTEMS);
    const expected={nonce:'0x0',balance:'0x11',code:'0x',storage:{[word(0)]:word(999),[word(991)]:word(123456)}};
    assert.deepEqual(d.allocation[d.target],expected);assert.equal(await storageRoot(expected.storage),d.initialTargetStorageRoot);
    assert.equal(Object.hasOwn(d.allocation,BENEFICIARY),false);assert.equal(d.allocation[FACTORY].nonce,'0x7');assert.equal(d.allocation[FACTORY].balance,'0x3e8');
    if(d.queryCreation){assert.deepEqual(d.allocation[d.queryCreation.target],expected);assert.equal(await storageRoot(expected.storage),d.queryCreation.initialStorageRoot);}
  }
});

test('main and query CREATE2 addresses bind actual creator, initcode and distinct fixed salts',async()=>{
  for(const d of await inputs()){
    assert.equal(d.creator,FACTORY);assert.equal(createTarget(d.creator,MAIN_SALT,d.sentinel.initcode),d.target);
    assert.notEqual(d.target,d.creator);assert.notEqual(d.target,d.request.from);
    if(d.queryCreation){const q=d.queryCreation;assert.equal(q.creator,QUERY_HELPER);assert.equal(q.nonce,'7');assert.equal(q.salt,QUERY_SALT);
      assert.equal(createTarget(q.creator,q.salt,q.initcode),q.target);assert.notEqual(q.target,d.target);assert.equal(d.allocation[q.creator].nonce,'0x7');}
  }
});

test('constructor hidden read is logged from SLOAD data before old-equal/fresh writes and termination',async()=>{
  const prefix=[
    [0x61,991n],[0x54,null],[0x80,null],[0x60,1n],[0x55,null],[0x60,0n],[0x52,null],
    [0x7f,BigInt(READ_TOPIC)],[0x60,32n],[0x60,0n],[0xa1,null],
    [0x61,999n],[0x60,0n],[0x55,null],[0x60,42n],[0x60,2n],[0x55,null],
  ];assert.deepEqual(values(instructions('0x'+CONSTRUCTOR_PREFIX)),prefix);
  for(const d of await inputs()){
    const ops=instructions(d.sentinel.initcode);assert.deepEqual(values(ops.slice(0,prefix.length)),prefix);
    if(d.mode==='constructor_self')assert.deepEqual(values(ops.slice(prefix.length)),[[0x30,null],[0xff,null]]);
    else if(d.mode==='constructor_sweep')assert.deepEqual(values(ops.slice(prefix.length)),[[0x73,BigInt(BENEFICIARY)],[0xff,null]]);
    else{const executable=copiedPayload(d.sentinel.initcode,d.sentinel.runtime);assert.equal(executable.at(-1).op,0xf3);assert(!executable.some(o=>o.op===0xff));
      assert.equal(d.sentinel.runtime,d.mode==='query_self'?'0x30ff':'0x60025460005260206000f3');}
  }
});

test('factory copies exact initcode, sends five wei and returns creation address; only004 funds again',async()=>{
  for(const[i,d]of(await inputs()).entries()){
    const ops=copiedPayload(d.allocation[FACTORY].code,d.sentinel.initcode),at=checkCreate(ops,d.sentinel.initcode,MAIN_SALT,5);
    assert.deepEqual(values(ops.slice(at+1,at+3)),[[0x60,0n],[0x52,null]]);assert.deepEqual(values(ops.slice(-3)),[[0x60,32n],[0x60,0n],[0xf3,null]]);
    assert.equal(ops.filter(o=>o.op===0xf1).length,i===3?1:0);assert.equal(d.probes.lifecycle.postCreationFunding,i===3?'3':'0');
    if(i===3)checkCall(ops,d.target,{gas:100000,value:3});
  }
});

test('query descriptors and independent templates preserve exact fixed order without signed query assumptions',async()=>{
  let halves=0;
  for(const[i,d]of(await inputs()).entries()){
    const expected=i<4?[d.request.from,FACTORY,d.target,...(i===3?[BENEFICIARY]:[])]:i<7?[SELF_GETTER,d.target,d.request.from]:[REVERT_GETTER,RETAIN_GETTER,d.queryCreation.target,d.target,d.request.from];
    assert.deepEqual(d.queries.map(q=>q.account??q.to),expected);assert.equal(d.queryTemplates.length,d.queries.length);
    for(const[qindex,q]of d.queries.entries()){
      const t=d.queryTemplates[qindex];assert.equal(t.index,qindex);assert.deepEqual(t.phases,['before','after']);
      if(q.kind==='native_balance')assert.deepEqual(t,{index:qindex,kind:'native_balance',account:q.account,phases:['before','after']});
      else{halves+=2;assert.equal(q.data,'0x70a08231'+d.request.from.slice(2).padStart(64,'0'));
        assert.deepEqual(t,{index:qindex,kind:'contract_call',request:{from:d.request.from,to:q.to,data:q.data,value:'0',gas:'1000000'},phases:['before','after']});
        for(const key of['nonce','fees','signedBytes','expectedResult','executionProfile'])assert.equal(Object.hasOwn(t.request,key),false);}
    }
  }assert.equal(halves,10);
});

test('fresh-selfdestruct getters actually CALL the new runtime then return a scalar word',async()=>{
  for(const d of (await inputs()).slice(4,7)){
    const ops=instructions(d.allocation[SELF_GETTER].code),call=checkCall(ops,d.target,{gas:200000});
    assert.deepEqual(values(ops.slice(call+2)),[[0x60,42n],[0x60,0n],[0x52,null],[0x60,32n],[0x60,0n],[0xf3,null]]);
    assert(!ops.some(o=>o.op===0xfd));assert.equal(d.sentinel.runtime,'0x30ff');
  }
});

test('008 uses one creation helper and valid mode/return-data branches for reverting and retaining queries',async()=>{
  const d=(await inputs())[7],q=d.queryCreation,helper=copiedPayload(d.allocation[QUERY_HELPER].code,q.initcode);
  const create=checkCreate(helper,q.initcode,QUERY_SALT,0);assert.equal(helper[create+1].op,0x50);checkJumps(helper);
  const load=helper.findIndex(o=>o.op===0x35);push(helper,load-1,0);assert.equal(helper[load+2].op,0x57);
  assert.deepEqual(values(helper.slice(load+3,load+6)),[[0x60,32n],[0x60,0n],[0xf3,null]]);
  const revert=helper.findIndex(o=>o.pc===Number(helper[load+1].value));assert.deepEqual(values(helper.slice(revert)),[[0x5b,null],[0x60,32n],[0x60,0n],[0xfd,null]]);
  assert.equal(q.initcode,'0x'+CONSTRUCTOR_PREFIX+'30ff');
  for(const[address,mode]of[[REVERT_GETTER,1],[RETAIN_GETTER,0]]){
    const ops=instructions(d.allocation[address].code);assert.deepEqual(values(ops.slice(0,3)),[[0x60,BigInt(mode)],[0x60,0n],[0x52,null]]);
    const call=checkCall(ops,QUERY_HELPER,{gas:600000,input:32});checkJumps(ops);
    assert.deepEqual(values(ops.slice(call+2,call+5)),[[0x3d,null],[0x60,32n],[0x14,null]]);
    const jump=ops.findIndex(o=>o.op===0x57);assert.deepEqual(values(ops.slice(jump+1,jump+4)),[[0x60,0n],[0x60,0n],[0xfd,null]]);
    const ok=ops.findIndex(o=>o.pc===Number(ops[jump-1].value));assert.deepEqual(values(ops.slice(ok)),[[0x5b,null],[0x60,32n],[0x60,0n],[0x60,0n],[0x3e,null],[0x60,32n],[0x60,0n],[0xf3,null]]);
  }
});
