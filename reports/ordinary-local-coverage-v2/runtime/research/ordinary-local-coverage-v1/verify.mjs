// Offline artifact/proof audit only: no network and no new VM execution.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, lstat, realpath } from 'node:fs/promises';
import { join, resolve, posix, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual as equal } from 'node:util';
import { verifyFrozenSources, verifyNodeRuntime } from './freeze.mjs';
const need=(ok,message)=>{if(!ok)throw Object.assign(new Error(message),{code:'LOCAL_COHORT_EVIDENCE_INVALID'});};
const sha = v => createHash('sha256').update(v).digest('hex');
const own = (o, k) => Object.hasOwn(o, k);
const record = v => v && typeof v === 'object' && !Array.isArray(v);
const HEX = /^[0-9a-f]{64}$/, WORD = /^0x[0-9a-f]{64}$/;
const PROVIDERS = { drpc: 'https://eth.drpc.org/', publicnode: 'https://ethereum-rpc.publicnode.com/' };
const LIMITS = { files: 30000, fileBytes: 256 * 1024 * 1024, totalBytes: 8 * 1024 * 1024 * 1024, wireBytes: 8 * 1024 * 1024, calls: 6144 };
const integer = v => Number.isSafeInteger(v) && v >= 0;
const finite = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const timestamp = v => typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const digest = (v, label) => { need(typeof v === 'string' && HEX.test(v), label + ' hash is invalid.'); return v; };
function pathName(path) {
  need(typeof path === 'string' && path.length > 0 && path.length <= 1024 && !isAbsolute(path) && !path.includes('\\') && !path.includes('\0') && posix.normalize(path) === path && !path.split('/').some(v => !v || v === '.' || v === '..'), 'Noncanonical evidence path.'); return path;
}
async function regular(root, path) {
  pathName(path); const parts = path.split('/');
  for (let i = 1; i < parts.length; i++) { const s = await lstat(join(root, ...parts.slice(0, i))); need(s.isDirectory() && !s.isSymbolicLink(), 'Linked evidence directory.'); }
  const s = await lstat(join(root, path)); need(s.isFile() && !s.isSymbolicLink() && s.size <= LIMITS.fileBytes, 'Evidence is not a bounded regular file.'); return s;
}
async function fileHash(path) { const h = createHash('sha256'); for await (const b of createReadStream(path)) h.update(b); return h.digest('hex'); }
async function listEvidence(root, sub = '') {
  const found = [];
  for (const e of await readdir(join(root, sub), { withFileTypes: true })) {
    const path = sub ? `${sub}/${e.name}` : e.name;
    if (!sub && ['runtime', 'evidence-manifest.json'].includes(e.name)) continue;
    pathName(path); need(!e.isSymbolicLink(), 'Evidence symlinks are unsupported.');
    if (e.isDirectory()) found.push(...await listEvidence(root, path));
    else { need(e.isFile(), 'Nonregular evidence file.'); found.push(path); }
    need(found.length <= LIMITS.files, 'Evidence file bound exceeded.');
  }
  return found.sort();
}

async function packet(outputDirectory, expectedManifestSha256) {
  digest(expectedManifestSha256, 'Expected evidence manifest');
  const root = await realpath(resolve(outputDirectory));
  await regular(root, 'evidence-manifest.json'); const raw = await readFile(join(root, 'evidence-manifest.json'));
  need(raw.length <= 8 * 1024 * 1024 && sha(raw) === expectedManifestSha256, 'Evidence manifest identity differs.');
  const manifest = JSON.parse(raw);
  need(manifest.schemaVersion === '1.0' && Array.isArray(manifest.files) && manifest.files.length <= LIMITS.files, 'Evidence manifest shape is invalid.');
  digest(manifest.planSha256, 'Plan'); digest(manifest.sourceManifestSha256, 'Source manifest');
  const byPath = new Map(), folded = new Set(); let total = 0;
  for (const entry of manifest.files) {
    pathName(entry.path); need(entry.path !== 'evidence-manifest.json' && !entry.path.startsWith('runtime/') && !folded.has(entry.path.toLowerCase()), 'Duplicate or excluded evidence path.'); folded.add(entry.path.toLowerCase());
    need(integer(entry.bytes) && entry.bytes <= LIMITS.fileBytes && HEX.test(entry.sha256), 'Evidence inventory entry is invalid.');
    total += entry.bytes; need(total <= LIMITS.totalBytes, 'Evidence total byte bound exceeded.');
    const stat = await regular(root, entry.path); need(stat.size === entry.bytes && await fileHash(join(root, entry.path)) === entry.sha256, 'Evidence file bytes/hash differ: ' + entry.path); byPath.set(entry.path, entry);
  }
  need(equal([...byPath.keys()].sort(), await listEvidence(root)), 'Evidence membership differs from manifest.');
  need(byPath.get('plan.json')?.sha256 === manifest.planSha256 && byPath.get('source-manifest.json')?.sha256 === manifest.sourceManifestSha256, 'Plan/source manifest not bound by evidence manifest.');
  const read = async path => { need(byPath.has(path), 'Required artifact absent: ' + path); const bytes = await readFile(join(root, path)); need(bytes.length === byPath.get(path).bytes && sha(bytes) === byPath.get(path).sha256, 'Artifact changed during verification.'); return JSON.parse(bytes); };
  return { root, manifest, byPath, read, total };
}


function bindPhase(phase,wires,claimed,profile,hash){
  need(record(phase)&&Array.isArray(phase.transportWireIds),'Phase wire list absent');
  const rows=phase.transportWireIds.map(id=>{const w=wires.get(id);need(w&&!claimed.has(id)&&w.profile===profile&&w.provider==='drpc','Phase wire attribution differs');claimed.add(id);return w;});
  need(rows.every((w,i)=>i===0||w.globalId>rows[i-1].globalId),'Phase wire order differs');
  if(profile==='local')for(const w of rows)need((['eth_getProof','eth_getCode'].includes(w.request.method)&&equal(w.request.params.at(-1),{blockHash:hash,requireCanonical:true}))||(w.request.method==='eth_getBlockByHash'&&equal(w.request.params,[w.request.params[0],false])),'Unpinned local input');
  need(rows.length===0||record(phase.transportUsage),'Attempted phase usage absent');
  if(phase.transportUsage){const u=phase.transportUsage;need(equal(u.limits,{calls:profile==='local'?256:65,totalBytes:32*1024*1024,requestMs:25000,responseBytes:8*1024*1024,wallMs:145000}),'Phase limits differ');need(rows.length<=u.limits.calls,'Phase call cap exceeded');let priorBytes=0;for(const w of rows){need(priorBytes<u.limits.totalBytes,'Dispatch after phase byte exhaustion');priorBytes+=w.transport.observedBytes;}need(u.attempts===rows.length&&u.dispatches===rows.filter(w=>w.dispatched).length&&u.observedBytes===rows.reduce((s,w)=>s+w.transport.observedBytes,0),'Phase usage differs');}
  if(profile==='product')need(equal(phase.records,rows),'Oracle aliases differ from exact retained wire bytes');
  return rows;
}
const compact=value=>({...value,channels:Object.fromEntries(Object.entries(value.channels).map(([k,v])=>[k,{status:v.status,...(v.reason?{reason:v.reason}:{})}]))});
export function verifyTiming(timing,phase,limitMs){
  need(record(timing)&&equal(Object.keys(timing).sort(),['phase','limitMs','startedAt','finishedAt','wallElapsedMs','monotonicElapsedMs','clockValid','withinBudget'].sort())&&timing.phase===phase&&timing.limitMs===limitMs,'Timing record shape or bound differs');
  need(typeof timing.clockValid==='boolean'&&typeof timing.withinBudget==='boolean','Timing flags differ');
  need((timestamp(timing.startedAt)||timing.startedAt===null)&&(timestamp(timing.finishedAt)||timing.finishedAt===null)&&(finite(timing.wallElapsedMs)||timing.wallElapsedMs===null)&&(finite(timing.monotonicElapsedMs)||timing.monotonicElapsedMs===null),'Timing observations differ');
  if(timing.clockValid)need(timestamp(timing.startedAt)&&timestamp(timing.finishedAt)&&finite(timing.monotonicElapsedMs)&&Date.parse(timing.finishedAt)-Date.parse(timing.startedAt)===timing.wallElapsedMs&&timing.wallElapsedMs>=0,'Wall timing arithmetic differs');
  need(timing.withinBudget===(timing.clockValid&&timing.wallElapsedMs<limitMs&&timing.monotonicElapsedMs<limitMs),'Timing completion contradicts recorded clocks');
  return timing;
}
export async function verifyEvidence({outputDirectory,expectedManifestSha256}){
  const p=await packet(outputDirectory,expectedManifestSha256),sources=await verifyFrozenSources({outputDirectory:p.root,expectedManifestSha256:p.manifest.sourceManifestSha256});
  await verifyNodeRuntime(sources.manifest.runtime);
  const archived=async name=>{need(sources.manifest.files.some(f=>f.path===name&&f.kind==='file'),'Required archived module missing');return import(pathToFileURL(join(p.root,'runtime',name)));};
  const modules=Object.assign({},...await Promise.all([
    'research/ordinary-local-coverage-v1/run.mjs','research/ordinary-local-coverage-v1/case.mjs',
    'research/standard-evm/cohort-verify.mjs','research/standard-evm/cohort-census.mjs','research/standard-evm/cohort-classification.mjs','research/standard-evm/cohort-accounting.mjs',
    'engines/local-evm/ethereum-header.js','engines/local-evm/verified-state-proof.js','engines/local-evm/authenticated-ancestry.js','engines/local-evm/input-facts.js',
  ].map(archived)));
  const plan=await p.read('plan.json'),started=await p.read('STARTED.json'),results=await p.read('results.json');
  const ledger=await p.read('write-ledger.json'),preexisting=['FROZEN.json','plan.json','source-manifest.json'];
  need(ledger?.schemaVersion==='1.0'&&Array.isArray(ledger.files),'Original-write ledger missing');
  const expectedLedger=[...p.byPath.values()].filter(e=>e.path!=='write-ledger.json').map(e=>({...e,origin:preexisting.includes(e.path)?'preexisting':'written'})).sort((a,b)=>a.path.localeCompare(b.path));
  need(equal(ledger.files,expectedLedger),'Original-write ledger differs from retained bytes/inventory');
  await modules.loadPlan({outputDirectory:p.root,expectedPlanSha256:p.manifest.planSha256});
  need(results.planSha256===p.manifest.planSha256&&results.sourceManifestSha256===p.manifest.sourceManifestSha256&&equal(results.scope,plan.scope),'Result plan binding differs');
  need(started.planSha256===p.manifest.planSha256&&started.sourceManifestSha256===p.manifest.sourceManifestSha256&&equal(started.runtime,plan.runtime)&&started.startedAt===results.startedAt,'Start identity differs');
  need(started.schemaVersion==='1.0'&&results.schemaVersion==='1.0'&&integer(started.pid)&&started.pid>0&&timestamp(started.startedAt)&&timestamp(results.finishedAt)&&timestamp(plan.frozenAt)&&(Date.parse(results.finishedAt)>=Date.parse(started.startedAt)||results.timingViolation?.code==='clock_invalid')&&Date.parse(started.startedAt)>=Date.parse(plan.frozenAt),'Run chronology differs');
  need(['complete','selection_failed','interrupted'].includes(results.status)&&Array.isArray(results.failures)&&finite(results.executionWindowMs)&&finite(results.durationMs)&&results.durationMs>=results.executionWindowMs,'Result completion/timing is malformed');
  need(results.status==='interrupted'||(results.sourceUnchanged===true&&results.runtimeUnchanged===true&&results.failures.length===0),'Unverified source cannot produce complete metrics');
  const timings=[verifyTiming(results.timing,'run',plan.policy.collectionAndExecutionMs)];
  if(results.timing.clockValid)need(Date.parse(results.timing.startedAt)>=Date.parse(started.startedAt)&&Date.parse(results.timing.finishedAt)<=Date.parse(results.finishedAt),'Run timing lies outside capture');
  need(equal(results.budget.limits,{calls:plan.policy.totalCalls,totalBytes:plan.policy.totalResponseBytes,wallMs:plan.policy.collectionAndExecutionMs}),'Budget differs');
  const paths=[...p.byPath.keys()];need(paths.every(n=>!n.startsWith('wire/')||/^wire\/\d{6}\.json$/.test(n))&&paths.every(n=>!n.startsWith('events/')||/^events\/\d{5}\.json$/.test(n)),'Unexpected wire/event artifact path');
  const wirePaths=paths.filter(n=>/^wire\/\d{6}\.json$/.test(n)).sort(),wires=[],byId=new Map(),summaries=[];
  for(const path of wirePaths){const w=await p.read(path);need(path===`wire/${String(w.globalId).padStart(6,'0')}.json`&&!byId.has(w.globalId),'Wire path/identity differs');summaries.push(modules.verifyCohortWireRecord(w));wires.push(w);byId.set(w.globalId,w);}
  need(wires.every((w,i)=>w.globalId===i+1),'Global wire sequence has a gap');let priorBytes=0;for(const w of wires){need(priorBytes<plan.policy.totalResponseBytes,'Dispatch after global byte exhaustion');priorBytes+=w.transport.observedBytes;}
  const total=wires.reduce((n,w)=>n+w.transport.observedBytes,0),dispatched=wires.filter(w=>w.dispatched).length;
  need(results.budget.calls===wires.length&&results.budget.dispatches===dispatched&&results.budget.observedBytes===total,'Final public wire budget differs');
  const selection=await p.read('selection.json'),events=[];
  for(const path of paths.filter(n=>/^events\/\d{5}\.json$/.test(n)).sort()){need(path===`events/${String(events.length+1).padStart(5,'0')}.json`,'Event numbering differs');events.push(await p.read(path));}
  const censusWires=wires.filter(w=>w.profile==='census'),input=modules.verifyCollectorBindings(selection,censusWires,events,plan,modules.verifyEthereumHeader),claimed=new Set(censusWires.map(w=>w.globalId));
  need(results.selectionStatus===selection.status,'Selection summary differs');
  let census=null,proofsVerified=0,outcomes=[],outcomesRecomputed=0,partialCases=0;
  const phaseTiming=(phase,name)=>{if(phase.timing)timings.push(verifyTiming(phase.timing,name,name==='local'?plan.policy.localWallMs:plan.policy.oracleWallMs));else need(!phase.transportUsage,'Dispatched phase lacks terminal clock observations');};
  if(selection.status==='complete'){
    need(input&&selection.artifacts.failure===null,'Completed selection has failed evidence');census=modules.validateCohortCensus(input);need(equal(census,selection.census),'Census does not reproduce');
    need(equal(await p.read('classification.json'),modules.classifyCohortIntents(modules.classificationInput(census))),'All-population classification differs');
    const interrupted=results.status==='interrupted',run=results.caseRun;
    need(record(run)&&Array.isArray(run.rows)&&run.rows.length===census.selected.length,'Selected denominator is incomplete');
    if(interrupted)need(run.status==='interrupted'&&run.accounting===null&&Array.isArray(run.interruptedLedger),'Interrupted run must withhold metrics and retain its ledger');
    else need(run.fatal===null&&run.interruptedLedger===null&&run.status==='complete'&&results.status==='complete','Completed selected execution has failed evidence');
    const fatalIndex=run.fatal?.caseId===null?null:run.fatal?run.rows.findIndex(e=>e.id===run.fatal.caseId):null;
    if(run.fatal)need(interrupted&&record(run.fatal)&&['artifact_save_failed','transport_drain_incomplete','local_drain_incomplete','case_integrity_failure','final_health_failure'].includes(run.fatal.code)&&(run.fatal.caseId===null||fatalIndex>=0),'Fatal case identity differs');
    need(paths.filter(n=>n.startsWith('cases/')).every(n=>/^cases\/\d{3}\/(request|local|LOCAL_SEALED|oracle|outcome)\.json$/.test(n)&&Number(n.split('/')[1])>=1&&Number(n.split('/')[1])<=census.selected.length),'Unknown case artifact');
    let prior=censusWires.at(-1)?.globalId??0;
    for(let i=0;i<census.selected.length;i++){
      const row=census.selected[i],id=String(i+1).padStart(3,'0'),entry=run.rows[i],prefix=`cases/${id}/`;
      need(entry.id===id&&entry.transactionHash===row.transactionHash,'Selected case identity differs');
      if(!entry.localArtifact||!entry.oracleArtifact){
        need(interrupted&&fatalIndex!==null&&i>=fatalIndex,'Missing phase artifacts outside the declared interrupted suffix');partialCases++;
        const later=i>fatalIndex,expectedOutcome={transactionHash:row.transactionHash,execution:later?'budget_unattempted':'provider_unavailable',comparison:later?'budget_unattempted':'not_comparable'};
        need(equal(entry.adjudication,{outcome:expectedOutcome,channels:{},reasons:[later?'Prior integrity failure stopped dispatch; no replacement':'Case could not retain a complete verified result'],allChannelsComplete:false}),'Interrupted slot was promoted or relabelled');
        if(later){need(entry.projection===null&&!paths.some(n=>n.startsWith(prefix)),'Dispatch or artifacts after fatal case');}
        else{
          let projection=null;try{projection=modules.projectSelectedCase({row,census});}catch{/* A malformed projection remains an explicit unavailable slot. */}
          need(equal(entry.projection,projection),'Interrupted projection differs');
          const retained=async name=>p.byPath.has(prefix+name)?p.read(prefix+name):null;
          const request=await retained('request.json'),local=await retained('local.json'),seal=await retained('LOCAL_SEALED.json'),oracle=await retained('oracle.json'),outcome=await retained('outcome.json');
          if(request)need(equal(request,{transactionHash:row.transactionHash,parentHeader:row.parentHeader,projection}),'Partial request differs');
          need((!local||request)&&(!seal||local)&&(!oracle||seal)&&(!outcome||oracle),'Interrupted artifact order differs');
          if(local){
            need(equal(local.implementation,plan.localImplementation),'Partial local implementation differs');phaseTiming(local,'local');
            const rows=bindPhase(local,byId,claimed,'local',row.parentBlockHash);need(rows.every(w=>w.globalId>prior),'Partial phase order differs');if(rows.length)prior=rows.at(-1).globalId;
            proofsVerified+=(await modules.verifyLocalBindings(local,rows,row.parentHeader,modules)).proofsVerified;
            if(local.attempt?.inputs)await modules.validateInputFacts({inputs:local.attempt.inputs,inputEvidence:local.attempt.inputEvidence,stateRoot:row.parentHeader.stateRoot});
            if(seal){const meta=p.byPath.get(prefix+'local.json');need(equal(seal,{schemaVersion:'1.0',path:prefix+'local.json',bytes:meta.bytes,sha256:meta.sha256,wireIds:local.transportWireIds,lastWireId:local.transportWireIds.at(-1)??null,at:seal.at})&&timestamp(seal.at),'Partial local seal differs');}
          }
          if(oracle){
            need(projection?.status==='projectable','Partial oracle lacks its declared request');phaseTiming(oracle,'oracle');
            const rows=bindPhase(oracle,byId,claimed,'product',row.parentBlockHash),expected=modules.oracleRequests({request:projection.request,header:row.parentHeader});
            need(rows.length<=expected.length&&rows.every((w,j)=>w.globalId>prior&&w.request.method===expected[j].method&&equal(w.request.params,expected[j].params)&&Date.parse(w.startedAt)>=Date.parse(seal.at)),'Partial oracle sequence differs');if(rows.length)prior=rows.at(-1).globalId;
            if(outcome){const derived=await modules.adjudicateLocalOutcome({transactionHash:row.transactionHash,request:projection.request,header:row.parentHeader,expectedLocalImplementation:plan.localImplementation,local,oracle});need(equal(outcome,derived),'Retained partial outcome differs');outcomesRecomputed++;}
          }
        }
        outcomes.push(expectedOutcome);continue;
      }
      const projection=modules.projectSelectedCase({row,census}),request=await p.read(`${prefix}request.json`);
      need(equal(request,{transactionHash:row.transactionHash,parentHeader:row.parentHeader,projection}),'Case request/projection differs');
      need(entry.id===id&&entry.transactionHash===row.transactionHash&&equal(entry.projection,projection)&&entry.localArtifact===`cases/${id}/local.json`&&entry.oracleArtifact===`cases/${id}/oracle.json`,'Case ledger differs');
      const local=await p.read(entry.localArtifact),seal=await p.read(`cases/${id}/LOCAL_SEALED.json`),oracle=await p.read(entry.oracleArtifact),localWires=bindPhase(local,byId,claimed,'local',row.parentBlockHash),oracleWires=bindPhase(oracle,byId,claimed,'product',row.parentBlockHash);
      phaseTiming(local,'local');phaseTiming(oracle,'oracle');
      const meta=p.byPath.get(entry.localArtifact);need(equal(seal,{schemaVersion:'1.0',path:entry.localArtifact,bytes:meta.bytes,sha256:meta.sha256,wireIds:local.transportWireIds,lastWireId:local.transportWireIds.at(-1)??null,at:seal.at})&&timestamp(seal.at),'Local durable seal differs');
      need(equal(local.implementation,plan.localImplementation),'Local product identity differs');
      const phase=[...localWires,...oracleWires];need(phase.every((w,j)=>w.globalId>(j?phase[j-1].globalId:prior)),'Local/oracle phase order differs');if(phase.length)prior=phase.at(-1).globalId;
      if(localWires.length)need(Date.parse(seal.at)>=Date.parse(localWires.at(-1).startedAt),'Local seal predates input dispatch');
      if(oracleWires.length)need(Date.parse(oracleWires[0].startedAt)>=Date.parse(seal.at),'Oracle preceded local seal');
      let outcome;
      if(projection.status==='unsupported'){
        need(local.dispatch==='unsupported'&&local.attempt===null&&oracle.dispatch==='unsupported'&&phase.length===0,'Unsupported selection was dispatched or replaced');outcome=modules.unsupportedOutcome(row.transactionHash,projection.reasons);
      }else{
        proofsVerified+=(await modules.verifyLocalBindings(local,localWires,row.parentHeader,modules)).proofsVerified;
        if(local.attempt?.inputs)await modules.validateInputFacts({inputs:local.attempt.inputs,inputEvidence:local.attempt.inputEvidence,stateRoot:row.parentHeader.stateRoot});
        const expected=modules.oracleRequests({request:projection.request,header:row.parentHeader});need(oracleWires.length<=expected.length,'Extra oracle reads');
        if(oracle.attempts){need(Array.isArray(oracle.attempts)&&oracle.attempts.length<=expected.length&&Array.isArray(oracle.transportDenied),'Oracle attempt ledger absent');let cursor=0,denied=0;for(let j=0;j<oracle.attempts.length;j++){const a=oracle.attempts[j],w=oracleWires[cursor];need(a.label===expected[j].label,'Oracle label/order differs');if(w&&w.request.method===expected[j].method&&equal(w.request.params,expected[j].params)){need(a.status===(w.status==='completed'?'returned':'failed')&&(w.status==='completed'?!own(a,'code'):a.code===w.error),'Oracle terminal status differs');cursor++;}else{const d=oracle.transportDenied[denied++];need(a.status==='failed'&&d&&d.method===expected[j].method&&d.code===a.code,'Oracle attempt has neither a wire nor admission denial');}}need(cursor===oracleWires.length&&denied===oracle.transportDenied.length,'Unjoined oracle attempts/denials');}else need(oracleWires.length===0&&oracle.dispatch==='budget_unattempted','Attempted oracle ledger absent');
        for(let j=0;j<oracleWires.length;j++)need(oracleWires[j].request.method===expected[j].method&&equal(oracleWires[j].request.params,expected[j].params),'Oracle request sequence differs');
        outcome=await modules.adjudicateLocalOutcome({transactionHash:row.transactionHash,request:projection.request,header:row.parentHeader,expectedLocalImplementation:plan.localImplementation,local,oracle});
      }
      need(equal(outcome,await p.read(`cases/${id}/outcome.json`))&&equal(compact(outcome),entry.adjudication),'Independent outcome recomputation differs');outcomes.push(outcome.outcome);outcomesRecomputed++;
    }
    const accounting=modules.accountCohortOutcomes(census.selection,outcomes);
    need(equal(interrupted?run.interruptedLedger:run.accounting,interrupted?accounting.ledger:accounting),'Denominator or accounting differs');
  }else need(results.caseRun===null&&selection.census===null&&results.status!=='complete','Failed selection manufactured a denominator');
  const unjoined=wires.filter(w=>!claimed.has(w.globalId));
  if(unjoined.length){
    // A fatal phase can fail before its wrapper is saved. Its raw suffix is
    // still hash/wire-audited, but is never claimed as joined execution input.
    const fatal=results.caseRun?.fatal,index=results.caseRun?.rows.findIndex(e=>e.id===fatal?.caseId),row=census?.selected[index];
    need(results.status==='interrupted'&&partialCases>0&&row&&unjoined.every(w=>w.globalId>Math.max(0,...claimed)&&w.profile==='local'&&((['eth_getProof','eth_getCode'].includes(w.request.method)&&equal(w.request.params.at(-1),{blockHash:row.parentBlockHash,requireCanonical:true}))||(w.request.method==='eth_getBlockByHash'&&w.request.params.length===2&&WORD.test(w.request.params[0])&&w.request.params[1]===false))),'Unjoined evidence is not a retained failed local-phase suffix');
  }
  const violation=results.timingViolation;
  if(violation){
    need(results.status!=='complete'&&(selection.status!=='complete'||(results.status==='interrupted'&&results.failures.some(f=>f.code===violation.code))),'Timing failure retained completed metrics');
    if(violation.code==='wait_overrun'){need(selection.status==='selection_failed'&&results.caseRun===null&&integer(violation.at)&&integer(violation.deadline)&&violation.at-violation.deadline===violation.overrunMs&&violation.overrunMs>plan.policy.maxWaitOverrunMs,'Wait failure differs');need(events.some(e=>e.kind==='wait_chunk_started'&&Date.parse(e.details.until)===violation.deadline),'Wait violation has no declared wait');}
    else if(violation.code==='phase_deadline')need(timings.some(t=>t.phase!=='run'&&!t.withinBudget&&equal(t,violation.timing)),'Phase violation lacks its retained terminal clocks');
    else if(violation.code==='absolute_deadline'){verifyTiming(violation.timing,'run',plan.policy.collectionAndExecutionMs);need(!violation.timing.withinBudget&&!results.timing.withinBudget&&violation.timing.startedAt===results.timing.startedAt,'Absolute deadline differs');}
    else need(violation.code==='clock_invalid'&&timings.some(t=>!t.clockValid),'Unknown or unsupported timing failure');
  }else need(timings.every(t=>t.withinBudget),'Late or invalid clocks lack terminal withholding');
  await verifyFrozenSources({outputDirectory:p.root,expectedManifestSha256:p.manifest.sourceManifestSha256});await verifyNodeRuntime(plan.runtime);
  return{status:'verified',reportStatus:results.status,expectedManifestSha256,sourceManifestSha256:p.manifest.sourceManifestSha256,planSha256:p.manifest.planSha256,
    sourceFiles:sources.manifest.filesCount,evidenceFiles:p.byPath.size,wires:wires.length,proofsVerified,census:census?.census.length??null,selected:census?.selected.length??null,outcomesRecomputed,partialCases,metricsAvailable:results.status==='complete',
    completeWireBinding:unjoined.length===0,unjoinedEvidenceWireIds:unjoined.map(w=>w.globalId),limitations:{newIndependentExecution:false,sourceSafetyAttested:false,providerContextExecutionAttested:false,consensusVerified:false,originalTransactionReplay:false,apiCoverage:false,economicCompleteness:false,unretainedObservedHashesVerified:summaries.every(s=>s.unretainedObservedHashVerified)}};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const[directory,hash]=process.argv.slice(2);need(directory&&hash,'Usage: verify.mjs DIR EVIDENCE_MANIFEST_SHA');
 console.log(JSON.stringify(await verifyEvidence({outputDirectory:directory,expectedManifestSha256:hash}),null,2));
}
