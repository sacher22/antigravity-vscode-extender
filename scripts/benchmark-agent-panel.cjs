// Validation only: real Chromium/React/Provider/Service and test-owned fs.watch.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const assert = require('node:assert/strict');
const {pathToFileURL} = require('node:url');
const {createHash} = require('node:crypto');
const {chromium} = require('playwright');
const root = path.resolve(__dirname, '..');
const output = path.resolve(process.env.AGY_AGENT_PANEL_OUTPUT || 'diagnostics/optimization-agent-panel.json');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async check => {
  const start = performance.now();
  while (!await check()) {
    if (performance.now() - start > 10000) throw Error('Agent panel condition timed out');
    await delay(5);
  }
};
(async () => {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agy-panel-chromium-'));
  let browser, service, repo, provider, receiver, viewDisposed, timer;
  let delivery = [], flushing = Promise.resolve(), ending = false;
  const requests = [], errors = [], cycles = [];
  const report = {status:'running', cycles, errors, notes:[
    'Actual Chromium bundle -> Provider -> Service -> AgentRegistry; VS Code API mocked.',
    'Synthetic subagent_info fixture and test-only brainRoot; real files/watchers, no CLI/model calls.',
    'Listener/timer wrappers record registrations and still invoke native APIs; no forced GC during clicks/resource samples.',
    'After interaction ends, a separate diagnostic browser GC checks whether retired DOM/listener counts are collectible; raw before/after preserved.'
  ]};
  try {
    const configuration = new Map([['cliPath',path.join(root,'test/fixtures/fake-agy.js')]]);
    const mock = {commands:{executeCommand:async()=>{}},Range:class{},WorkspaceEdit:class{},
      ConfigurationTarget:{Global:1},Uri:{joinPath:(b,...p)=>({fsPath:path.join(b.fsPath,...p)})},
      window:{createOutputChannel:()=>({appendLine(){},dispose(){}})},
      workspace:{workspaceFolders:[{uri:{fsPath:tmp}}],getWorkspaceFolder:()=>undefined,
        getConfiguration:()=>({get:(k,d)=>configuration.has(k)?configuration.get(k):d,update:async(k,v)=>configuration.set(k,v)})}};
    const load = Module._load;
    let AgyService, SessionStore, ChatViewProvider;
    try {
      Module._load = function(name,...args){return name === 'vscode' ? mock : load.call(this,name,...args);};
      ({AgyService}=require('../out/services/agyService'));
      ({SessionStore}=require('../out/core/sessionStore'));
      ({ChatViewProvider}=require('../out/ui/chatViewProvider'));
    } finally {Module._load=load;}
    const values=new Map(), state={get:(k,d)=>values.has(k)?values.get(k):d,update:async(k,v)=>values.set(k,v)};
    const context={globalStorageUri:{fsPath:tmp},globalState:state,workspaceState:state,subscriptions:[]};
    repo=await SessionStore.open(context);service=new AgyService(context,repo);
    provider=new ChatViewProvider({fsPath:root},service,repo,{});
    browser=await chromium.launch({headless:true});
    const page=await browser.newPage({viewport:{width:420,height:900}});
    page.on('pageerror',e=>errors.push(e.message));
    const metrics=await page.context().newCDPSession(page);await metrics.send('Performance.enable');
    const sample=async()=>({host:{memory:process.memoryUsage(),handles:process._getActiveHandles().length,
      watchers:process._getActiveHandles().filter(h=>h.constructor?.name==='FSWatcher').length},
      webview:Object.fromEntries((await metrics.send('Performance.getMetrics')).metrics.filter(m=>
        ['JSHeapUsedSize','Nodes','Documents','JSEventListeners','TaskDuration'].includes(m.name)).map(m=>[m.name,m.value])),
      registrations:await page.evaluate(()=>window.panelRegistrationCounts())});
    const flush=()=>{
      if(!delivery.length)return flushing;
      const batch=delivery;delivery=[];
      flushing=flushing.then(()=>page.evaluate(messages=>{for(const data of messages)window.dispatchEvent(new MessageEvent('message',{data}));},batch));
      return flushing;
    };
    const view={visible:true,show(){},onDidChangeVisibility:()=>({dispose(){}}),onDidDispose:cb=>viewDisposed=cb,
      webview:{options:{},html:'',cspSource:'test:',asWebviewUri:u=>u.fsPath,onDidReceiveMessage:cb=>{receiver=cb;return{dispose(){}};},
        postMessage:data=>{if(ending)return Promise.resolve(false);if(data.type==='error')errors.push(data.message);delivery.push(JSON.parse(JSON.stringify(data)));
          if(!timer)timer=setTimeout(()=>{timer=undefined;void flush().catch(e=>errors.push(e.message));},2);return Promise.resolve(true);}}};
    provider.resolveWebviewView(view,{},{});
    await page.exposeFunction('hostPost',data=>{requests.push(data);return receiver(data);});
    await page.setContent('<div id="root"></div>');
    await page.addStyleTag({path:path.join(root,'media/chat.css')});
    await page.evaluate(()=>{
      window.acquireVsCodeApi=()=>({postMessage:data=>window.hostPost(data),getState:()=>({}),setState(){}});
      const intervals=new Set(), registrations=[];
      const start=window.setInterval.bind(window),stop=window.clearInterval.bind(window);
      window.setInterval=(...args)=>{const id=start(...args);intervals.add(id);return id;};
      window.clearInterval=id=>{intervals.delete(id);return stop(id);};
      for(const [target,label] of [[window,'window'],[document,'document']]){
        const add=target.addEventListener.bind(target),remove=target.removeEventListener.bind(target);
        const capture=options=>typeof options==='boolean'?options:!!options?.capture;
        target.addEventListener=(type,listener,options)=>{
          if(listener&&!registrations.some(r=>r.target===label&&r.type===type&&r.listener===listener&&r.capture===capture(options)))
            registrations.push({target:label,type,listener,capture:capture(options)});
          return add(type,listener,options);
        };
        target.removeEventListener=(type,listener,options)=>{
          const index=registrations.findIndex(r=>r.target===label&&r.type===type&&r.listener===listener&&r.capture===capture(options));
          if(index>=0)registrations.splice(index,1);return remove(type,listener,options);
        };
      }
      window.panelRegistrationCounts=()=>({intervals:intervals.size,
        visibility:registrations.filter(r=>r.target==='document'&&r.type==='visibilitychange').length,
        detail:registrations.filter(r=>r.target==='window'&&r.type==='agent-detail').length,
        show:registrations.filter(r=>r.target==='window'&&r.type==='show-agents').length,
        message:registrations.filter(r=>r.target==='window'&&r.type==='message').length});
    });
    await page.addScriptTag({path:path.join(root,'media/chat.js')});
    await until(()=>service.currentSessionMeta&&page.locator('#agents-btn').count());await flush();
    const runner=service.executionTarget(),registry=runner.agentRegistry;
    assert(registry);registry.brainRoot=tmp;
    const agents=[],files=[];
    for(const id of ['chromium-child-1','chromium-child-2']){
      const directory=path.join(tmp,id,'.system_generated/logs');await fs.promises.mkdir(directory,{recursive:true});
      const file=path.join(directory,'transcript.jsonl');await fs.promises.writeFile(file,'');files.push(file);
      agents.push({conversation_id:id,role:id,log_uri:pathToFileURL(file).href});
    }
    registry.ingest({step_type:'subagent',subagent_info:{subagents:agents}});
    await until(()=>page.locator('#agents-btn').textContent().then(t=>t==='2 Agents'));
    const count=(command,enabled)=>requests.filter(r=>r.command===command&&(enabled===undefined||r.enabled===enabled)).length;
    const initial={open:count('watchAgents',true),close:count('watchAgents',false),details:count('getAgentDetail')};
    report.before=await sample();assert.equal(report.before.registrations.intervals,0);
    for(let index=0;index<100;index++){
      const marker='CHROMIUM_CHILD_CYCLE_'+index+'_END';
      await fs.promises.appendFile(files[0],JSON.stringify({source:'MODEL',type:'PLANNER_RESPONSE',status:'DONE',content:marker,thinking:'PRIVATE_PANEL_THINKING'})+'\n');
      await page.locator('#agents-btn').click();await until(()=>registry.watchers.size===2&&registry.pendingWatches.size===0);
      const opened=await page.evaluate(()=>window.panelRegistrationCounts());
      assert.equal(opened.intervals,report.before.registrations.intervals+1);
      assert.equal(opened.visibility,report.before.registrations.visibility+1);
      assert.equal(opened.detail,report.before.registrations.detail);assert.equal(opened.show,report.before.registrations.show);
      await page.locator('.agent-card[data-agent-id="chromium-child-1"]').click();
      await until(()=>page.locator('.agent-transcript').textContent().then(t=>t.includes(marker)));
      assert.equal(count('getAgentDetail'),initial.details+index+1);
      assert(!(await page.locator('.agent-transcript').textContent()).includes('PRIVATE_PANEL_THINKING'));
      assert(!(await page.locator('.messages').textContent()).includes('CHROMIUM_CHILD_CYCLE_'));
      await page.locator('#agents-btn').click();await until(()=>registry.watchers.size===0&&registry.pendingWatches.size===0);
      assert.equal(registry.timer,undefined);await page.locator('.agent-content').waitFor({state:'detached'});
      const closed=await page.evaluate(()=>window.panelRegistrationCounts());
      assert.deepEqual(closed,report.before.registrations);
      assert.equal(count('watchAgents',true),initial.open+index+1);assert.equal(count('watchAgents',false),initial.close+index+1);
      assert.equal(closed.message,report.before.registrations.message);
      cycles.push({index,watchers:registry.watchers.size,pending:registry.pendingWatches.size,registrations:closed});
      if(index%10===9)cycles[cycles.length-1].resources=await sample();
    }
    assert.equal(runner.processManager.active,false);assert.equal(service.runners.size,1);assert.equal(errors.length,0);
    report.after=await sample();
    await metrics.send('HeapProfiler.collectGarbage');await delay(100);
    report.postDiagnosticGC=await sample();
    assert(report.postDiagnosticGC.webview.Nodes <= report.before.webview.Nodes+100,'retired panel DOM collectible');
    assert(report.postDiagnosticGC.webview.JSEventListeners <= report.before.webview.JSEventListeners+100,'retired panel listeners collectible');
    await service.dispose();await repo.flush();viewDisposed?.();provider.dispose();
    assert.equal(registry.watchers.size,0);assert.equal(registry.pendingWatches.size,0);assert.equal(registry.timer,undefined);
    report.cleanup={watchers:0,pending:0,cliStarted:false};report.status='passed';
    report.build={};for(const name of ['media/chat.js','media/chat.css','out/conversation/agents.js','out/services/agyService.js','out/ui/chatViewProvider.js'])
      report.build[name]=createHash('sha256').update(await fs.promises.readFile(path.join(root,name))).digest('hex');
  } catch(error){report.status='failed';report.error=error.stack||String(error);process.exitCode=1;}
  finally{
    ending=true;clearTimeout(timer);delivery=[];await flushing.catch(()=>{});
    if(service)await service.dispose();if(repo)await repo.flush();provider?.dispose();await browser?.close();
    await fs.promises.rm(tmp,{recursive:true,force:true});
    await fs.promises.writeFile(output,JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify({status:report.status,cycles:cycles.length,error:report.error,cleanup:report.cleanup}));
  }
})();
