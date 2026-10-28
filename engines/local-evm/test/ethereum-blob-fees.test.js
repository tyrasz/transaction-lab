import test from 'node:test';
import assert from 'node:assert/strict';
import { ethereumBlobContext, BLOB_FEE_LIMITS } from '../ethereum-blob-fees.js';
import { ethereumCommon } from '../ethereum-profile.js';
import { normalizeEthereumFees, ethereumFeePlan, settleEthereumFees, ETHEREUM_BLOB_FEE_PROFILE } from '../ethereum-fees.js';

const MAX = (1n << 256n) - 1n, ADDRESS = '0x' + 'ab'.repeat(20), HASH = '0x01' + '12'.repeat(31);
const rows = [
  ['cancun',1710338135n,3n,6n,6n,3338477n], ['prague',1746612311n,6n,9n,9n,5007716n],
  ['osaka',1764798551n,6n,9n,6n,5007716n], ['bpo1',1765290071n,10n,15n,6n,8346193n],
  ['bpo2',1767747671n,14n,21n,6n,11684671n],
];
const header = (timestamp = rows[2][1], change = {}) => ({ number: '30000000', timestamp: timestamp.toString(),
  excessBlobGas: '0', blobGasUsed: '0', baseFeePerGas: '7', gasLimit: '30000000', miner: ADDRESS, ...change });
const request = (change = {}) => ({ to: ADDRESS, data: '0x', value: '11', gas: '100000', executionProfile: ETHEREUM_BLOB_FEE_PROFILE,
  fees: { maxFeePerGas: '13', maxPriorityFeePerGas: '3', maxFeePerBlobGas: '100' }, blobVersionedHashes: [HASH], ...change });
const invalid = fn => assert.throws(fn, { code: 'LOCAL_ETHEREUM_INPUT_INVALID' });

test('blob fork selection independently agrees with ethereumCommon at every pinned transition', () => {
  assert.equal(ethereumBlobContext(header(1681338455n)), null);
  let previous = 'shanghai';
  for (const [fork,time,target,max,txMax,fraction] of rows) {
    for (const [timestamp, expected] of [[time-1n,previous],[time,fork],[time+1n,fork]]) {
      const h=header(timestamp), context=ethereumBlobContext(h);
      assert.equal(context?.hardfork ?? 'shanghai', expected); assert.equal(ethereumCommon(h).hardfork(), expected);
    }
    const c=ethereumBlobContext(header(time)); assert(Object.isFrozen(c));
    assert.deepEqual([c.targetBlobsPerBlock,c.maxBlobsPerBlock,c.maxBlobsPerTransaction,c.baseFeeUpdateFraction], [target,max,txMax,fraction]);
    assert.equal(c.gasPerBlob,131072n); previous=fork;
  }
  assert.throws(()=>ethereumBlobContext(header(1681338454n)),{code:'LOCAL_ETHEREUM_FORK_UNSUPPORTED'});
});

test('current excess determines the exact integer fee without a base-fee reserve clamp', () => {
  for (const [,time,,, ,fraction] of rows) {
    for (const [multiple,expected] of [[0n,1n],[1n,2n],[2n,7n],[5n,148n]]) {
      const h=header(time,{excessBlobGas:String(multiple*fraction),baseFeePerGas:MAX.toString()});
      assert.equal(ethereumBlobContext(h).blobBaseFeePerGas,expected);
    }
  }
});

test('uint64 hostile excess and the uint256 price boundary never produce an approximation', () => {
  const boundaries=[592398315n,888597561n,888597561n,1480995877n,2073394370n];
  assert.equal(BLOB_FEE_LIMITS.iterations,1024);
  for (let i=0;i<rows.length;i++) {
    const h=header(rows[i][1],{excessBlobGas:String(boundaries[i])});
    assert(ethereumBlobContext(h).blobBaseFeePerGas<=MAX);
    for(const excess of [boundaries[i]+1n,(1n<<64n)-1n]) assert.throws(()=>ethereumBlobContext({...h,excessBlobGas:String(excess)}),{code:'LOCAL_ETHEREUM_BLOB_PRICE_LIMIT'});
  }
});

test('header inputs require canonical uint64 data and fork-valid blob usage without executing accessors', () => {
  for (const [,time,,max] of rows) {
    assert.equal(ethereumBlobContext(header(time,{blobGasUsed:String(max*131072n)})).maxBlobsPerBlock,max);
    invalid(()=>ethereumBlobContext(header(time,{blobGasUsed:String((max+1n)*131072n)})));
  }
  for (const key of ['number','timestamp','excessBlobGas','blobGasUsed']) {
    for(const bad of [1,1n,'01','0x00','-1',' 1',String(1n<<64n),undefined]) invalid(()=>ethereumBlobContext(header(undefined,{[key]:bad})));
    const h=header();Object.defineProperty(h,key,{enumerable:true,get(){assert.fail('Accessor executed');}});invalid(()=>ethereumBlobContext(h));
  }
  invalid(()=>ethereumBlobContext(header(undefined,{blobGasUsed:'1'})));
  invalid(()=>ethereumBlobContext(new Proxy({}, {getPrototypeOf(){assert.fail('Proxy reflected');}})));
});

test('blob profile is explicit with exact caps, bounded hashes and no creation or authorization list', () => {
  const r=request(), n=normalizeEthereumFees(r);assert.equal(n.executionProfile,ETHEREUM_BLOB_FEE_PROFILE);
  assert(Object.isFrozen(n.fees));r.fees.maxFeePerBlobGas='1';assert.equal(n.fees.maxFeePerBlobGas,'100');
  for(const patch of [{to:null},{authorizationList:undefined},{blobVersionedHashes:[]},{blobVersionedHashes:Array(10).fill(HASH)},
    {blobVersionedHashes:['0x02'+'12'.repeat(31)]},{fees:{maxFeePerGas:'13',maxPriorityFeePerGas:'3'}},
    {fees:{...request().fees,extra:'1'}},{executionProfile:'unsigned_eip1559_block_end'}]) invalid(()=>normalizeEthereumFees(request(patch)));
  for(const value of [1,'01','-1','0x1',(MAX+1n).toString()]) invalid(()=>normalizeEthereumFees(request({fees:{...request().fees,maxFeePerBlobGas:value}})));
  const r2=request();Object.defineProperty(r2,'blobVersionedHashes',{enumerable:true,get(){assert.fail('Hash getter executed');}});invalid(()=>normalizeEthereumFees(r2));
});

test('fork transaction count is distinct from block capacity and does not subtract used block blobs', () => {
  for(const [,time,,max,txMax] of rows) {
    const h=header(time,{blobGasUsed:String(max*131072n)});
    assert.equal(ethereumFeePlan(request({blobVersionedHashes:Array(Number(txMax)).fill(HASH)}),h).blobCount,txMax);
    invalid(()=>ethereumFeePlan(request({blobVersionedHashes:Array(Number(txMax+1n)).fill(HASH)}),h));
  }
  invalid(()=>ethereumFeePlan(request(),header(1681338455n)));
});

test('blob affordability, burn and totals are separate from execution refunds and beneficiary tips', () => {
  const h=header(undefined,{excessBlobGas:String(2n*5007716n)}), r=request({blobVersionedHashes:[HASH,HASH]});
  const p=ethereumFeePlan(r,h), a=settleEthereumFees(p,{gasUsed:21000n});
  assert.equal(p.blobBaseFeePerGas,7n);assert.equal(p.blobFeeBurn,2n*131072n*7n);
  assert.equal(p.maximumRequiredBalance,100000n*13n+2n*131072n*100n+11n);
  assert.equal(p.totalUpfrontDebit,p.upfrontGasDebit+p.blobFeeBurn);
  assert.equal(a.kind,'eip4844');assert.equal(a.senderRefund,'790000');assert.equal(a.coinbaseTip,'63000');
  assert.equal(BigInt(a.totalFeeCharge),210000n+p.blobFeeBurn);assert.equal(BigInt(a.totalFeeBurn),147000n+p.blobFeeBurn);
  assert.equal(BigInt(a.totalUpfrontDebit)-BigInt(a.senderRefund),BigInt(a.totalFeeCharge));
  invalid(()=>ethereumFeePlan({...r,fees:{...r.fees,maxFeePerBlobGas:'6'}},h));
  invalid(()=>ethereumFeePlan({...r,fees:{...r.fees,maxFeePerBlobGas:MAX.toString()}},h));
  const plain={...r,executionProfile:'unsigned_eip1559_block_end',fees:{maxFeePerGas:'13',maxPriorityFeePerGas:'3'}};delete plain.blobVersionedHashes;
  const pa=settleEthereumFees(ethereumFeePlan(plain,h),{gasUsed:21000n});
  assert.equal(pa.kind,'eip1559');assert.equal(Object.hasOwn(pa,'blobFeeBurn'),false);assert.equal(Object.hasOwn(pa,'totalFeeCharge'),false);
});
