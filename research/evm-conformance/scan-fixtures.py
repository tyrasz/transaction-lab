#!/usr/bin/env python3
"""Bounded, no-execution scan of the publisher-digest-verified archive."""
import gzip,hashlib,io,json,pathlib,tarfile,time
BASE=pathlib.Path(__file__).resolve().parent; ARCH=pathlib.Path('/private/tmp/transaction-lab-execution-fixtures-v21.0.2.tar.gz'); CAP=8*1024**3
index=json.loads((BASE/'acquisition/osaka-state-index.json').read_text())
def family(path):
 if '/ported_static/stCallCodes/call_chain/' in path:return 'call_context_gas'
 if any(x in path for x in ['/berlin/eip2929_gas_cost_increases/warm_status_revert/','/berlin/eip2930_access_list/acl/','/istanbul/eip2200_net_gas_metering/','/prague/eip7623_increase_calldata_cost/refunds/','/cancun/eip1153_tstore/']):return 'storage_warm_cold_refund_rollback'
 if any(x in path for x in ['/frontier/identity_precompile/','/frontier/precompiles/','/byzantium/eip198_modexp_precompile/','/istanbul/eip152_blake2/','/osaka/eip7951_p256verify_precompiles/eip_mainnet/']):return 'non_kzg_precompile'
 return None
wanted={f'fixtures/{r["json_path"]}' for r in index['rows'] if family(r['json_path'])};(BASE/'candidates').mkdir(exist_ok=True)
class Counted(io.RawIOBase):
 def __init__(self,f):self.f=f;self.count=0
 def readable(self):return True
 def read(self,n=-1):
  if n<0:n=1024*1024
  n=min(n,CAP-self.count+1);data=self.f.read(n);self.count+=len(data)
  if self.count>CAP:raise RuntimeError('EXPANDED_SCAN_LIMIT')
  return data
started=time.monotonic();status='complete';error=None;files=0;saved=[];matched=[]
stream=Counted(gzip.open(ARCH,'rb'))
try:
 with tarfile.open(fileobj=stream,mode='r|') as archive,(BASE/'acquisition/member-inventory.ndjson').open('w') as inventory:
  for m in archive:
   files+=1;inventory.write(json.dumps({'path':m.name,'bytes':m.size,'type':m.type.decode()})+'\n')
   if time.monotonic()-started>900:raise RuntimeError('SCAN_DEADLINE')
   if m.name not in wanted:continue
   row={'archivePath':m.name,'bytes':m.size,'family':family(m.name)};matched.append(row)
   if not m.isfile() or m.size>8388608:row['status']='file_size_or_type_excluded';continue
   raw=archive.extractfile(m).read();row['sha256']=hashlib.sha256(raw).hexdigest();row['status']='retained_candidate'
   dest=BASE/'candidates'/m.name.removeprefix('fixtures/');dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(raw);saved.append(row)
except Exception as e:status='incomplete';error=str(e)
finally:
 report={'status':status,'error':error,'expandedBytesRead':stream.count,'membersSeen':files,'elapsedSeconds':time.monotonic()-started,'candidateSourcePaths':len(wanted),'matched':matched}
 (BASE/'acquisition/scan.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({k:v for k,v in report.items() if k!='matched'}))
