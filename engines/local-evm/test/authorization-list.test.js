import test from 'node:test';
import assert from 'node:assert/strict';
import { eoaCode7702SignAuthorization, eoaCode7702AuthorizationListBytesItemToJSON, hexToBytes } from '@ethereumjs/util';
import { MAX_AUTHORIZATIONS, normalizeAuthorizationList, recoverAuthorization, authorizationStateDecision } from '../authorization-list.js';

const KEY = '0x' + '01'.repeat(32), AUTHORITY = '0x1a642f0e3c3af545e7acbd38b07251b3990914f1';
const TARGET = '0x' + '22'.repeat(20), ZERO = '0x' + '00'.repeat(20);
const signed = (overrides = {}) => eoaCode7702AuthorizationListBytesItemToJSON(eoaCode7702SignAuthorization({chainId:'0x01',address:TARGET,nonce:'0x00',...overrides},hexToBytes(KEY)));
const tuple = overrides => ({chainId:'0x1',address:TARGET,nonce:'0x0',yParity:'0x0',r:'0x1',s:'0x1',...overrides});
const canonicalSigned = overrides => Object.fromEntries(Object.entries(signed(overrides)).map(([k,v])=>[k,k==='address'?v:'0x'+BigInt(v==='0x'?'0x0':v).toString(16)]));
const normalize = list => normalizeAuthorizationList({authorizationList:list});

test('authorization normalization preserves ordered duplicates, detaches, and freezes canonical values',()=>{
  assert.equal(normalizeAuthorizationList({}),undefined);
  const input=[tuple({address:TARGET.toUpperCase().replace('0X','0x')}),tuple({nonce:'0x1'})];
  const out=normalize(input);input[0].nonce='0x3';
  assert.equal(out[0].nonce,'0x0');assert.equal(out[0].address,TARGET);assert.equal(out[1].nonce,'0x1');
  assert(Object.isFrozen(out)&&out.every(Object.isFrozen));
  assert.equal(normalize(Array.from({length:MAX_AUTHORIZATIONS},()=>tuple())).length,16);
});
test('structural bounds reject ambiguous encodings, extra fields, sparse/getter/proxy values without evaluating them',()=>{
  for(const value of [[],Array.from({length:17},()=>tuple()),[tuple({nonce:'0x00'})],[tuple({nonce:'0x10000000000000000'})],[tuple({yParity:'0x100'})],[tuple({chainId:'0x1'+'0'.repeat(64)})],[{...tuple(),authority:AUTHORITY}],[tuple({r:1})]])assert.throws(()=>normalize(value),{code:'LOCAL_AUTHORIZATION_INPUT'});
  let calls=0;const item=tuple();Object.defineProperty(item,'r',{enumerable:true,get(){calls++;return '0x1';}});
  const list=[];list.length=1;
  for(const value of [[item],list,new Proxy([tuple()],{get(){calls++;throw Error('trap');}})])assert.throws(()=>normalize(value),{code:'LOCAL_AUTHORIZATION_INPUT'});
  assert.throws(()=>normalizeAuthorizationList(Object.defineProperty({},'authorizationList',{enumerable:true,get(){calls++;return [];}})),{code:'LOCAL_AUTHORIZATION_INPUT'});
  assert.equal(calls,0);
});
test('recover known offline signer and chain-zero domain; malformed signatures are skipped not admitted as recovered authorities',()=>{
  for(const chainId of ['0x01','0x00']){
    const a=normalize([canonicalSigned({chainId})])[0];assert.deepEqual(recoverAuthorization(a),{authority:AUTHORITY,reason:null});
  }
  for(const patch of [{yParity:'0x2'},{yParity:'0xff'},{r:'0x0'},{s:'0x0'},{s:'0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a1'}]){
    const a=normalize([tuple(patch)])[0];assert.deepEqual(recoverAuthorization(a),{authority:null,reason:'invalid_signature'});
  }
  assert.deepEqual(recoverAuthorization(tuple({chainId:'0x2',nonce:'0xffffffffffffffff'})),{authority:null,reason:'wrong_chain'});
  assert.deepEqual(recoverAuthorization(tuple({nonce:'0xffffffffffffffff'})),{authority:null,reason:'nonce_overflow'});
});
test('state decisions distinguish existence from emptiness and enforce exact delegation code before nonce matching',()=>{
  const a=tuple();
  assert.equal(authorizationStateDecision(a,{exists:false,nonce:0n,code:'0x'}).gasRefund,0n);
  assert.deepEqual(authorizationStateDecision(a,{exists:true,nonce:0n,code:'0x'}),{reason:null,nonceAfter:1n,codeAfter:'0xef0100'+TARGET.slice(2),gasRefund:12500n});
  for(const code of ['0x00','0xef0100','0xef0100'+TARGET.slice(2)+'00'])assert.equal(authorizationStateDecision(a,{exists:true,nonce:8n,code}).reason,'authority_has_code');
  assert.equal(authorizationStateDecision(a,{exists:true,nonce:8n,code:'0xef0100'+TARGET.slice(2)}).reason,'nonce_mismatch');
  assert.equal(authorizationStateDecision(tuple({address:ZERO}),{exists:true,nonce:0n,code:'0xef0100'+TARGET.slice(2)}).codeAfter,'0x');
});
