import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { analyzeTrace } from '../src/analyze.js';
import { measureBalances } from '../src/balances.js';

const fixture = JSON.parse(await readFile(new URL('../fixtures/hyperlend-observed-supply.json', import.meta.url)));
const first = JSON.parse(await readFile(new URL('../reports/capabilities/stateful-capability-probes.json', import.meta.url)));
const second = JSON.parse(await readFile(new URL('../reports/capabilities/poststate-capability-probes.json', import.meta.url)));
const beforeProbes = first.probes.filter(p => p.provider === 'drpc');
const afterProbes = second.probes.filter(p => p.provider === 'drpc');
const header = beforeProbes.find(p => p.label === 'pin_latest_block').response.result;
const block = { number: BigInt(header.number).toString(), hash: header.hash, timestamp: BigInt(header.timestamp).toString() };
const trace = afterProbes.find(p => p.label === 'same_block_call_trace').response.result;
const diff = beforeProbes.find(p => p.label === 'prestate_diff').response.result;
const USDC = '0xb88339cb7199b77e23db6e890353e22632ba630f';
const HUSDC = '0x744e4f26ee30213989216e1632d9be3547c4885b';
const OTHER = '0x1111111111111111111111111111111111111111';
const amountWord = value => `0x${BigInt(value).toString(16).padStart(64, '0')}`;

function setup({ mutateDiff, overrideCall, mutateInput } = {}) {
  const stateDiff = structuredClone(diff);
  mutateDiff?.(stateDiff);
  const calls = [];
  const input = {
    request: structuredClone(fixture.input.request), block: structuredClone(block), metadata: fixture.input.metadata,
    analysis: analyzeTrace({ ...fixture.input, trace, block }),
  };
  input.rpc = {
    async call(method, params) {
      calls.push({ method, params });
      const custom = await overrideCall?.(method, params, input);
      if (custom !== undefined) return custom;
      if (method === 'eth_getBlockByHash' || method === 'eth_getBlockByNumber') return structuredClone(header);
      if (method === 'debug_traceCall') return stateDiff;
      if (method === 'eth_call') {
        const symbol = params[0].to === USDC ? 'usdc' : 'husdc';
        const record = params.length === 3 ? afterProbes.find(p => p.label === `poststate_balance_${symbol}`) : beforeProbes.find(p => p.label === `balance_before_${symbol}`);
        return record.response.result;
      }
      throw new Error(`Unexpected RPC method ${method}`);
    },
  };
  mutateInput?.(input);
  return { input, calls };
}

test('observed same-block balance delta excludes interest already present before mint', async () => {
  const { input, calls } = setup();
  const result = await measureBalances(input);
  assert.equal(result.status, 'measured');
  assert.equal(result.basis, 'prestate_diff_balanceOf');
  assert.equal(result.assets[0].delta, '-15.066115');
  assert.equal(result.assets[1].delta, '15.066115');
  assert.equal(result.assets[1].before, '5677.663051');
  assert.equal(result.assets[1].after, '5692.729166');
  assert.equal(input.analysis.interestAccruals[0].value, '15.147031');
  assert.equal(input.analysis.interestAccruals[0].balanceIncrease, '0.080916');
  assert.equal(result.executionIdentity.stateBlockHash, block.hash);
  assert.equal(result.executionIdentity.timestamp, block.timestamp);
  for (const { method, params } of calls.filter(c => ['eth_call', 'debug_traceCall'].includes(c.method))) {
    assert.deepEqual(params[1], { blockHash: block.hash, requireCanonical: true }, method);
  }
  assert.equal(result.evidence.request.length, calls.length);
  assert.equal(result.evidence.response.length, calls.length);
});

test('all changed slots are applied with stateDiff and pre-only cleared slots are zeroed', async () => {
  const deletedSlot = amountWord(987654321n);
  const { input, calls } = setup({ mutateDiff: d => { d.pre[USDC].storage[deletedSlot] = amountWord(123n); } });
  const result = await measureBalances(input);
  assert.equal(result.status, 'measured');
  const override = calls.find(c => c.method === 'eth_call' && c.params.length === 3).params[2];
  assert.equal(override[USDC].stateDiff[deletedSlot], amountWord(0n));
  for (const [account, before] of Object.entries(diff.pre)) {
    for (const slot of Object.keys(before.storage ?? {})) assert.equal(override[account].stateDiff[slot], diff.post[account].storage?.[slot] ?? amountWord(0n));
    assert.equal(override[account]?.state, undefined, 'untouched storage must not be replaced');
  }
});

test('reverted or unsupported analysis never invokes the measurement provider', async () => {
  for (const mutateInput of [input => { input.analysis.execution.status = 'reverted'; }, input => { input.analysis.coverage.status = 'partial'; }]) {
    const { input, calls } = setup({ mutateInput });
    const result = await measureBalances(input);
    assert.equal(result.status, 'not_applicable');
    assert.deepEqual(result.assets, []);
    assert.equal(calls.length, 0);
  }
});

test('invalid block identity and a provider header mismatch fail closed', async () => {
  for (const options of [
    { mutateInput: input => { input.block.timestamp = undefined; } },
    { overrideCall: method => method === 'eth_getBlockByHash' ? { ...header, timestamp: '0x1' } : undefined },
  ]) {
    const { input } = setup(options);
    const result = await measureBalances(input);
    assert.equal(result.status, 'unavailable');
    assert.deepEqual(result.assets, []);
  }
});

test('block becoming noncanonical suppresses all measured deltas', async () => {
  const { input } = setup({ overrideCall: method => method === 'eth_getBlockByNumber' ? { ...header, hash: amountWord(1n) } : undefined });
  const result = await measureBalances(input);
  assert.equal(result.status, 'unavailable');
  assert.deepEqual(result.assets, []);
  assert.ok(result.warnings.some(w => w.includes('no longer canonical')));
});

test('reverting balance query or malformed return data cannot become a zero balance', async () => {
  for (const value of ['0x', '0x1', `0x${'f'.repeat(128)}`, null]) {
    const { input } = setup({ overrideCall: method => method === 'eth_call' ? value : undefined });
    const result = await measureBalances(input);
    assert.equal(result.status, 'unavailable');
    assert.deepEqual(result.assets, []);
  }
  const { input } = setup({ overrideCall: method => { if (method === 'eth_call') throw Object.assign(new Error('execution reverted'), { code: 'RPC_EXECUTION_ERROR' }); } });
  const result = await measureBalances(input);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.evidence.response.at(-1).error.code, 'RPC_EXECUTION_ERROR');
});

test('created/deleted accounts, changed code and malformed storage are rejected', async () => {
  for (const mutateDiff of [
    d => { d.post[OTHER] = { code: '0x00' }; },
    d => { delete d.post[USDC]; },
    d => { d.post[USDC].code = '0x00'; },
    d => { d.post[USDC].storage[amountWord(0n)] = '0x1'; },
    d => { d.pre = null; },
  ]) {
    const { input } = setup({ mutateDiff });
    const result = await measureBalances(input);
    assert.equal(result.status, 'unavailable');
    assert.deepEqual(result.assets, []);
  }
});

test('successful trace paired with a reverted or inconsistent diff is rejected by principal reconciliation', async () => {
  const { input } = setup({ overrideCall: (method, params) => {
    if (method === 'eth_call' && params.length === 3) return beforeProbes.find(p => p.label === `balance_before_${params[0].to === USDC ? 'usdc' : 'husdc'}`).response.result;
  } });
  const result = await measureBalances(input);
  assert.equal(result.status, 'unavailable');
  assert.deepEqual(result.assets, []);
  assert.ok(result.warnings.some(w => w.includes('disagrees')));
});

test('even a one-unit disagreement with same-context Mint principal is rejected', async () => {
  for (const adjustment of [-1n, 1n]) {
    const { input } = setup({ overrideCall: (method, params) => {
      if (method === 'eth_call' && params.length === 3 && params[0].to === HUSDC) return amountWord(BigInt(afterProbes.find(p => p.label === 'poststate_balance_husdc').response.result) + adjustment);
    } });
    const result = await measureBalances(input);
    assert.equal(result.status, 'unavailable');
    assert.deepEqual(result.assets, []);
    assert.ok(result.warnings.some(w => w.includes('traced Mint value minus accrued interest')));
  }
});

test('trace-reconciled rounding delta is retained without a fixed one-unit tolerance', async () => {
  for (const rounding of [1n, 2n]) {
    const { input } = setup({
      mutateInput: input => { input.analysis.protocol.mintEventImpliedPrincipalRaw = (15066115n - rounding).toString(); },
      overrideCall: (method, params) => {
        if (method === 'eth_call' && params.length === 3 && params[0].to === HUSDC) return amountWord(BigInt(afterProbes.find(p => p.label === 'poststate_balance_husdc').response.result) - rounding);
      },
    });
    const result = await measureBalances(input);
    assert.equal(result.status, 'measured');
    assert.equal(result.assets[1].deltaRaw, (15066115n - rounding).toString());
    assert.ok(result.warnings.some(w => w.includes('exactly matches the trace-reconciled')));
  }
});

test('arbitrary provider exception text and detail never reach saved evidence or warnings', async () => {
  const secret = 'credential-bearing-provider-url-secret';
  for (const code of ['RPC_EXECUTION_ERROR', secret]) {
    const { input } = setup({ overrideCall: () => { throw Object.assign(new Error(secret), { code, detail: { rpcCode: -32602, requestUrl: secret, body: secret } }); } });
    const result = await measureBalances(input);
    assert.equal(result.status, 'unavailable');
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal(result.evidence.response[0].error.rpcCode, -32602);
  }
});

test('another beneficiary receives separate before/after observations for both configured tokens', async () => {
  const { input, calls } = setup({
    mutateInput: input => {
      const args = input.request.data.slice(10);
      input.request.data = `0x617ba037${args.slice(0, 128)}${OTHER.slice(2).padStart(64, '0')}${args.slice(192)}`;
      input.analysis.protocol.onBehalfOf = OTHER;
    },
    overrideCall: (method, params, input) => {
      if (method !== 'eth_call') return;
      const queried = `0x${params[0].data.slice(-40)}`;
      let balance = 100000000n;
      if (params.length === 3 && params[0].to === USDC && queried === input.request.from) balance -= 15066115n;
      if (params.length === 3 && params[0].to === HUSDC && queried === OTHER) balance += 15066115n;
      return amountWord(balance);
    },
  });
  const result = await measureBalances(input);
  assert.equal(result.status, 'measured');
  assert.equal(result.assets.length, 4);
  assert.equal(calls.filter(c => c.method === 'eth_call').length, 8);
  assert.equal(result.assets.find(a => a.asset.address === HUSDC && a.account === OTHER).delta, '15.066115');
  assert.equal(result.assets.find(a => a.asset.address === HUSDC && a.account === input.request.from).delta, '0');
});

test('supply for another beneficiary rejects unexpected changes outside the deposited position', async () => {
  for (const unexpectedToken of [USDC,HUSDC]) {
    const {input}=setup({
      mutateInput: input=>{
        const args=input.request.data.slice(10);
        input.request.data=`0x617ba037${args.slice(0,128)}${OTHER.slice(2).padStart(64,'0')}${args.slice(192)}`;
        input.analysis.protocol.onBehalfOf=OTHER;
      },
      overrideCall: (method,params,input)=>{
        if(method!=='eth_call')return;
        const account='0x'+params[0].data.slice(-40),token=params[0].to;
        let value=100000000n;
        if(params.length===3){
          if(token===USDC && account===input.request.from)value-=15066115n;
          if(token===HUSDC && account===OTHER)value+=15066115n;
          if(token===unexpectedToken && account===(token===USDC?OTHER:input.request.from))value+=1n;
        }
        return amountWord(value);
      },
    });
    const result=await measureBalances(input);
    assert.equal(result.status,'unavailable');
    assert.deepEqual(result.assets,[]);
    assert.ok(result.warnings.some(w=>w.includes('unrelated sender or beneficiary')));
  }
});
