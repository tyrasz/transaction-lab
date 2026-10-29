import test from 'node:test';
import assert from 'node:assert/strict';
import { Common, Mainnet, Sepolia, Hardfork } from '@ethereumjs/common';
import { privateToAddress, bytesToHex, hexToBytes } from '@ethereumjs/util';
import { createTx } from '../../fixture-evm/node_modules/@ethereumjs/tx/dist/esm/index.js';
import { getCalldataFloorGas } from '../../fixture-evm/node_modules/@ethereumjs/tx/dist/esm/util/intrinsic.js';
import { ethereumCallGas, ethereumCommon, ethereumContextProfile } from '../ethereum-profile.js';

const key=hexToBytes('0x'+'01'.repeat(32)),from=bytesToHex(privateToAddress(key)),to='0x'+'22'.repeat(20),word=n=>'0x'+BigInt(n).toString(16).padStart(64,'0');
const common=()=>new Common({chain:Sepolia,hardfork:Hardfork.Amsterdam});
const request=(extra={})=>({from,to,value:'0',data:'0x',gas:'5000000',...extra});
const cost=r=>ethereumCallGas(r.data,common(),r);
const tuple=()=>({chainId:'0xaa36a7',address:to,nonce:'0x0',yParity:'0x0',r:'0x0',s:'0x0'});

test('Amsterdam EIP-2780 reference shapes have the independently specified intrinsic and floor costs',()=>{
  const cases=[
    ['empty call',{},15000n,15000n],
    ['value to existing or absent recipient',{value:'1'},21000n,21000n],
    ['self no value',{to:from},12000n,12000n],
    ['self value',{to:from.toUpperCase().replace('0X','0x'),value:'1'},12000n,12000n],
    ['creation no value',{to:null},24000n,24000n],
    ['creation with value',{to:null,value:'1'},24000n,24000n],
    ['mixed calldata',{data:'0x0001'},15020n,15128n],
    ['creation initcode words',{to:null,data:'0x0001',value:'1'},24022n,24128n],
  ];
  for(const[label,extra,intrinsic,floor]of cases){const c=cost(request(extra));assert.equal(c.intrinsic,intrinsic,label);assert.equal(c.floor,floor,label);assert.equal(c.minimum,intrinsic>floor?intrinsic:floor,label);}
});

test('Amsterdam access-list duplicates pay both access and data charges; floor includes every declared byte',()=>{
  const r=request({accessList:[{address:to,storageKeys:[word(0),word(0)]},{address:to,storageKeys:[]}]}),c=cost(r);
  assert.equal(c.accessListAccessGas,9800n);assert.equal(c.accessListDataGas,6656n);
  assert.equal(c.intrinsic,31456n);assert.equal(c.floor,21656n);
  const p=ethereumContextProfile(r,{},common());assert.equal(p.accessListIntrinsicGas,'16456');assert.equal(p.accessListDataGas,'6656');
});

test('Amsterdam uniform calldata floor is independent of zero bytes; intrinsic data cost still distinguishes them',()=>{
  const zero=cost(request({data:'0x0000'})),nonzero=cost(request({data:'0xffff'}));
  assert.equal(zero.intrinsic,15008n);assert.equal(nonzero.intrinsic,15032n);
  assert.equal(zero.floor,15128n);assert.equal(nonzero.floor,15128n);
  const large=cost(request({data:'0x'+'00'.repeat(32768)}));assert.equal(large.floor,2112152n);
});

test('every Amsterdam authorization occurrence pays 7816 even if signature or chain would later skip',()=>{
  const r=request({authorizationList:[tuple(),{...tuple(),chainId:'0x2'}]}),c=cost(r);
  assert.equal(c.authorizationIntrinsic,15632n);assert.equal(c.intrinsic,30632n);assert.equal(c.floor,15000n);
  assert.equal(ethereumContextProfile(r,{},common()).authorizationIntrinsicGas,'15632');
});

test('owned intrinsic/floor arithmetic matches separately signed transaction calculations across declared shapes',()=>{
  let compared=0;
  for(const destination of [from,to,null])for(const value of ['0','17'])for(const data of ['0x','0x000102','0x'+'00'.repeat(33)])for(const accessList of [undefined,[{address:to,storageKeys:[word(0),word(1)]},{address:to,storageKeys:[]}]]){
    const r=request({to:destination,value,data,...(accessList?{accessList}:{})}),c=cost(r);
    const tx=createTx({type:2,chainId:11155111n,nonce:1n,gasLimit:5000000n,to:destination??undefined,value:BigInt(value),data,maxFeePerGas:0n,maxPriorityFeePerGas:0n,...(accessList?{accessList}:{})},{common:common()}).sign(key);
    assert.equal(tx.getSenderAddress().toString(),from);assert.equal(tx.getIntrinsicGas(),c.intrinsic);assert.equal(getCalldataFloorGas(tx),c.floor);compared++;
  }
  assert.equal(compared,36);
});

test('Amsterdam gas calculation requires complete explicit envelope and retains input bounds',()=>{
  for(const change of [{from:undefined},{to:undefined},{to:'0x0'},{value:undefined},{value:'-1'},{value:'01'},{value:1}])assert.throws(()=>cost(request(change)));
  assert.throws(()=>cost(request({data:'0x'+'00'.repeat(32769)})),/bounded/);
  assert.throws(()=>cost(request({to:null,authorizationList:[tuple()]})),/without blob context/);
});

test('older gas results remain unchanged and public mainnet execution still does not enable Amsterdam',()=>{
  const c=ethereumCallGas('0x0001',new Common({chain:Mainnet,hardfork:Hardfork.Osaka}));
  assert.deepEqual(c,{intrinsic:21020n,floor:21050n,minimum:21050n,zeroBytes:1n,nonzeroBytes:1n});
  assert.throws(()=>ethereumCommon({number:'12018196',timestamp:'1793261160'}),/Maximum HF/,'A Sepolia block must not be silently treated as a mainnet block');
  const selected=ethereumCommon({number:'30000000',timestamp:'1793261160'});assert.equal(selected.chainId(),1n);assert.equal(selected.hardfork(),'bpo2');assert.equal(selected.isActivatedEIP(2780),false);
});
