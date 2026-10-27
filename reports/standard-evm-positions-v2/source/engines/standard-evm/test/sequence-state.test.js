import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {composeSequenceOverrides} from '../sequence-state.js';
import {buildStateOverrides,StateValidationError} from '../../../src/state.js';

const address=n=>'0x'+BigInt(n).toString(16).padStart(40,'0'),word=n=>'0x'+BigInt(n).toString(16).padStart(64,'0'),hex=n=>'0x'+BigInt(n).toString(16);
const S=address(1),TOKEN=address(2),OTHER=address(3),A=word(1),B=word(2),C=word(3),Z=word(0),MAX=(1n<<256n)-1n;
const empty=()=>({pre:{},post:{}});
const invalid=call=>assert.throws(call,error=>error instanceof StateValidationError&&!error.message.includes('PRIVATE_MARKER'));
const changed=(account,pre,post)=>({pre:{[account]:pre},post:{[account]:post}});

test('actual sealed single-step native and Aave diffs compose with no prior state without changing their overrides',async()=>{
  for(const [name,hash]of [['native-transfer','86c04f82a3912456c10e0cbac55af999415bd20a32986d80c685690f2854fd8b'],['aave-no-native','2632850a81ed4c8991f39d7f08079cae271520b20d8287631b89ee5ad02b4e69']]){
    const bytes=await readFile(new URL(`../../../reports/standard-evm-native/${name}-response.json`,import.meta.url));assert.equal(createHash('sha256').update(bytes).digest('hex'),hash);
    const diff=JSON.parse(bytes).stateDiff,before=structuredClone(diff),result=composeSequenceOverrides({},diff);
    assert.deepEqual(result.overrides,buildStateOverrides(diff));assert.deepEqual(result.overlapChecks,[]);assert.deepEqual(diff,before);
  }
});

test('synthetic approval then spending checks carried allowance and nonce, clears allowance, and retains untouched slots',()=>{
  const approval={pre:{[S]:{nonce:'4',balance:'1000'},[TOKEN]:{storage:{}}},post:{[S]:{nonce:'5'},[TOKEN]:{storage:{[A]:word(100)}}}};
  const first=composeSequenceOverrides({[TOKEN]:{stateDiff:{[C]:word(77)}}},approval);
  assert.deepEqual(first.overrides,{[S]:{nonce:'0x5'},[TOKEN]:{stateDiff:{[A]:word(100),[C]:word(77)}}});
  const spending={pre:{[S]:{nonce:'5',balance:'1000'},[TOKEN]:{storage:{[A]:word(100),[B]:word(500)}}},post:{[S]:{nonce:'6'},[TOKEN]:{storage:{[B]:word(400)}}}};
  const before=structuredClone({previous:first.overrides,spending}),second=composeSequenceOverrides(first.overrides,spending);
  assert.deepEqual(second.overrides,{[S]:{nonce:'0x6'},[TOKEN]:{stateDiff:{[A]:Z,[B]:word(400),[C]:word(77)}}});
  assert.deepEqual(second.overlapChecks,[{account:S,field:'nonce',beforeRaw:'5',expectedRaw:'5'},{account:TOKEN,field:'storage',slot:A,beforeRaw:word(100),expectedRaw:word(100)}]);
  assert.deepEqual({previous:first.overrides,spending},before);
});

test('post-only slot cannot conceal an ignored nonzero approval override',()=>{
  const previous={[TOKEN]:{stateDiff:{[A]:word(100)}}};
  invalid(()=>composeSequenceOverrides(previous,changed(TOKEN,{storage:{}},{storage:{[A]:word(200)}})));
  invalid(()=>composeSequenceOverrides(previous,changed(TOKEN,{}, {storage:{[A]:word(200)}})));
  invalid(()=>composeSequenceOverrides(previous,changed(TOKEN,{storage:{[A]:word(99)}},{storage:{[A]:word(200)}})));
});

test('a cleared zero survives untouched steps and can later be restored from omitted zero prestate',()=>{
  const previous={[TOKEN]:{stateDiff:{[A]:word(100),[B]:word(7)}},[OTHER]:{balance:'0x0'}};
  const cleared=composeSequenceOverrides(previous,changed(TOKEN,{storage:{[A]:word(100)}},{})).overrides;
  const untouched=composeSequenceOverrides(cleared,changed(S,{nonce:'0'},{nonce:'1'})).overrides;
  assert.equal(untouched[TOKEN].stateDiff[A],Z);assert.equal(untouched[TOKEN].stateDiff[B],word(7));assert.equal(untouched[OTHER].balance,'0x0');
  const restored=composeSequenceOverrides(untouched,changed(TOKEN,{storage:{}},{storage:{[A]:word(25)}}));
  assert.equal(restored.overrides[TOKEN].stateDiff[A],word(25));assert.equal(restored.overrides[TOKEN].stateDiff[B],word(7));
  assert.deepEqual(restored.overlapChecks,[{account:TOKEN,field:'storage',slot:A,beforeRaw:Z,expectedRaw:Z}]);
});

test('omitted post basic fields carry unchanged values while explicit post zero overwrites them',()=>{
  const previous={[S]:{balance:'0x64',nonce:'0x5',stateDiff:{[A]:word(2)}}};
  const same=composeSequenceOverrides(previous,changed(S,{balance:'100',nonce:'5',storage:{[B]:word(2)}},{storage:{[B]:word(3)}}));
  assert.deepEqual(same.overrides[S],{balance:'0x64',nonce:'0x5',stateDiff:{[A]:word(2),[B]:word(3)}});
  assert.deepEqual(same.overlapChecks,[{account:S,field:'balance',beforeRaw:'100',expectedRaw:'100'},{account:S,field:'nonce',beforeRaw:'5',expectedRaw:'5'}]);
  const zero=composeSequenceOverrides(previous,changed(S,{balance:'100',nonce:'5'},{balance:'0',nonce:'0'}));
  assert.deepEqual(zero.overrides[S],{balance:'0x0',nonce:'0x0',stateDiff:{[A]:word(2)}});
});

test('missing basic prefields match only explicit carried zero, including accounts touched solely through storage',()=>{
  const zero=composeSequenceOverrides({[TOKEN]:{balance:'0x0',nonce:'0x0'}},changed(TOKEN,{}, {storage:{[A]:word(1)}}));
  assert.deepEqual(zero.overlapChecks,[{account:TOKEN,field:'balance',beforeRaw:'0',expectedRaw:'0'},{account:TOKEN,field:'nonce',beforeRaw:'0',expectedRaw:'0'}]);
  for(const previous of [{balance:'0x1'},{nonce:'0x1'}])invalid(()=>composeSequenceOverrides({[TOKEN]:previous},changed(TOKEN,{}, {storage:{[A]:word(1)}})));
  invalid(()=>composeSequenceOverrides({[S]:{nonce:'0x2'}},changed(S,{nonce:'1'},{nonce:'2'})));
  invalid(()=>composeSequenceOverrides({[S]:{balance:'0x2'}},changed(S,{balance:'1'},{balance:'2'})));
});

test('accounts and fields absent from the changed-account diff remain carried without a fabricated check',()=>{
  const previous={[OTHER]:{nonce:'0x0',balance:'0x0',stateDiff:{[A]:Z}},[TOKEN]:{stateDiff:{[B]:word(8)}}};
  const result=composeSequenceOverrides(previous,changed(S,{nonce:'4'},{nonce:'5'}));
  assert.deepEqual(result.overrides,{[S]:{nonce:'0x5'},...previous});assert.deepEqual(result.overlapChecks,[]);
  assert.deepEqual(composeSequenceOverrides(result.overrides,empty()),{overrides:result.overrides,overlapChecks:[]});
});

test('multiple accounts and quantities are canonical and evidence order is deterministic',()=>{
  const upper='0x'+'AB'.repeat(20),lower=upper.toLowerCase(),upperSlot='0x'+'AB'.repeat(32),lowerSlot=upperSlot.toLowerCase();
  const previous={[upper]:{stateDiff:{[upperSlot]:'0x'+'CD'.repeat(32)},nonce:'0xA',balance:'0xF'},[S]:{nonce:'0x0'}};
  const diff={pre:{[upper]:{storage:{[upperSlot]:'0x'+'cd'.repeat(32)},balance:'15',nonce:'10'},[S]:{}},post:{[S]:{nonce:1},[upper]:{balance:'0x10',storage:{[upperSlot]:Z}}}};
  const expected=composeSequenceOverrides(previous,diff),shuffledPrevious=Object.fromEntries(Object.entries(previous).reverse()),shuffledDiff={post:diff.post,pre:Object.fromEntries(Object.entries(diff.pre).reverse())};
  assert.deepEqual(composeSequenceOverrides(shuffledPrevious,shuffledDiff),expected);
  assert.deepEqual(Object.keys(expected.overrides),[S,lower]);assert.deepEqual(expected.overrides[lower],{balance:'0x10',nonce:'0xa',stateDiff:{[lowerSlot]:Z}});
  assert.deepEqual(expected.overlapChecks.map(row=>[row.account,row.field]),[[S,'nonce'],[lower,'balance'],[lower,'nonce'],[lower,'storage']]);
});

test('exact maximum basic quantities are retained without Number precision loss',()=>{
  const previous={[S]:{balance:hex(MAX),nonce:hex((1n<<64n)-1n)}};
  const result=composeSequenceOverrides(previous,changed(S,{balance:MAX.toString(),nonce:((1n<<64n)-1n).toString()},{balance:'1'}));
  assert.equal(result.overrides[S].balance,'0x1');assert.equal(result.overrides[S].nonce,hex((1n<<64n)-1n));assert.equal(result.overlapChecks[0].beforeRaw,MAX.toString());
});

test('raw creation, deletion and runtime-code mutation remain unsupported',()=>{
  invalid(()=>composeSequenceOverrides({}, {pre:{},post:{[S]:{balance:'1'}}}));
  invalid(()=>composeSequenceOverrides({}, {pre:{[S]:{balance:'1'}},post:{}}));
  invalid(()=>composeSequenceOverrides({},changed(TOKEN,{code:'0x6000'},{code:'0x6001'})));
  invalid(()=>composeSequenceOverrides({},changed(TOKEN,{}, {code:'0x'})));
  const accepted=composeSequenceOverrides({},changed(TOKEN,{balance:'0',code:'0x'}, {balance:'1',code:'0x'}));
  assert.deepEqual(accepted,{overrides:{[TOKEN]:{balance:'0x1'}},overlapChecks:[]},'Only an already normalized effective diff can represent a proved empty funded account.');
});

test('previous state rejects noncanonical quantities and unsupported override capabilities',()=>{
  for(const field of ['code','state','storage','movePrecompileToAddress','unknown'])invalid(()=>composeSequenceOverrides({[S]:{[field]:{}}},empty()));
  for(const value of [0,1n,'0','01','0x00','0x01','-1','0x',null,true,['0x1'],hex(MAX+1n)])invalid(()=>composeSequenceOverrides({[S]:{balance:value}},empty()));
  invalid(()=>composeSequenceOverrides({[S]:{nonce:hex(1n<<64n)}},empty()));
  for(const previous of [null,undefined,[],new Date(),{bad:{}},{[S]:[]},{[S]:{stateDiff:[]}},Object.assign(Object.create({inherited:true}),{[S]:{}})])invalid(()=>composeSequenceOverrides(previous,empty()));
  invalid(()=>composeSequenceOverrides({[S]:{stateDiff:{[A]:['0x'+'0'.repeat(64)]}}},empty()));
});

test('address and slot collisions, non-enumerable fields and getters fail without executing hostile code',()=>{
  const lower='0x'+'a'.repeat(40),upper='0x'+'A'.repeat(40),slot='0x'+'a'.repeat(64),upperSlot='0x'+'A'.repeat(64);
  invalid(()=>composeSequenceOverrides({[lower]:{},[upper]:{}},empty()));
  invalid(()=>composeSequenceOverrides({[S]:{stateDiff:{[slot]:Z,[upperSlot]:Z}}},empty()));
  const previous={};Object.defineProperty(previous,S,{enumerable:true,get(){throw new Error('PRIVATE_MARKER');}});invalid(()=>composeSequenceOverrides(previous,empty()));
  const basic={};Object.defineProperty(basic,'balance',{enumerable:true,get(){throw new Error('PRIVATE_MARKER');}});invalid(()=>composeSequenceOverrides({[S]:basic},empty()));
  const hidden={};Object.defineProperty(hidden,'balance',{value:'0x0',enumerable:false});invalid(()=>composeSequenceOverrides({[S]:hidden},empty()));
  invalid(()=>composeSequenceOverrides({[S]:{[Symbol('private')]:'PRIVATE_MARKER'}},empty()));
  const badDiff=empty();Object.defineProperty(badDiff.post,S,{enumerable:true,get(){throw new Error('PRIVATE_MARKER');}});invalid(()=>composeSequenceOverrides({},badDiff));
});

test('cumulative account cap rejects individually valid fragments instead of truncating prior state',()=>{
  const previous=Object.fromEntries(Array.from({length:100},(_,i)=>[address(i+100),{balance:'0x0'}]));
  const same=composeSequenceOverrides(previous,changed(address(100),{balance:'0'},{balance:'1'}));assert.equal(Object.keys(same.overrides).length,100);
  invalid(()=>composeSequenceOverrides(previous,changed(S,{nonce:'0'},{nonce:'1'})));
  invalid(()=>composeSequenceOverrides({...previous,[S]:{}},empty()));
  const ninetyFive=Object.fromEntries(Object.entries(previous).slice(0,95)),six={pre:{},post:{}};for(let i=1;i<=6;i++){six.pre[address(i)]={balance:'0'};six.post[address(i)]={balance:'1'};}
  invalid(()=>composeSequenceOverrides(ninetyFive,six));
});

test('cumulative storage cap counts the complete merged slot union and overlaps once',()=>{
  const storage=Object.fromEntries(Array.from({length:2000},(_,i)=>[word(i+1),Z])),previous={[TOKEN]:{stateDiff:storage}};
  const result=composeSequenceOverrides(previous,changed(TOKEN,{}, {storage:{[A]:word(1)}}));assert.equal(Object.keys(result.overrides[TOKEN].stateDiff).length,2000);assert.equal(result.overlapChecks.length,1);
  invalid(()=>composeSequenceOverrides(previous,changed(TOKEN,{}, {storage:{[word(2001)]:word(1)}})));
  invalid(()=>composeSequenceOverrides(previous,changed(OTHER,{}, {storage:{[A]:word(1)}})));
  invalid(()=>composeSequenceOverrides({[TOKEN]:{stateDiff:{...storage,[word(2001)]:Z}}},empty()));
  const all=composeSequenceOverrides(previous,changed(TOKEN,{storage}, {storage:Object.fromEntries(Object.keys(storage).map(slot=>[slot,word(1)]))}));
  assert.equal(all.overlapChecks.length,2000);assert.ok(all.overlapChecks.every(row=>row.beforeRaw===Z&&row.expectedRaw===Z));
});
