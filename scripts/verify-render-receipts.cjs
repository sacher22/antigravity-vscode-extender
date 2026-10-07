// Real Provider/Service/Chromium/pipe resource probe. Never connects to user CLI/API.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {chromium} = require('playwright');
const root = path.resolve(__dirname,'..');
const durationMs = Number(process.env.AGY_SOAK_MS || 7200000);
const baselineMs = Number(process.env.AGY_SOAK_BASELINE_MS || 60000);
const output = path.resolve(process.env.AGY_RENDER_OUTPUT || 'diagnostics/render-receipts-acceptance.json');
assert(durationMs >= 5000 && baselineMs >= 1000);
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
const until = async (check, timeout=15000) => {const start=performance.now();while(!await check()){if(performance.now()-start>timeout)throw Error('Soak condition timed out');await delay(20);}};
(async()=>{
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(),'agy-provider-soak-'));
  // Freeze runtime files so later source/build work cannot change this soak mid-run.
  const runtimeRoot=path.join(tmp,'frozen-runtime');
  await fsp.mkdir(runtimeRoot);
  for(const directory of ['out','media']) await fsp.cp(path.join(root,directory),path.join(runtimeRoot,directory),{recursive:true});
  await fsp.symlink(path.join(root,'node_modules'),path.join(runtimeRoot,'node_modules'),'dir');
  await fsp.copyFile(path.join(root,'test/fixtures/soak-agy.cjs'),path.join(runtimeRoot,'soak-agy.cjs'));
  const config = new Map([['cliPath',path.join(runtimeRoot,'soak-agy.cjs')]]);
  const mock = {commands:{executeCommand:async()=>{}},Range:class{},WorkspaceEdit:class{},
    Uri:{joinPath:(b,...p)=>({fsPath:path.join(b.fsPath,...p)})},ConfigurationTarget:{Global:1},
    window:{createOutputChannel:()=>({appendLine(){},dispose(){}})},
    workspace:{workspaceFolders:[{uri:{fsPath:tmp}}],getWorkspaceFolder:()=>undefined,
      getConfiguration:()=>({get:(k,d)=>config.has(k)?config.get(k):d,update:async(k,v)=>config.set(k,v)})}};
  const original=Module._load;
  Module._load=function(name,...args){return name==='vscode'?mock:original.call(this,name,...args);};
  const {ChatViewProvider}=require(path.join(runtimeRoot,'out/ui/chatViewProvider'));
  const {AgyService}=require(path.join(runtimeRoot,'out/services/agyService'));
  const {SessionStore}=require(path.join(runtimeRoot,'out/core/sessionStore'));
  Module._load=original;
  const values=new Map();const state={get:(k,d)=>values.has(k)?values.get(k):d,update:async(k,v)=>values.set(k,v)};
  const context={globalStorageUri:{fsPath:tmp},globalState:state,workspaceState:state,subscriptions:[]};
  let repo,service,provider,browser,view,receiver,visibility,disposed;
  let delivery=[],flushTimer,flushing=Promise.resolve(),phase='setup',sourceEvents=0;
  const ipc={messages:0,bytes:0,types:{}};const errors=[],samples=[],tracked=new Map(),completedPids=new Set();
  const started=performance.now();let loops=0,streamTimer,sampleTimer;
  const build={};
  const hashTree = async directory => {
    for(const entry of await fsp.readdir(path.join(runtimeRoot,directory),{withFileTypes:true})){
      const file=path.join(directory,entry.name);
      if(entry.isDirectory())await hashTree(file);
      else build[file]=createHash('sha256').update(await fsp.readFile(path.join(runtimeRoot,file))).digest('hex');
    }
  };
  for(const directory of ['out','media'])await hashTree(directory);
  build['soak-agy.cjs']=createHash('sha256').update(await fsp.readFile(path.join(runtimeRoot,'soak-agy.cjs'))).digest('hex');
  build['scripts/benchmark-soak.cjs']=createHash('sha256').update(await fsp.readFile(__filename)).digest('hex');
  build['package-lock.json']=createHash('sha256').update(await fsp.readFile(path.join(root,'package-lock.json'))).digest('hex');
  const append = record => fs.appendFileSync(output+'.jsonl',JSON.stringify(record)+'\n');
  const ownProcess = async pid => {
    try {
      const [raw,status,fd]=await Promise.all([fsp.readFile('/proc/'+pid+'/stat','utf8'),fsp.readFile('/proc/'+pid+'/status','utf8'),fsp.readdir('/proc/'+pid+'/fd')]);
      const parts=raw.slice(raw.lastIndexOf(')')+2).trim().split(' ');
      if(parts[0]==='Z')return null;
      return {pid,startTicks:parts[19],cpuTicks:Number(parts[11])+Number(parts[12]),rssBytes:Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1]||0)*1024,fdCount:fd.length};
    } catch(e) {if(['ENOENT','ESRCH'].includes(e.code))return null;throw e;}
  };
  let markerOffset=0;
  const discoverOwnFixtures = async () => {
    let raw;try{raw=await fsp.readFile(path.join(tmp,'fixture-processes.jsonl'),'utf8');}catch(e){if(e.code==='ENOENT')return;throw e;}
    const tail=raw.slice(markerOffset);markerOffset=raw.length;
    for(const line of tail.trim().split('\n').filter(Boolean))for(const pid of Object.values(JSON.parse(line)).filter(value=>typeof value==='number')){
      if(completedPids.has(pid)||tracked.has(pid))continue;
      const proc=await ownProcess(pid);if(proc)tracked.set(pid,proc.startTicks);else completedPids.add(pid);
    }
  };
  let metrics,browserMetrics;
  let samplingTask=Promise.resolve();
  const sample = async () => {
    await discoverOwnFixtures();
    const cli=[];
    for(const [pid,identity] of tracked){const proc=await ownProcess(pid);if(proc&&proc.startTicks===identity)cli.push(proc);else{tracked.delete(pid);completedPids.add(pid);}}
    const processes=(await browserMetrics.send('SystemInfo.getProcessInfo')).processInfo;
    const chromiumResources=[];
    for(const proc of processes){const resource=await ownProcess(proc.id);if(resource)chromiumResources.push({...resource,type:proc.type,cpuSeconds:proc.cpuTime});}
    const pageMetrics=Object.fromEntries((await metrics.send('Performance.getMetrics')).metrics.map(metric=>[metric.name,metric.value]));
    const record={atMs:performance.now()-started,phase,loops,host:{memory:process.memoryUsage(),cpu:process.cpuUsage(),handles:process._getActiveHandles().length,resources:await ownProcess(process.pid)},
      webview:{JSHeapUsedSize:pageMetrics.JSHeapUsedSize,JSHeapTotalSize:pageMetrics.JSHeapTotalSize,TaskDuration:pageMetrics.TaskDuration,Nodes:pageMetrics.Nodes,Documents:pageMetrics.Documents,JSEventListeners:pageMetrics.JSEventListeners},
      chromium:chromiumResources,cli,sourceEvents,ipc:JSON.parse(JSON.stringify(ipc)),writeQueue:repo.writeQueueStats,caches:repo.cacheStats,runners:service.runners.size};
    samples.push(record);append({type:'sample',...record});return record;
  };
  try {
    fs.writeFileSync(output+'.jsonl','');append({type:'started',pid:process.pid,tmp,durationMs,baselineMs,build});
    repo=await SessionStore.open(context);
    service=new AgyService(context,repo);provider=new ChatViewProvider({fsPath:runtimeRoot},service,repo,{});
    browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:420,height:900}});
    page.on('pageerror',e=>errors.push(e.message));
    metrics=await page.context().newCDPSession(page);await metrics.send('Performance.enable');browserMetrics=await browser.newBrowserCDPSession();
    const flush = () => {
      if(!delivery.length)return flushing;
      const batch=delivery;delivery=[];
      flushing=flushing.then(()=>page.evaluate(batch=>{for(const message of batch)window.dispatchEvent(new MessageEvent('message',{data:message}));},batch));
      return flushing;
    };
    view={visible:true,onDidChangeVisibility:cb=>{visibility=cb;return{dispose(){}};},onDidDispose:cb=>disposed=cb,show(){},
      webview:{options:{},html:'',cspSource:'test:',asWebviewUri:u=>u.fsPath,onDidReceiveMessage:cb=>{receiver=cb;return{dispose(){}};},postMessage:message=>{
        if(message.type==='error')errors.push(message.message);
        const raw=JSON.stringify(message);ipc.messages++;ipc.bytes+=Buffer.byteLength(raw);ipc.types[message.type]=(ipc.types[message.type]||0)+1;
        delivery.push(JSON.parse(raw));if(!flushTimer)flushTimer=setTimeout(()=>{flushTimer=undefined;void flush().catch(e=>errors.push(e.message));},2);return Promise.resolve(true);
      }}};
    provider.resolveWebviewView(view,{},{});
    const requests=[];await page.exposeFunction('post',data=>{requests.push(data.command);return receiver(data);});
    await page.setContent('<div id="root"></div>');await page.addStyleTag({path:path.join(runtimeRoot,'media/chat.css')});
    await page.evaluate(()=>{window.acquireVsCodeApi=()=>({postMessage:data=>window.post(data),getState:()=>({}),setState(){}});});
    await page.addScriptTag({path:path.join(runtimeRoot,'media/chat.js')});
    await until(()=>service.currentSessionMeta&&page.locator('#message-input').count());await flush();
    const clickSend = async text => {await page.locator('#message-input').fill(text);await page.locator('#send-btn').click();};

    const renders=()=>service.diagnosticsSnapshot().events.filter(event=>event.milestone==='webview-render');
    await clickSend('stream');await until(()=>renders().some(event=>event.kind==='firstText'));
    await delay(800);await flush();
    assert.equal(renders().filter(event=>event.kind==='firstText').length,1);
    assert.equal(requests.filter(command=>command==='reportRender').length,1,'no per-token receipts');
    await page.locator('#stop-btn').click();await until(()=>!service.processing);
    await until(()=>renders().some(event=>event.kind==='completedText'));
    assert(service.currentSessionMeta.messages.some(message=>message.status==='aborted'));
    view.visible=false;visibility();await delay(50);await flush();
    const beforeHidden=requests.filter(command=>command==='reportRender').length;
    await delay(100);assert.equal(requests.filter(command=>command==='reportRender').length,beforeHidden);
    view.visible=true;visibility();await flush();await until(()=>renders().some(event=>event.kind==='restoredText'));
    assert.equal(errors.length,0);
    // Exercise actual browser geometry separately using the exact production observer.
    const bundle=await require('esbuild').build({entryPoints:[path.join(root,'src/webview/renderObserver.ts')],bundle:true,write:false,format:'iife',globalName:'RenderModule',platform:'browser'});
    const geometry=await browser.newPage({viewport:{width:420,height:900}});
    await geometry.setContent('<div class="messages" style="height:300px;overflow:hidden"><div id="source"><details><p>Hidden source glyphs</p></details></div></div>');
    await geometry.addScriptTag({content:bundle.outputFiles[0].text});
    await geometry.evaluate(()=>{
      window.receipts=[];window.observer=new RenderModule.RenderObserver(receipt=>receipts.push(receipt),()=> 'session');
      observer.selectSession('session');
      document.addEventListener('toggle',()=>observer.retryVisible(),true);
      observer.receive({token:'closed',viewEpoch:1,sessionId:'session',turnId:'turn',generation:1,messageId:'message',stepIndex:2,kind:'completedText',minimumSourceLength:1});
      observer.domUpdated('message',2,20,true,document.querySelector('#source'));
    });
    await delay(150);assert.equal(await geometry.evaluate(()=>receipts.length),0,'closed details has no visible source');
    await geometry.locator('details').evaluate(el=>el.open=true);
    await until(()=>geometry.evaluate(()=>receipts.length===1));
    await geometry.evaluate(()=>{
      document.querySelector('.messages').style.height='0px';
      observer.receive({token:'clipped',viewEpoch:1,sessionId:'session',turnId:'turn2',generation:1,messageId:'message',stepIndex:2,kind:'completedText',minimumSourceLength:1});
      observer.domUpdated('message',2,20,true,document.querySelector('#source'));
    });
    await delay(150);assert.equal(await geometry.evaluate(()=>receipts.length),1,'empty clipping viewport has no sample');
    await geometry.evaluate(()=>{observer.clear();document.querySelector('.messages').style.height='300px';observer.retryVisible();});
    await delay(100);assert.equal(await geometry.evaluate(()=>receipts.length),1,'clear cancels old samples');
    await geometry.close();
    await discoverOwnFixtures();const ownPids=[...tracked];await service.dispose();await repo.flush();
    await until(async()=>{for(const [pid,identity] of ownPids){const proc=await ownProcess(pid);if(proc&&proc.startTicks===identity)return false;}return true;});
    assert(service.diagnosticsSnapshot().events.some(event=>event.milestone==='storage-committed'),'actual storage milestone follows stop save');
    const report={status:'passed',build,renders:renders(),requests,errors,checks:{firstAndStoppedCompletion:true,storageCommit:true,noPerTokenReceipt:true,hiddenRestore:true,closedDetails:true,emptyClip:true,clear:true,ownProcessesExited:true},notes:['Real headless Chromium and production Provider/Service/Controller with POSIX simulated CLI; VS Code API mocked.','Geometry case uses production observer directly; no physical compositor or installed-window claim.','Host post-to-ack is an upper bound including return dispatch; browser clocks are not subtracted from Host clocks.']};
    fs.writeFileSync(output,JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,checks:report.checks,renders:report.renders.length}));
  } catch(error){fs.writeFileSync(output,JSON.stringify({status:'failed',error:String(error),build,errors},null,2));throw error;}
  finally {
    clearTimeout(flushTimer);
    if(service)await service.dispose();if(repo)await repo.flush();disposed?.();provider?.dispose();
    for(const subscription of context.subscriptions)subscription.dispose?.();await browser?.close();
    await fsp.rm(tmp,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
