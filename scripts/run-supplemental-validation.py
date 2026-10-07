"""Sequence remaining fixed-runtime probes after the verified full-soak wrapper exits."""
import hashlib,json,os,pathlib,subprocess,sys,time

snapshot=pathlib.Path(sys.argv[1]).resolve()
repo=pathlib.Path(sys.argv[2]).resolve()
output=pathlib.Path(sys.argv[3]).resolve()
output.mkdir(parents=True,exist_ok=False)
manifest=json.loads((snapshot/'supplemental-manifest.json').read_text())
matrix_directory=pathlib.Path(sys.argv[4]).resolve() if len(sys.argv)>4 else repo/'diagnostics/optimization-2.5-final-matrix'
wait_pid=int(sys.argv[5]) if len(sys.argv)>5 else 104643
wait_ticks=sys.argv[6] if len(sys.argv)>6 else '7054507'
independent=len(sys.argv)>7 and sys.argv[7]=='--independent'
report={'status':'waiting-for-original-soak','snapshot':str(snapshot),'manifest':manifest,'cases':[],
        'matrixDirectory':str(matrix_directory),'waitIdentity':{'pid':wait_pid,'startTicks':wait_ticks},'startedAt':time.time(),
        'mode':'independent-validation' if independent else 'after-soak','releaseGateDeferred':independent}
def save():
    temporary=output/'report.json.tmp'
    temporary.write_text(json.dumps(report,indent=2)+'\n')
    temporary.replace(output/'report.json')
def verify():
    for category in ['runtimeFiles','validationScripts']:
        for name,digest in manifest[category].items():
            if hashlib.sha256((snapshot/name).read_bytes()).hexdigest()!=digest:
                raise RuntimeError('Supplemental frozen input changed: '+name)
def wrapper_live():
    try:
        fields=pathlib.Path(f'/proc/{wait_pid}/stat').read_text().rsplit(')',1)[1].split()
        return fields[19]==wait_ticks and fields[0] not in ['Z','X']
    except FileNotFoundError:return False
def run(name,command,cwd,env=None,summary_keys=()):
    verify()
    started=time.monotonic()
    with (output/(name+'.txt')).open('w') as log:
        result=subprocess.run(command,cwd=cwd,env={**os.environ,**(env or {})},stdout=log,stderr=subprocess.STDOUT)
    case={'name':name,'exitCode':result.returncode,'elapsedSeconds':time.monotonic()-started}
    target=output/(name+'.json')
    if target.exists():
        data=json.loads(target.read_text())
        case.update({key:data[key] for key in summary_keys if key in data})
    report['cases'].append(case);save();print(json.dumps(case),flush=True)
try:
    verify();save()
    if not independent:
        while wrapper_live():time.sleep(10)
        matrix=json.loads((matrix_directory/'matrix.json').read_text())
        soak=json.loads((matrix_directory/'soak-2h.json').read_text())
        if matrix['status']!='passed' or soak['status']!='passed' or soak['actualContinuousMs']<7200000:
            raise RuntimeError('Original soak final gate did not pass; no speculative replacement')
        report['originalSoak']={key:soak[key] for key in ['status','actualContinuousMs','loops','cleanup']}
    report['status']='running';save()
    for index in range(1,4):
        name='million-rich-markdown-'+str(index)
        run(name,['node','--expose-gc',str(snapshot/'scripts/benchmark-sustained.cjs')],snapshot,
            {'AGY_BENCHMARK_PROVIDER':'1','AGY_SUSTAINED_TOOLS':'1','AGY_BENCHMARK_RESOURCES':'1',
             'AGY_SUSTAINED_INITIAL_CHARS':'1000000','AGY_SUSTAINED_CONTENT':'markdown',
             'AGY_SUSTAINED_RICH':'1','AGY_SUSTAINED_COMPLETE':'1','AGY_BENCHMARK_OUTPUT':str(output/(name+'.json'))},
            ['samples','p95Ms','inputP95Ms','completionLongTaskMaxMs','stopMeasurements','errors'])
    run('disk-startup',['node',str(snapshot/'scripts/benchmark-startup.cjs')],snapshot,
        {'AGY_STARTUP_OUTPUT':str(output/'disk-startup.json')},['environment','runs'])
    run('agent-panel',['node',str(snapshot/'scripts/benchmark-agent-panel.cjs')],snapshot,
        {'AGY_AGENT_PANEL_OUTPUT':str(output/'agent-panel.json')},['status','cleanup','error'])
    run('typecheck',['node',str(repo/'node_modules/typescript/bin/tsc'),'--noEmit','-p',str(repo)],repo)
    # Direct test runner deliberately avoids npm test's compile/clean step.
    tests=sorted(str(p) for p in (repo/'test').glob('*.test.js'))
    run('full-regression',['node','--test',*tests],repo)
    run('terminal-decoder',['python3',str(repo/'test/terminalScreen.test.py')],repo)
    run('package-check',['node',str(repo/'scripts/check-package-content.cjs')],repo)
    verify();report['status']=('validation-passed-awaiting-soak' if independent else 'passed') if all(case['exitCode']==0 for case in report['cases']) else 'failures-recorded'
    report['completedAt']=time.time();save()
except Exception as error:
    report['status']='failed';report['error']=str(error);save();raise
