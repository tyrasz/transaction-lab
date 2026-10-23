import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { EXAMPLES, USDC, HUSDC } from './config.js';

// An opt-in, read-only integration check. Public chain state can legitimately change.
const base = new URL(process.env.TRANSACTION_LAB_URL || 'http://127.0.0.1:5174');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) throw new Error('Live checks must target the local service.');
const supply = EXAMPLES.find(e=>e.id==='hyperlend-usdc-supply');
const core = EXAMPLES.find(e=>e.id==='hypercore-perps-to-spot');
const excessiveAmount = 1_000_000_000_000n; // 1,000,000 USDC; this public example has far less.
const excessiveData = supply.request.data.slice(0, 74) + excessiveAmount.toString(16).padStart(64, '0') + supply.request.data.slice(138);
function measuredSupply(r) {
  return r.execution?.status === 'success'
    && r.outAssets?.some(a => a.asset?.address === USDC && a.transferOut?.some(t => t.rawValue === '0xe5e403'))
    && r.balanceChanges?.status === 'measured'
    && r.balanceChanges.assets.some(a => a.asset.address === USDC && a.account === supply.request.from && a.deltaRaw === '-15066115')
    && r.balanceChanges.assets.some(a => a.asset.address === HUSDC && a.account === supply.request.from && a.deltaRaw === r.protocol.mintEventImpliedPrincipalRaw);
}
const cases = [
  { id:'hyperlend-current-supply', route:'/api/simulate', request:{...supply.request,block:'latest'}, check: measuredSupply },
  { id:'hyperlend-historical-supply', route:'/api/replay', request:{chainId:999,transactionHash:supply.transactionHash}, check: r => r.execution?.status === 'success' && r.source?.transactionHash === supply.transactionHash && r.source?.blockNumber === '49273757' },
  { id:'hypercore-historical-partial', route:'/api/replay', request:{chainId:999,transactionHash:core.transactionHash}, check: r => r.execution?.status === 'success' && r.coverage?.status === 'partial' && r.inAssets?.length === 0 && r.outAssets?.length === 0 },
  { id:'excessive-supply-reverts', route:'/api/simulate', request:{...supply.request,data:excessiveData,block:'latest'}, check: r => r.execution?.status === 'reverted' && r.inAssets?.length === 0 && r.outAssets?.length === 0 },
  { id:'usdc-maximum-approval-observed',route:'/api/simulate',request:{...EXAMPLES.find(e=>e.id==='usdc-max-approval').request,block:'latest'},check:r=>r.execution?.status==='success' && r.permissions?.observations?.some(o=>o.kind==='approval_request' && o.allowanceKind==='uint256_max' && o.eventCorrelation==='matched') && r.permissions.findings.some(f=>f.code==='MAX_UINT256_APPROVAL_EVENT') && r.permissions.coverage.allowanceStateVerified===true && r.allowanceChanges?.status==='measured' && r.allowanceChanges.allowances.some(a=>a.afterKind==='uint256_max')},
  { id:'usdc-revoke-approval-observed',route:'/api/simulate',request:{...EXAMPLES.find(e=>e.id==='usdc-revoke-approval').request,block:'latest'},check:r=>r.execution?.status==='success' && r.permissions?.observations?.some(o=>o.kind==='approval_event' && o.allowanceKind==='revoke' && o.amountRaw==='0') && !r.permissions.findings.some(f=>f.code.startsWith('MAX_UINT256')) && r.allowanceChanges?.status==='measured' && r.allowanceChanges.allowances.some(a=>a.afterRaw==='0')},
];
for (const operation of ['withdraw','borrow','repay']) {
  const example=EXAMPLES.find(e=>e.id===`hyperlend-usdc-${operation}`);
  const reconciled=r=>r.execution?.status==='success' && r.coverage?.status==='supported' && r.protocol?.reconciliation?.status==='reconciled' && r.inAssets.every(a=>a.asset.address!==r.protocol.positionToken || operation==='withdraw');
  cases.push({id:`hyperlend-current-${operation}`,route:'/api/simulate',request:{...example.request,block:'latest'},check:r=>reconciled(r) && r.balanceChanges?.status==='measured' && r.balanceChanges.assets.some(a=>a.asset.address===r.protocol.positionToken && a.account===r.protocol.positionAccount && a.deltaRaw===r.protocol.positionDeltaRaw)});
  cases.push({id:`hyperlend-historical-${operation}`,route:'/api/replay',request:{chainId:999,transactionHash:example.transactionHash},check:r=>reconciled(r) && r.balanceChanges?.status==='not_applicable' && r.source.transactionHash===example.transactionHash});
}
const results = [];
for (const item of cases) {
  const started = performance.now();
  try {
    const response = await fetch(new URL(item.route, base), {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(item.request),signal:AbortSignal.timeout(90000)});
    const body = await response.json();
    const passed = response.ok && item.check(body) && body.security?.status === 'not_assessed';
    results.push({id:item.id,passed,durationMs:Math.round(performance.now()-started),request:{path:item.route,body:item.request},httpStatus:response.status,response:body});
    console.log(`${passed ? 'PASS' : 'FAIL'} ${item.id}: ${body.execution?.status || body.error?.code || 'unknown'}, coverage ${body.coverage?.status || 'unavailable'}, block ${body.source?.blockNumber || 'unavailable'}`);
  } catch (error) {
    results.push({id:item.id,passed:false,durationMs:Math.round(performance.now()-started),error:{name:error.name,message:'The local API request did not complete.'}});
    console.log(`FAIL ${item.id}: local request unavailable`);
  }
}
const report = {schemaVersion:'1.0',createdAt:new Date().toISOString(),kind:'live_read_only_integration',notes:['Observed public chain data; outcomes may change as wallet balance and allowance change.','These checks do not measure security detection or establish superiority over another provider.'],summary:{passed:results.filter(r=>r.passed).length,total:results.length},results};
const directory = fileURLToPath(new URL('../reports/live/',import.meta.url));
await mkdir(directory,{recursive:true});
const reportPath = directory + report.createdAt.replace(/[:.]/g,'-') + '.json';
await writeFile(reportPath,JSON.stringify(report,null,2)+'\n',{mode:0o600});
console.log(`Saved ${reportPath}`);
if(report.summary.passed !== report.summary.total) process.exitCode = 1;
