// Real Provider/Service/Chromium/pipe resource probe. Never connects to user CLI/API.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {chromium} = require('playwright');
const {sampleProcess}=require('./owned-process-resource.cjs');
const root = path.resolve(__dirname,'..');
const durationMs = Number(process.env.AGY_SOAK_MS || 7200000);
const baselineMs = Number(process.env.AGY_SOAK_BASELINE_MS || 60000);
const output = path.resolve(process.env.AGY_SOAK_OUTPUT || 'diagnostics/optimization-soak.json');
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
  const started=performance.now();let loops=0,streamTimer,sampleTimer,continuousStart;
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
  build['scripts/owned-process-resource.cjs']=createHash('sha256').update(await fsp.readFile(path.join(__dirname,'owned-process-resource.cjs'))).digest('hex');
  build['package-lock.json']=createHash('sha256').update(await fsp.readFile(path.join(root,'package-lock.json'))).digest('hex');
  const append = record => fs.appendFileSync(output+'.jsonl',JSON.stringify(record)+'\n');
  const recordError = (origin,error) => {
    const message=typeof error==='string'?error:String(error?.message||error);
    errors.push(message);
    append({type:'error_detected',origin,atMs:performance.now()-started,phase,loops,message});
  };
  let confirmedExitRaces=0;
  const ownProcess = pid => sampleProcess(pid,{onExitRace:record=>{
    confirmedExitRaces++;
    append({type:'confirmed_process_exit_race',atMs:performance.now()-started,phase,loops,...record});
  }});
  let markerOffset=0;
  const discoverOwnFixtures = async () => {
    let raw;try{raw=await fsp.readFile(path.join(tmp,'fixture-processes.jsonl'),'utf8');}catch(e){if(e.code==='ENOENT')return;throw e;}
    const completeEnd=raw.lastIndexOf('\n')+1;
    if(completeEnd<=markerOffset)return;
    const tail=raw.slice(markerOffset,completeEnd);markerOffset=completeEnd;
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
    const history=[];
    for(let i=0;i<100;i++){
      const id='soak-history-'+i;const s=repo.createSession(id,'gemini-3.8-flash-high','high','Persistent history '+i);
      s.workspaceRoot=tmp;s.messages=[{id:id+'-message',role:'assistant',content:'历史🙂 '+ 'x'.repeat(100000),status:'completed',toolCalls:[{id:id+'-tool',stepIndex:5,name:'historical',state:'DONE',output:'完整工具原文 '+i+' '+ 'o'.repeat(2048)}]}];
      s.messageCount=1;repo.saveSession(s);history.push(id);await repo.flush();await repo.releaseTranscript(id,()=>true);
    }
    service=new AgyService(context,repo);provider=new ChatViewProvider({fsPath:runtimeRoot},service,repo,{});
    browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:420,height:900}});
    page.on('pageerror',e=>recordError('webview',e));
    metrics=await page.context().newCDPSession(page);await metrics.send('Performance.enable');browserMetrics=await browser.newBrowserCDPSession();
    const flush = () => {
      if(!delivery.length)return flushing;
      const batch=delivery;delivery=[];
      flushing=flushing.then(()=>page.evaluate(batch=>{for(const message of batch)window.dispatchEvent(new MessageEvent('message',{data:message}));},batch));
      return flushing;
    };
    view={visible:true,onDidChangeVisibility:cb=>{visibility=cb;return{dispose(){}};},onDidDispose:cb=>disposed=cb,show(){},
      webview:{options:{},html:'',cspSource:'test:',asWebviewUri:u=>u.fsPath,onDidReceiveMessage:cb=>{receiver=cb;return{dispose(){}};},postMessage:message=>{
        if(message.type==='error')recordError('provider',message.message);
        const raw=JSON.stringify(message);ipc.messages++;ipc.bytes+=Buffer.byteLength(raw);ipc.types[message.type]=(ipc.types[message.type]||0)+1;
        delivery.push(JSON.parse(raw));if(!flushTimer)flushTimer=setTimeout(()=>{flushTimer=undefined;void flush().catch(e=>recordError('delivery',e));},2);return Promise.resolve(true);
      }}};
    provider.resolveWebviewView(view,{},{});
    await page.exposeFunction('post',data=>receiver(data));
    await page.setContent('<div id="root"></div>');await page.addStyleTag({path:path.join(runtimeRoot,'media/chat.css')});
    await page.evaluate(()=>{window.acquireVsCodeApi=()=>({postMessage:data=>window.post(data),getState:()=>({}),setState(){}});});
    await page.addScriptTag({path:path.join(runtimeRoot,'media/chat.js')});
    await until(()=>service.currentSessionMeta&&page.locator('#message-input').count());await flush();
    const clickSend = async text => {await page.locator('#message-input').fill(text);await page.locator('#send-btn').click();};
    const observedRunners = new WeakSet();
    const observeRunner = runner => {if(observedRunners.has(runner))return;observedRunners.add(runner);runner.processManager.on('step_update',()=>sourceEvents++);};
    phase='visible-idle';const idleBefore=await sample();await delay(baselineMs);const idleAfter=await sample();
    const backgrounds=[];
    for(let i=0;i<3;i++){
      const previousId=service.currentSessionMeta.id;
      await page.locator('#new-session-btn').click();await until(()=>service.currentSessionMeta.id!==previousId);
      await until(()=>page.locator('#new-session-btn').isEnabled());
      observeRunner(service.executionTarget());await clickSend('stream');await until(()=>service.processing);backgrounds.push(service.currentSessionMeta.id);
      await until(()=>service.executionTarget().processManager.active);
    }
    const hiddenId=service.currentSessionMeta.id;
    await page.locator('#message-input').fill('隐藏阶段草稿');await delay(400);await flush();
    phase='hidden-active';view.visible=false;visibility();await delay(100);await flush();
    const hiddenBefore=await sample();await delay(baselineMs);const hiddenAfter=await sample();
    assert(sourceEvents>hiddenBefore.sourceEvents,'real CLI source continues hidden');
    assert.equal(ipc.types.streamDelta||0,hiddenBefore.ipc.types.streamDelta||0,'no hidden streamed text IPC');
    assert.equal(ipc.types.toolUpdates||0,hiddenBefore.ipc.types.toolUpdates||0,'no hidden tool IPC');
    view.visible=true;visibility();await flush();
    await until(()=>page.locator('.assistant').textContent().then(text=>text.includes('后台流')));
    assert.equal(await page.locator('#message-input').inputValue(),'隐藏阶段草稿');assert.equal(service.currentSessionMeta.id,hiddenId);
    phase='continuous';continuousStart=performance.now();
    let sampling=false;sampleTimer=setInterval(()=>{if(sampling)return;sampling=true;samplingTask=sample().catch(e=>recordError('sampling',e)).finally(()=>sampling=false);},5000);
    while(performance.now()-continuousStart<durationMs){
      const id=history[loops%history.length];await page.locator('#session-select').selectOption(id);
      await until(()=>service.currentSessionMeta?.id===id);await until(()=>page.locator('#session-select').isEnabled());await until(()=>!service.processing);
      observeRunner(service.executionTarget());await clickSend('turn '+loops);
      await until(()=>!service.processing&&service.currentSessionMeta.messages.some(message=>message.role==='assistant'&&message.content.includes('turn '+loops)));
      await page.locator('#message-input').fill('保留草稿 '+loops);
      await page.locator('.messages').evaluate(el=>el.scrollTop=0);
      for(const background of backgrounds)assert(service.isSessionRunning(background),'background survives history/new turns');
      loops++;if(loops%25===0)append({type:'checkpoint',atMs:performance.now()-started,loops,errors:errors.length});
      await delay(Math.min(3000,Math.max(0,durationMs-(performance.now()-continuousStart))));
    }
    const actualContinuousMs=performance.now()-continuousStart;
    clearInterval(sampleTimer);await samplingTask;await repo.flush();const after=await sample();
    assert.equal(errors.length,0);assert(loops>=Math.min(100,Math.floor(durationMs/4000)),'history cycling count');
    // Read full disk-backed history and raw original after caches have been exercised.
    const first=await repo.getSessionAsync(history[0]);assert(first.messages[0].content.endsWith('x'.repeat(100000)));
    const tool=await repo.toolOutputAsync(history[0],history[0]+'-message',5,0);assert(tool.output.startsWith('完整工具原文 0 '));
    phase='cleanup';await discoverOwnFixtures();const activeOwnPids=[...tracked];await service.dispose();await repo.flush();
    await until(async()=>{for(const [pid,identity] of activeOwnPids){const proc=await ownProcess(pid);if(proc&&proc.startTicks===identity)return false;}return true;},15000);
    const report={status:'passed',durationMs,actualContinuousMs,baselineMs,loops,build,idle:{before:idleBefore,after:idleAfter},hidden:{before:hiddenBefore,after:hiddenAfter,sourceContinued:true,textIpcStopped:true,toolsIpcStopped:true,draftRestored:true},after,samples,errors,confirmedExitRaces,cleanup:{ownLiveProcessCount:0,trackedBeforeDispose:activeOwnPids.length},notes:['Provider and Service are actual production modules; VS Code API is mocked and Chromium is headless','100 real persisted 100k histories and raw tools; three real-pipe continuous fake CLI processes with their own children','No API/model requests; observation samples do not prove hard memory cap or installed VS Code behavior','No forced GC during resource/latency phases; versioned fixed build recorded; runtime modules frozen in temp directory; dependencies shared read-only; later modifications require a final soak rerun']};
    fs.writeFileSync(output,JSON.stringify(report,null,2));append({type:'complete',status:'passed',loops});console.log(JSON.stringify({status:report.status,loops,actualContinuousMs:report.actualContinuousMs,errors,cleanup:report.cleanup}));
  } catch(error){const failure={status:'failed',error:String(error),durationMs,actualContinuousMs:continuousStart===undefined?null:performance.now()-continuousStart,loops,phase,build,samples,errors};append({type:'failed',error:String(error),loops,phase});fs.writeFileSync(output,JSON.stringify(failure,null,2));throw error;}
  finally{
    clearInterval(sampleTimer);clearTimeout(flushTimer);clearInterval(streamTimer);
    await samplingTask;
    await discoverOwnFixtures();
    const finalOwnedIdentities=[...tracked];
    if(service)await service.dispose();if(repo)await repo.flush();disposed?.();provider?.dispose();
    for(const subscription of context.subscriptions)subscription.dispose?.();await browser?.close();
    await until(async()=>{for(const [pid,identity] of finalOwnedIdentities){const proc=await ownProcess(pid);if(proc&&proc.startTicks===identity)return false;}return true;},15000);
    fs.writeFileSync(output+'.cleanup.json',JSON.stringify({status:'verified-owned-fixtures-exited',ownLiveProcessCount:0,identitiesChecked:finalOwnedIdentities.length,confirmedExitRaces},null,2));
    await fsp.rm(tmp,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
