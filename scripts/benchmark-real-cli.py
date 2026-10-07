"""Explicit native/Stream-JSON comparison in an owned workspace; no config writes.
Run only after deterministic rendering measurement finishes. Sidebar uses same manifest.
"""
import argparse,fcntl,hashlib,json,os,pathlib,pty,re,select,signal,struct,subprocess,termios,time
from terminal_screen import TerminalScreen
CLI='/home/ubuntu/.local/bin/agy'
BINARY='/home/ubuntu/.local/lib/antigravity-cli/agy'
ANSI=re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b_[\s\S]*?\x1b\\')
PROMPTS={
 'short':('Reply exactly SHORT_DONE_250. Do not use tools, files, commands or agents.','SHORT_DONE_250'),
 'read':('For this user request read input.txt exactly once using view_file, then reply exactly READ_DONE_250 and stop. Do not repeat the read after a tool result, write files, run commands or start agents.','READ_DONE_250'),
 'tool':('In this approved isolated workspace use run_command to execute exactly: printf BASIC_TOOL_DATA > tool-output.txt . Read tool-output.txt then reply exactly TOOL_DONE_250. No other files, commands or agents.','TOOL_DONE_250')}
def digest(p):return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
def redact_trace(text):
 cfg=json.loads((pathlib.Path.home()/'.gemini/antigravity-cli/api-config.json').read_text())
 for value in [cfg.get('api_key'),os.environ.get('GEMINI_API_KEY')]:
  if isinstance(value,str) and value.strip():text=text.replace(value.strip(),'[redacted]')
 return text
def identity(workspace):
 cfg=json.loads((pathlib.Path.home()/'.gemini/antigravity-cli/api-config.json').read_text())
 interface={'base':cfg['base_url'].rstrip('/'),'key':(os.environ.get('GEMINI_API_KEY') or cfg['api_key']).strip()}
 return {'model':'gemini-3.8-flash-high','effort':'high','permission':'Danger',
  'launcherIdentity':digest(CLI)+':'+digest(pathlib.Path.home()/'.local/bin/agy-gemini'),
  'cliVersion':subprocess.check_output([CLI,'--version'],text=True,timeout=10).strip(),
  'binaryHash':digest(BINARY),'workspace':str(workspace),
  'interfaceFingerprint':hashlib.sha256(json.dumps(interface,sort_keys=True).encode()).hexdigest()}
def stop(p):
 # This Popen owns a new POSIX group; never target an existing user process.
 if p.poll() is None:
  try:os.killpg(p.pid,signal.SIGTERM)
  except ProcessLookupError:pass
 try:p.wait(timeout=3)
 except subprocess.TimeoutExpired:
  try:os.killpg(p.pid,signal.SIGKILL)
  except ProcessLookupError:pass
  p.wait(timeout=3)
 # Confirm no live own-group members; zombies have exited.
 for folder in pathlib.Path('/proc').iterdir():
  if folder.name.isdecimal():
   try:
    fields=(folder/'stat').read_text().rsplit(')',1)[1].split()
    if int(fields[2])==p.pid and fields[0] not in ['Z','X']:raise RuntimeError('Own process group still live')
   except (FileNotFoundError,ProcessLookupError):pass
class Session:
 def __init__(self,kind,workspace,prompt):
  self.kind=kind;self.buffer=b'';self.pending=[];self.start=time.monotonic()
  args=[CLI,'--model','gemini-3.8-flash-high','--dangerously-skip-permissions','--mode','accept-edits','--new-project','--add-dir',str(workspace)]
  if kind=='native':
   self.native_screen=TerminalScreen()
   self.fd,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',60,300,0,0))
   self.process=subprocess.Popen(args+['-i='+prompt],cwd=workspace,stdin=slave,stdout=slave,stderr=slave,start_new_session=True,env={**os.environ,'TERM':'xterm-256color','NO_COLOR':'1'});os.close(slave)
   until=time.monotonic()+30
   while prompt not in self.native_screen.text():
    if time.monotonic()>until:raise TimeoutError('Native composer startup timeout')
    self.buffer+=self.read(.1)
  else:
   self.process=subprocess.Popen(args+['--output-format','stream-json','--input-format','stream-json'],cwd=workspace,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,start_new_session=True)
   self.fd=self.process.stdout.fileno();until=time.monotonic()+30
   while True:
    event=self.event(until)
    if event.get('event')=='init':
     self.init=event.get('init',{})
     if self.init.get('model')!='gemini-3.8-flash-high' or self.init.get('cwd')!=str(workspace) or self.init.get('permission_mode')!='always-proceed':raise RuntimeError('Actual CLI init mismatch')
     break
  self.startup_ms=(time.monotonic()-self.start)*1000
 def read(self,timeout):
  if select.select([self.fd],[],[],max(0,timeout))[0]:
   try:data=os.read(self.fd,65536)
   except OSError:data=b''
   if not data:raise RuntimeError('Owned CLI exited or pipe closed')
   if self.kind=='native':
    self.native_screen.feed(data)
    for query,reply in [(b'\x1b[c',b'\x1b[?1;2c'),(b'\x1b[?2026$p',b'\x1b[?2026;2$y'),(b'\x1b[?2027$p',b'\x1b[?2027;2$y')]:
     if query in data:os.write(self.fd,reply)
   return data
  if self.process.poll() is not None:raise RuntimeError('Owned CLI exited')
  return b''
 def event(self,deadline):
  while b'\n' not in self.buffer:
   if time.monotonic()>deadline:raise TimeoutError('Stream protocol deadline')
   self.buffer+=self.read(min(.1,deadline-time.monotonic()))
  line,self.buffer=self.buffer.split(b'\n',1)
  try:return json.loads(line)
  except ValueError:return {}
 def turn(self,prompt,marker,first=False):
  start=time.monotonic();deadline=start+180;tools=[]
  if self.kind=='native':
   if not first:os.write(self.fd,prompt.encode());time.sleep(.15)
   self.buffer=b'';start=time.monotonic();os.write(self.fd,b'\r')
   while time.monotonic()<deadline:
    self.buffer+=self.read(.1)
    if len(self.buffer)>4*1024*1024:raise RuntimeError('Native public output observation budget')
    text=self.native_screen.text()
    if self.native_screen.answer_ready(marker):
     visible_ms=(time.monotonic()-start)*1000
     self.last_public_tui=text
     cards={'read':bool(re.search(r'[●○] Read\([^\n]*input\.txt\)',text)),
       'command':bool(re.search(r'[●○] Bash\(printf BASIC_TOOL_DATA > tool-output\.txt\)',text)),
       'toolRead':bool(re.search(r'[●○] Read\([^\n]*tool-output\.txt\)',text))}
     return {'durationMs':visible_ms,'nativeFinalReadyAnswerUpperBoundMs':visible_ms,'readyMs':(time.monotonic()-start)*1000,'nativeToolCards':cards,'visibleMarker':marker,'tuiObservationSha256':hashlib.sha256(self.buffer).hexdigest()}
   raise TimeoutError('Native answer not observed')
  self.process.stdin.write((json.dumps({'event':'user','message':{'content':[{'type':'text','text':prompt}]}})+'\n').encode());self.process.stdin.flush();first_text=None;response=''
  while True:
   event=self.event(deadline)
   step=event.get('step_update',{})
   if event.get('event')=='step_update':
    if step.get('step_type')=='agent_response' and step.get('text_delta'):
     if first_text is None:first_text=time.monotonic()
     response+=step['text_delta']
    if step.get('step_type')=='tool':tools.append(step.get('tool_name'))
   if event.get('event')=='result':
    result=event['result']
    if result.get('status')!='SUCCESS' or marker not in response:raise RuntimeError('Stream response/result validation failed')
    return {'durationMs':((first_text or time.monotonic())-start)*1000,'resultMs':(time.monotonic()-start)*1000,'toolNames':sorted(set(x for x in tools if isinstance(x,str))),'cliId':result.get('conversation_id'),'usage':result.get('usage')}
 def close(self):
  if hasattr(self,'process'):stop(self.process)
  if self.kind=='native' and hasattr(self,'fd'):os.close(self.fd)
def main():
 parser=argparse.ArgumentParser();parser.add_argument('workspace');parser.add_argument('output');args=parser.parse_args()
 workspace=pathlib.Path(args.workspace).resolve();output=pathlib.Path(args.output).resolve()
 workspace.mkdir(parents=True,exist_ok=True);output.mkdir(parents=True,exist_ok=False)
 (workspace/'input.txt').write_text('BASIC_FILE_DATA\n')
 config=identity(workspace)
 if config['cliVersion']!='1.2.16':raise RuntimeError('Protocol identity requires new audit')
 report={'config':config,'prompts':PROMPTS,'rows':[],'status':'running','notes':['Native duration is an observed public answer marker in pyte reconstructed PTY screen, not physical pixels. Native final-ready answer is an upper bound on public answer visibility; visible thinking markers alone do not count. ANSI-stripped raw bytes cannot reconstruct cursor-managed output; file/tool payload markers differ to avoid confusing tool output. Tool evidence must be independently inspected before acceptance; prompt echoes of filenames are not proof of tools. Restricted own fixture native public terminal traces are retained locally, not printed as tool output. Stream metric is first protocol response event, not model first token. Warm uses a discarded initial turn and a unique per-round marker so TUI redraw of old answers cannot satisfy a new sample. Startup reported separately.']}
 def save():
  tmp=output/'report.json.tmp';tmp.write_text(json.dumps(report,indent=2)+'\n');tmp.replace(output/'report.json')
 save()
 for kind in ['native','stream']:
  for scene,(base_prompt,base_marker) in PROMPTS.items():
   for temperature in ['cold','warm']:
    session=None
    try:
     for index in range(1,6):
      marker=base_marker+'_'+str(index);prompt=base_prompt.replace(base_marker,marker)
      row={'path':kind,'scene':scene,'temperature':temperature,'index':index,'metric':'submit-to-first-response-event' if kind=='stream' else 'submit-to-visible','config':config,'status':'failed'};started=time.monotonic()
      try:
       if identity(workspace)!=config:raise RuntimeError('Configuration identity changed')
       if session is None:
        # Allocate first so constructor failure still has an owned process cleanup path.
        initial_marker=base_marker+'_WARMUP' if temperature=='warm' else marker
        initial_prompt=base_prompt.replace(base_marker,initial_marker)
        session=Session.__new__(Session);session.__init__(kind,workspace,initial_prompt)
        if temperature=='warm':session.turn(initial_prompt,initial_marker,first=True);time.sleep(.5)
       row['processPid']=session.process.pid
       row.update(session.turn(prompt,marker,first=temperature=='cold'))
       if kind=='native':
        trace=output/(scene+'-'+temperature+'-'+str(index)+'-native.txt');trace.write_text(redact_trace(session.last_public_tui));trace.chmod(0o600);row['nativePublicTrace']=str(trace)
        raw=output/(scene+'-'+temperature+'-'+str(index)+'-native-raw.txt');raw.write_text(redact_trace(session.buffer.decode(errors='replace')));raw.chmod(0o600);row['nativeRawTrace']=str(raw)
       row['startupMs']=session.startup_ms if temperature=='cold' else 0
       if kind=='stream':row['actualInit']={key:session.init.get(key) for key in ['model','cwd','permission_mode','agent']}
       if kind=='native' and scene=='read' and not row['nativeToolCards']['read']:raise RuntimeError('Native Read card not observed')
       if kind=='native' and scene=='tool' and not (row['nativeToolCards']['command'] and row['nativeToolCards']['toolRead']):raise RuntimeError('Native Bash/Read cards not observed')
       if kind=='stream' and scene=='read' and not any(name in row['toolNames'] for name in ['view_file','read_file']):raise RuntimeError('Read tool not observed')
       if kind=='stream' and scene=='tool' and 'run_command' not in row['toolNames']:raise RuntimeError('Command tool not observed')
       if scene=='tool' and (workspace/'tool-output.txt').read_text()!='BASIC_TOOL_DATA':raise RuntimeError('Tool file result mismatch')
       row['status']='passed'
      except Exception as error:
       row.update(durationMs=(time.monotonic()-started)*1000,errorClass=type(error).__name__)
       if kind=='native' and session is not None and hasattr(session,'buffer'):
        try:
         trace=output/(scene+'-'+temperature+'-'+str(index)+'-failed-native.txt');trace.write_text(redact_trace(session.native_screen.text()));trace.chmod(0o600);row['nativePublicTrace']=str(trace)
         raw=output/(scene+'-'+temperature+'-'+str(index)+'-failed-native-raw.txt');raw.write_text(redact_trace(session.buffer.decode(errors='replace')));raw.chmod(0o600);row['nativeRawTrace']=str(raw)
        except Exception as trace_error:row['traceSaveErrorClass']=type(trace_error).__name__
      finally:
       if session is not None and (temperature=='cold' or row['status']=='failed'):
        session.close();session=None;row['ownProcessGroupExited']=True
       report['rows'].append(row);save();print(json.dumps({key:row.get(key) for key in ['path','scene','temperature','index','status','durationMs','errorClass']}),flush=True)
    finally:
     if session is not None:session.close()
 report['status']='passed' if all(row['status']=='passed' for row in report['rows']) else 'failures-recorded';save()
if __name__=='__main__':main()
