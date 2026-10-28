#!/usr/bin/env python3
"""Exact lock only: no npm resolution, install scripts, retries or moving versions."""
import base64, hashlib, json, pathlib, tarfile, time, urllib.request
ROOT=pathlib.Path(__file__).resolve().parents[2]; PKG=ROOT/'engines/fixture-evm'; OUT=pathlib.Path(__file__).resolve().parent/'acquisition/dependencies'
OUT.mkdir(parents=True,exist_ok=True)
started=time.monotonic(); total=0; expanded=0; records=[]
lock=json.loads((PKG/'package-lock.json').read_text()); packages=[(k,v) for k,v in lock['packages'].items() if k]
assert len(packages)<=24
try:
 for i,(name,p) in enumerate(packages):
  assert time.monotonic()-started<180
  url=p['resolved'];assert url.startswith('https://registry.npmjs.org/')
  row={'index':i+1,'packagePath':name,'version':p['version'],'url':url,'integrity':p['integrity']};records.append(row)
  target=OUT/f'{i+1:02d}.tgz'
  with urllib.request.urlopen(url,timeout=25) as resp, target.open('xb') as f:
   row['status']=resp.status;row['headers']=dict(resp.headers);n=0
   while chunk:=resp.read(65536):
    n+=len(chunk);total+=len(chunk)
    assert n<=8388608 and total<=33554432 and time.monotonic()-started<180
    f.write(chunk)
  raw=target.read_bytes();alg,want=p['integrity'].split('-',1);assert alg in ('sha512','sha1')
  assert base64.b64encode(hashlib.new(alg,raw).digest()).decode()==want
  row.update(bytes=len(raw),sha256=hashlib.sha256(raw).hexdigest(),verifiedIntegrity=True)
  dest=PKG/name;dest.mkdir(parents=True,exist_ok=False)
  with tarfile.open(target,'r:gz') as archive:
   for m in archive:
    path=pathlib.PurePosixPath(m.name);assert path.parts[0]=='package' and '..' not in path.parts and not path.is_absolute()
    out=dest.joinpath(*path.parts[1:]);assert m.isdir() or m.isfile()
    if m.isdir():out.mkdir(parents=True,exist_ok=True);continue
    expanded+=m.size;assert expanded<=67108864 and m.size<=8388608
    out.parent.mkdir(parents=True,exist_ok=True);out.write_bytes(archive.extractfile(m).read());out.chmod(0o755 if m.mode&0o111 else 0o644)
finally:
 (OUT/'records.json').write_text(json.dumps({'schemaVersion':1,'elapsedSeconds':time.monotonic()-started,'receivedBytes':total,'expandedBytes':expanded,'records':records},indent=2)+'\n')
print(json.dumps({'packages':len(records),'receivedBytes':total,'expandedBytes':expanded}))
