"""Run acceptance against an explicit immutable snapshot; never build/reload/install."""
import hashlib,json,os,pathlib,subprocess,sys,time
root=pathlib.Path(sys.argv[1]).resolve()
output=pathlib.Path(sys.argv[2]).resolve()
output.mkdir(parents=True,exist_ok=False)
manifest=json.loads((root/'freeze-manifest.json').read_text())
def verify():
    for name,digest in manifest['files'].items():
        if hashlib.sha256((root/name).read_bytes()).hexdigest()!=digest:
            raise RuntimeError('Frozen input changed: '+name)
verify()
report={'status':'running','snapshot':str(root),'buildManifest':manifest,'cases':[],'startedAt':time.time()}
def save():
    temporary=output/'matrix.json.tmp'
    temporary.write_text(json.dumps(report,indent=2)+'\n')
    temporary.replace(output/'matrix.json')
save()
scenes=[('base',{}),('million-plain',{'AGY_SUSTAINED_INITIAL_CHARS':'1000000','AGY_SUSTAINED_COMPLETE':'1'}),('million-markdown',{'AGY_SUSTAINED_INITIAL_CHARS':'1000000','AGY_SUSTAINED_COMPLETE':'1','AGY_SUSTAINED_CONTENT':'markdown'}),('million-closed-code',{'AGY_SUSTAINED_INITIAL_CHARS':'1000000','AGY_SUSTAINED_COMPLETE':'1','AGY_SUSTAINED_CONTENT':'code'}),('million-unclosed-code',{'AGY_SUSTAINED_INITIAL_CHARS':'1000000','AGY_SUSTAINED_COMPLETE':'1','AGY_SUSTAINED_CONTENT':'unclosed-code'})]
def run(name,script,variables,scope):
    verify()
    target=output/(name+'.json')
    env={**os.environ,**variables}
    start=time.monotonic()
    with (output/(name+'.txt')).open('w') as log:
        completed=subprocess.run(['node','--expose-gc',str(root/'scripts'/script)],cwd=root,env=env,stdout=log,stderr=subprocess.STDOUT)
    case={'name':name,'scope':scope,'exitCode':completed.returncode,'elapsedSeconds':time.monotonic()-start,'output':str(target)}
    if target.exists():
        result=json.loads(target.read_text())
        for key in ['samples','p95Ms','inputP95Ms','completionLongTaskMaxMs','stopMs','stopMeasurements','status','actualContinuousMs','loops','cleanup','errors']:
            if key in result:case[key]=len(result[key]) if key=='samples' and isinstance(result[key],list) else result[key]
    report['cases'].append(case);save()
    print(json.dumps(case),flush=True)
for scene,variables in scenes:
    for index in range(1,4):
        name=scene+'-'+str(index)
        run(name,'benchmark-sustained.cjs',{'AGY_BENCHMARK_PROVIDER':'1','AGY_SUSTAINED_TOOLS':'1','AGY_BENCHMARK_RESOURCES':'1','AGY_BENCHMARK_OUTPUT':str(output/(name+'.json')),**variables},'final deterministic rendering; 1000+ samples')
if os.environ.get('AGY_FINAL_RICH')=='1':
    for index in range(1,4):
        name='million-rich-markdown-'+str(index)
        run(name,'benchmark-sustained.cjs',{'AGY_BENCHMARK_PROVIDER':'1','AGY_SUSTAINED_TOOLS':'1','AGY_BENCHMARK_RESOURCES':'1','AGY_BENCHMARK_OUTPUT':str(output/(name+'.json')),'AGY_SUSTAINED_INITIAL_CHARS':'1000000','AGY_SUSTAINED_COMPLETE':'1','AGY_SUSTAINED_CONTENT':'markdown','AGY_SUSTAINED_RICH':'1'},'final rich Markdown 32 sections; 1000+ samples, selection/links/completion')
for name,variables in [('upper-tools-background-agents',{'AGY_SUSTAINED_TOOL_COUNT':'10000','AGY_SUSTAINED_OUTPUT_BYTES':'160000000','AGY_SUSTAINED_BACKGROUNDS':'10','AGY_SUSTAINED_AGENTS':'100'}),('history-1000',{'AGY_SUSTAINED_HISTORIES':'1000'}),('history-10000',{'AGY_SUSTAINED_HISTORIES':'10000'})]:
    run(name,'benchmark-sustained.cjs',{'AGY_BENCHMARK_PROVIDER':'1','AGY_SUSTAINED_TOOLS':'1','AGY_BENCHMARK_RESOURCES':'1','AGY_BENCHMARK_OUTPUT':str(output/(name+'.json')),**variables},'exploratory upper load; metadata histories are in-memory')
run('real-pipe','benchmark-real-pipe.cjs',{'AGY_PIPE_OUTPUT':str(output/'real-pipe.json')},'real stdout backpressure and blocked storage, all tool originals')
report['renderMatrixCompletedAt']=time.time();save()
if os.environ.get('AGY_MATRIX_SKIP_SOAK')!='1':
    run('soak-2h','benchmark-soak.cjs',{'AGY_SOAK_MS':'7200000','AGY_SOAK_BASELINE_MS':'60000','AGY_SOAK_OUTPUT':str(output/'soak-2h.json')},'complete 2h Provider/service/Chromium/CLI resources; idle+hidden 60s each')
verify()
report['status']=('rendering-passed-awaiting-separate-soak' if os.environ.get('AGY_MATRIX_SKIP_SOAK')=='1' else 'passed') if all(case['exitCode']==0 for case in report['cases']) else 'failures-recorded'
report['completedAt']=time.time();save()
