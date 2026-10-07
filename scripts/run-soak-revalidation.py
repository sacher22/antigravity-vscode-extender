"""Repeat corrected observation harness on unchanged production; retain first failure."""
import hashlib,json,os,pathlib,subprocess,sys,time
root=pathlib.Path(sys.argv[1]).resolve()
output=pathlib.Path(sys.argv[2]).resolve()
previous=pathlib.Path(sys.argv[3]).resolve()
output.mkdir(parents=True,exist_ok=False)
manifest=json.loads((root/'freeze-manifest.json').read_text())
original=json.loads((previous/'matrix.json').read_text())
def verify():
    for name,digest in manifest['files'].items():
        if hashlib.sha256((root/name).read_bytes()).hexdigest()!=digest:raise RuntimeError('Frozen file changed: '+name)
verify()
old_runtime={k:v for k,v in original['buildManifest']['files'].items() if k.startswith(('out/','media/'))}
new_runtime={k:v for k,v in manifest['files'].items() if k.startswith(('out/','media/'))}
if old_runtime!=new_runtime:raise RuntimeError('Production changed; rendering cases must rerun')
reused=[dict(case,evidenceReusedFrom=str(previous/'matrix.json')) for case in original['cases'] if case['name']!='soak-2h']
if len(reused)!=19 or any(case['exitCode']!=0 for case in reused):raise RuntimeError('Original 19 rendering/pipe cases not passed')
report={'status':'running','snapshot':str(root),'buildManifest':manifest,'cases':reused,'startedAt':time.time(),
  'note':'Original failed soak preserved. Exactly identical production runtime; 19 rendering/pipe cases reused, corrected soak rerun.'}
def save():
    temp=output/'matrix.json.tmp';temp.write_text(json.dumps(report,indent=2)+'\n');temp.replace(output/'matrix.json')
save()
try:
    started=time.monotonic()
    with (output/'soak-2h.txt').open('w') as log:
        proc=subprocess.run(['node',str(root/'scripts/benchmark-soak.cjs')],cwd=root,
          env={**os.environ,'AGY_SOAK_MS':'7200000','AGY_SOAK_BASELINE_MS':'60000','AGY_SOAK_OUTPUT':str(output/'soak-2h.json')},stdout=log,stderr=subprocess.STDOUT)
    result=json.loads((output/'soak-2h.json').read_text())
    case={'name':'soak-2h','exitCode':proc.returncode,'elapsedSeconds':time.monotonic()-started,'output':str(output/'soak-2h.json'),
      **{k:result.get(k) for k in ['status','actualContinuousMs','loops','errors','confirmedExitRaces','cleanup']}}
    report['cases'].append(case)
    verify()
    passed=proc.returncode==0 and result['status']=='passed' and result['actualContinuousMs']>=7200000 and result['cleanup']['ownLiveProcessCount']==0
    report['status']='passed' if passed else 'failures-recorded'
    report['completedAt']=time.time();save();print(json.dumps(case),flush=True)
except Exception as error:
    report['status']='failed';report['error']=str(error);save();raise
