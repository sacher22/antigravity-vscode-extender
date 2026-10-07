import os,pty,fcntl,termios,struct,subprocess,select,time,re,json,signal
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROMPT='Reply exactly BENCHPASS. Do not use tools.'
ARGS=['agy','--model','gemini-3.8-flash-high','--dangerously-skip-permissions','--mode','accept-edits','--new-project','--add-dir',ROOT]
ansi=re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b_[\s\S]*?\x1b\\')
def stop(p):
 try:os.killpg(p.pid,signal.SIGTERM);p.wait(timeout=2)
 except (ProcessLookupError,subprocess.TimeoutExpired):
  try:os.killpg(p.pid,signal.SIGKILL)
  except ProcessLookupError:pass
  p.wait()
def native(turns):
 master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',40,120,0,0))
 launch=time.monotonic();p=subprocess.Popen(ARGS+['-i='+PROMPT],cwd=ROOT,stdin=slave,stdout=slave,stderr=slave,start_new_session=True,env={**os.environ,'TERM':'xterm-256color','NO_COLOR':'1'});os.close(slave);results=[];buf=b''
 def read(timeout=.1):
  if select.select([master],[],[],timeout)[0]:
   try:
    b=os.read(master,65536)
    if b'\x1b[c' in b:os.write(master,b'\x1b[?1;2c')
    if b'\x1b[?2026$p' in b:os.write(master,b'\x1b[?2026;2$y')
    if b'\x1b[?2027$p' in b:os.write(master,b'\x1b[?2027;2$y')
    return b
   except OSError:return b''
  return b''
 try:
  while time.monotonic()-launch<15:
   buf+=read()
   if PROMPT.encode() in buf:break
  else:raise RuntimeError('TUI composer did not become ready')
  startup=time.monotonic()-launch
  time.sleep(.15)
  for i in range(turns):
   if i:os.write(master,PROMPT.encode());time.sleep(.15)
   buf=b'';sent=time.monotonic();os.write(master,b'\r')
   while time.monotonic()-sent<60:
    buf+=read();text=ansi.sub('',buf.decode(errors='replace'))
    if re.search(r'(?m)^\s*BENCHPASS\s*$',text):break
   else:
    open('/tmp/agy-bench-native-failure.txt','w').write(text[-20000:]);raise RuntimeError('TUI answer not observed')
   results.append({'startupMs':round(startup*1000) if i==0 else 0,'submitToVisibleMs':round((time.monotonic()-sent)*1000)})
   time.sleep(.4)
  return results
 finally:stop(p);os.close(master)
def stream(turns):
 launch=time.monotonic();p=subprocess.Popen(ARGS+['--output-format','stream-json','--input-format','stream-json'],cwd=ROOT,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,start_new_session=True)
 try:
  while True:
   line=p.stdout.readline()
   if not line:raise RuntimeError('CLI exited')
   try:e=json.loads(line)
   except:continue
   if e.get('event')=='init':break
  startup=time.monotonic()-launch;results=[]
  for i in range(turns):
   sent=time.monotonic();p.stdin.write(json.dumps({'event':'user','message':{'content':[{'type':'text','text':PROMPT}]}})+'\n');p.stdin.flush();first=None
   while True:
    line=p.stdout.readline()
    if not line:raise RuntimeError('CLI exited during turn')
    try:e=json.loads(line)
    except:continue
    if e.get('event')=='step_update' and e['step_update'].get('step_type')=='agent_response' and e['step_update'].get('text_delta') and first is None:first=time.monotonic()-sent
    if e.get('event')=='result':
     if e['result']['status']!='SUCCESS':raise RuntimeError('CLI result failed')
     results.append({'startupMs':round(startup*1000) if i==0 else 0,'submitToFirstResponseEventMs':round((first or time.monotonic()-sent)*1000),'submitToResultMs':round((time.monotonic()-sent)*1000)});break
  return results
 finally:stop(p)
if __name__=='__main__':
 report={'model':'gemini-3.8-flash-high','effort':'high (model suffix)','permission':'Danger','workspace':ROOT,'prompt':PROMPT,'nativeCold':[],'nativeWarm':[],'streamCold':[],'streamWarm':[]}
 target=os.path.join(ROOT,'diagnostics/reconstruction-cli.json')
 try:
  for i in range(5):
   report['nativeCold']+=native(1);report['streamCold']+=stream(1);print('Cold pair',i+1,'completed',flush=True);open(target,'w').write(json.dumps(report,indent=2))
  report['nativeWarm']=native(6)[1:];print('Native warm 5 completed',flush=True);report['streamWarm']=stream(6)[1:];print('Stream warm 5 completed',flush=True)
 finally:open(target,'w').write(json.dumps(report,indent=2))
