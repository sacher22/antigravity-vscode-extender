"""Read-only acceptance probe: identities/config hashes and own-workspace CLI PIDs only."""
import argparse,hashlib,importlib.util,json,os,pathlib,re,zipfile
spec=importlib.util.spec_from_file_location('owned_comparison',pathlib.Path(__file__).with_name('benchmark-real-cli.py'))
comparison=importlib.util.module_from_spec(spec);spec.loader.exec_module(comparison)
identity=comparison.identity

def digest(data):return hashlib.sha256(data).hexdigest()
def processes(workspace):
    result=[]
    binary=pathlib.Path.home()/'.local/lib/antigravity-cli/agy'
    for folder in pathlib.Path('/proc').iterdir():
        if not folder.name.isdecimal():continue
        try:
            if folder.stat().st_uid!=os.getuid() or (folder/'cwd').resolve()!=workspace:continue
            if (folder/'exe').resolve()!=binary.resolve():continue
            fields=(folder/'stat').read_text().rsplit(')',1)[1].split()
            if fields[0] in ['Z','X']:continue
            argv=(folder/'cmdline').read_bytes().decode(errors='replace').split('\0')
            def option(key):
                if key not in argv:return None
                index=argv.index(key)+1
                return argv[index] if index<len(argv) else None
            result.append({'pid':int(folder.name),'startTicks':fields[19],'group':int(fields[2]),
                'cwd':str(workspace),'model':option('--model'),'mode':option('--mode'),
                'effort':option('--effort'),'danger':'--dangerously-skip-permissions' in argv,
                'stream':option('--output-format')=='stream-json', 'agent':option('--agent'),
                'conversationId':option('--conversation'),'inputStream':option('--input-format')=='stream-json',
                'directories':[argv[i+1] for i,a in enumerate(argv[:-1]) if a=='--add-dir'],
                'sandbox':'--sandbox' in argv,'schema':option('--json-schema')})
        except (FileNotFoundError,ProcessLookupError,PermissionError):continue
    return result
def main():
    parser=argparse.ArgumentParser();parser.add_argument('workspace');parser.add_argument('--installation',action='store_true')
    parser.add_argument('--fixture-state',action='store_true');parser.add_argument('--conversation');parser.add_argument('--public-marker')
    args=parser.parse_args();workspace=pathlib.Path(args.workspace).resolve()
    allowed=pathlib.Path.home()/'.local/share/antigravity-extender-delegation'
    if workspace.parent!=allowed or not workspace.name.startswith('agy-2.5-real-pilot-'):
        raise ValueError('Workspace is not this owned acceptance fixture')
    report={'config':identity(workspace),'processes':processes(workspace)}
    if args.fixture_state:
        state={}
        plan=workspace/'acceptance-plan-output.txt'
        state['planOutputExists']=plan.exists()
        if plan.exists():state['planOutputSha256']=digest(plan.read_bytes())
        marker=workspace/'acceptance-stop.json'
        if marker.exists():
            tool=json.loads(marker.read_text())
            if tool.get('token')!='OWNED_STOP_250' or tool.get('workspace')!=str(workspace) or tool.get('uid')!=os.getuid():
                raise RuntimeError('Owned stop fixture identity mismatch')
            if not isinstance(tool.get('pid'),int) or tool['pid']<=0:raise RuntimeError('Invalid fixture PID')
            folder=pathlib.Path('/proc')/str(tool['pid']);alive=False
            try:
                fields=(folder/'stat').read_text().rsplit(')',1)[1].split()
                alive=fields[19]==tool['startTicks'] and fields[0] not in ['Z','X']
                if alive and ((folder/'cwd').resolve()!=workspace or folder.stat().st_uid!=os.getuid()):
                    raise RuntimeError('Live stop fixture no longer matches ownership')
            except FileNotFoundError:pass
            state['tool']={'pid':tool['pid'],'group':tool['group'],'startTicks':tool['startTicks'],'alive':alive}
        report['fixtureState']=state
    if args.public_marker is not None:
        if not re.fullmatch(r'TUI_RETURN_250_[A-Za-z0-9_]{1,80}',args.public_marker):raise ValueError('Invalid owned marker')
        if not isinstance(args.conversation,str) or not re.fullmatch(r'[a-f0-9-]{36}',args.conversation):raise ValueError('Invalid native conversation')
        if not any(p['conversationId']==args.conversation and not p['stream'] for p in report['processes']):
            raise RuntimeError('This native conversation is not live in the owned fixture')
        brain=pathlib.Path.home()/'.gemini/antigravity-cli/brain'
        folder=brain/args.conversation/'.system_generated/logs';file=folder/'transcript.jsonl'
        if file.resolve().parent!=folder.absolute() or file.stat().st_size>4*1024*1024:
            raise RuntimeError('Owned native transcript identity/size invalid')
        raw=file.read_text();user=assistant=0
        for line in raw.splitlines(keepends=True):
            if not line.endswith('\n'):continue
            try:e=json.loads(line)
            except ValueError:continue
            if not isinstance(e,dict) or e.get('status')!='DONE' or not isinstance(e.get('content'),str):continue
            if e.get('source') in ['USER_EXPLICIT','USER'] and e.get('type')=='USER_INPUT' and args.public_marker in e['content']:user+=1
            if e.get('source')=='MODEL' and e.get('type')=='PLANNER_RESPONSE' and e['content'].strip()==args.public_marker:assistant+=1
        report['nativePublicMarker']={'userRecords':user,'assistantRecords':assistant,'ready':user>=1 and assistant>=1}
    if args.installation:
        repo=pathlib.Path(__file__).resolve().parents[1]
        vsix=repo/'diagnostics/antigravity-vscode-extender-2.5.0-candidate.vsix'
        installed=pathlib.Path.home()/'.vscode-server/extensions/antigravity.antigravity-vscode-extender-2.5.0'
        hashes={}
        with zipfile.ZipFile(vsix) as package:
            for name in package.namelist():
                if name.startswith('extension/out/') and name.endswith('.js') or name in ['extension/media/chat.js','extension/media/chat.css']:
                    relative=name.removeprefix('extension/');expected=digest(package.read(name));actual=digest((installed/relative).read_bytes())
                    if actual!=expected:raise RuntimeError('Installed runtime differs from candidate')
                    hashes[relative]=actual
        if len(hashes)!=63:raise RuntimeError('Candidate runtime file set changed')
        if json.loads((installed/'package.json').read_text())['version']!='2.5.0':raise RuntimeError('Installed version mismatch')
        report['installation']={'path':str(installed),'version':'2.5.0','runtimeHashes':hashes,'candidateSha256':digest(vsix.read_bytes())}
    print(json.dumps(report))
if __name__=='__main__':main()
