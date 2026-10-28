#!/usr/bin/env python3
"""Offline retained-input audit. Optional full archive is required to recheck release membership."""
import argparse,base64,gzip,hashlib,json,pathlib,tarfile
BASE=pathlib.Path(__file__).resolve().parent
sha=lambda b:hashlib.sha256(b).hexdigest()
p=argparse.ArgumentParser();p.add_argument('--archive',type=pathlib.Path);args=p.parse_args()
manifest=json.loads((BASE/'acquisition-manifest.json').read_text())
for row in manifest['files']:
 raw=(BASE/row['path']).read_bytes();assert len(raw)==row['bytes'] and sha(raw)==row['sha256']
lock=json.loads((BASE/'source/engines/fixture-evm/package-lock.json').read_text());record=json.loads((BASE/'acquisition/dependencies/records.json').read_text());packages={k:v for k,v in lock['packages'].items() if k};assert set(packages)=={r['packagePath'] for r in record['records']};dependency_files=0
for row in record['records']:
 meta=packages[row['packagePath']];raw=(BASE/f'acquisition/dependencies/{row["index"]:02d}.tgz').read_bytes();alg,integrity=meta['integrity'].split('-',1);assert base64.b64encode(hashlib.new(alg,raw).digest()).decode()==integrity;assert sha(raw)==row['sha256'];dest=BASE/'source/engines/fixture-evm'/row['packagePath'];paths=[]
 with tarfile.open(BASE/f'acquisition/dependencies/{row["index"]:02d}.tgz','r:gz') as t:
  for m in t:
   path=pathlib.PurePosixPath(m.name);assert path.parts[0]=='package' and '..' not in path.parts and not path.is_absolute();assert m.isfile() or m.isdir()
   if not m.isfile():continue
   rel=pathlib.Path(*path.parts[1:]);paths.append(str(rel));assert (dest/rel).read_bytes()==t.extractfile(m).read();dependency_files+=1
 assert set(paths)=={str(f.relative_to(dest)) for f in dest.rglob('*') if f.is_file()}
scan=json.loads((BASE/'acquisition/scan-v2.json').read_text());candidates={r['archivePath']:r for r in scan['matched'] if r['status']=='retained_candidate'}
for name,row in candidates.items():
 raw=(BASE/'candidates'/name.removeprefix('fixtures/')).read_bytes();assert len(raw)==row['bytes'] and sha(raw)==row['sha256']
full=False
if args.archive:
 h=hashlib.sha256();n=0
 with args.archive.open('rb') as f:
  for chunk in iter(lambda:f.read(1048576),b''):h.update(chunk);n+=len(chunk);assert n<=1073741824
 assert n==939189561 and h.hexdigest()=='e2fa7ea2ea516459f9ab92284b2927892f318f4e1f78ca802cb05a6c3b479ed9'
 expected=(BASE/'acquisition/member-inventory-v2.ndjson').read_text().splitlines();seen=0;matched=set();index=json.loads((BASE/'acquisition/osaka-state-index.json').read_text())
 with tarfile.open(args.archive,'r|gz') as t:
  for m in t:
   assert seen<len(expected);assert {'path':m.name,'bytes':m.size,'type':m.type.decode()}==json.loads(expected[seen]);seen+=1;assert m.offset+m.size<=64*1024**3
   if m.name=='fixtures/.meta/index.json':
    raw=t.extractfile(m).read();assert len(raw)==index['sourceIndexBytes'] and sha(raw)==index['sourceIndexSha256'];official=json.loads(raw);assert [r for r in official['test_cases'] if r['format']=='state_test' and r['fork']=='Osaka']==index['rows']
   elif m.name in candidates:
    raw=t.extractfile(m).read();assert sha(raw)==candidates[m.name]['sha256'];matched.add(m.name)
 assert seen==len(expected) and matched==set(candidates);full=True
print(json.dumps({'retainedManifestFilesVerified':len(manifest['files']),'lockedDependencyTarballsVerified':len(packages),'archivedDependencyFilesByteCompared':dependency_files,'retainedCandidateFilesVerified':len(candidates),'fullReleaseArchiveDigestAndMembershipRecomputed':full,'limitation':None if full else 'Full archive omitted: publisher archive digest, complete inventory and fixture archive membership remain recorded acquisition claims, not recomputed from retained subset.'},indent=2))
