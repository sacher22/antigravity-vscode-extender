// Windows-node acceptance script; all mutations are gated to one exact owned window.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {chromium}=require(process.env.AGY_PLAYWRIGHT_PATH || 'C:\\Users\\Public\\agy-2-acceptance\\node_modules\\playwright');
const {summarizeTurn}=require(path.join(__dirname,'summarize-turn.cjs'));
const {sidebarIdle}=require(path.join(__dirname,'sidebar-idle.cjs'));
const manifest=JSON.parse(fs.readFileSync(path.join(__dirname,'manifest.json'),'utf8'));
const native=JSON.parse(fs.readFileSync(path.join(__dirname,'native-stream-report.json'),'utf8'));
const output=path.join(__dirname,'sidebar-comparison.json');
assert(!fs.existsSync(output),'Use a new output directory, never overwrite real comparison evidence');
const report={status:'running',rows:[],notes:[
  'Same original launcher/API/model/high/Danger/owned workspace and clarified prompts as native/directStream60.',
  'Cold is a new sidebar conversation and new CLI process; extension window is already loaded.',
  'Visible metric uses browser keydown and exact public assistant marker followed by two animation frames.',
  'Host milestones, local render segments and round-trip upper bounds are separate; no cross-clock subtraction.',
  'Warm-up discarded; failed samples retained. This script never reloads or closes a window.'
]};
const save=()=>fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
function probe(installation=false){
  const args=['--distribution','Ubuntu-24.04','--exec','python3',
    '/home/ubuntu/project/antigravity-vscode-extender/scripts/probe-owned-installed.py',manifest.workspace];
  if(installation)args.push('--installation');
  return JSON.parse(execFileSync('C:\\Windows\\System32\\wsl.exe',args,{encoding:'utf8',timeout:20000,windowsHide:true}).trim());
}
(async()=>{
  let browser,frame,page;
  try{
    const installed=probe(true);assert.deepEqual(installed.config,native.config);
    assert.equal(installed.installation.candidateSha256,manifest.candidateSha256);report.installation=installed.installation;
    browser=await chromium.connectOverCDP('http://127.0.0.1:'+manifest.debugPort);
    const matches=[];for(const context of browser.contexts())for(const candidate of context.pages())
      if(await candidate.title()===manifest.exactWindowTitle)matches.push(candidate);
    assert.equal(matches.length,1,'One exact owned window must exist');page=matches[0];report.title=await page.title();
    assert(!report.title.includes('Extension Development'));
    // Only now are UI actions authorized by the target/installation guards above.
    await page.keyboard.press('Control+Shift+P');
    await page.locator('.quick-input-widget input').fill('>Antigravity: Open Chat Sidebar');await page.keyboard.press('Enter');
    for(let index=0;index<60&&!frame;index++){
      const candidates=[];for(const f of page.frames())if(await f.locator('#message-input').isVisible().catch(()=>false))candidates.push(f);
      assert(candidates.length<=1,'Ambiguous sidebar frame');if(candidates.length)frame=candidates[0];else await page.waitForTimeout(500);
    }
    assert(frame,'Owned installed sidebar missing');
    report.scripts=await frame.locator('script[src]').evaluateAll(nodes=>nodes.map(n=>n.src));
    assert(report.scripts.some(url=>url.includes('antigravity-vscode-extender-2.5.0')&&url.includes('/media/chat.js')));
    await frame.waitForFunction(()=>document.querySelector('#new-session-btn')&&!document.querySelector('#new-session-btn').disabled);
    await frame.evaluate(()=>{
      window.acceptanceRuntime=null;window.acceptanceSession=null;
      window.addEventListener('message',event=>{
        const m=event.data;if(m?.type==='runtime')window.acceptanceRuntime={workspaceRoot:m.workspaceRoot,model:m.model,permission:m.permission,planMode:m.planMode};
        if(m?.type==='initSession')window.acceptanceSession={id:m.session.id,model:m.session.model,effort:m.session.effort,workspaceRoot:m.session.workspaceRoot};
      });
    });
    const idle=()=>frame.waitForFunction('('+sidebarIdle.toString()+')(document)',{},{timeout:180000});
    async function local(text){
      await idle();await frame.locator('#message-input').fill(text);await frame.locator('#message-input').press('Enter');
      await frame.waitForFunction(()=>!document.querySelector('#message-input').value,{},{timeout:15000});await idle();
    }
    async function fresh(){
      await idle();const previous=await frame.locator('#session-select').inputValue();
      await frame.locator('#new-session-btn').click();
      await frame.waitForFunction(()=>!document.querySelector('#new-session-btn').disabled&&document.querySelectorAll('.message').length===0);
      const id=await frame.locator('#session-select').inputValue();assert(id);
      assert.equal(await frame.locator('#mode-select').inputValue(),'normal');
      assert.equal(await frame.locator('#model-select').inputValue(),native.config.model);
      assert.equal(await frame.locator('select[aria-label="思考深度"]').inputValue(),'high');
      assert.equal(await frame.locator('#permission-btn').textContent(),'Danger');return {id,previous};
    }
    async function turn(prompt,marker){
      await idle();await frame.locator('#message-input').fill(prompt);
      await frame.evaluate(marker=>{
        window.acceptanceTiming={marker,started:null,visibleMs:null};
        const key=event=>{
          if(event.target.id==='message-input'&&event.key==='Enter'&&!event.shiftKey){
            window.acceptanceTiming.started=performance.now();document.removeEventListener('keydown',key,true);
          }
        };document.addEventListener('keydown',key,true);
        const observe=()=>{
          const t=window.acceptanceTiming;
          const block=[...document.querySelectorAll('.assistant [data-render-message]')].find(n=>n.textContent.trim()===marker);
          if(t.started===null||!block||t.scheduled)return;
          const rect=block.getBoundingClientRect();if(rect.bottom<=0||rect.top>=innerHeight)return;
          t.scheduled=true;requestAnimationFrame(()=>requestAnimationFrame(()=>{
            if(block.isConnected&&block.textContent.trim()===marker)t.visibleMs=performance.now()-t.started;
            observer.disconnect();
          }));
        };
        const observer=new MutationObserver(observe);observer.observe(document.querySelector('.messages'),{subtree:true,childList:true,characterData:true});
        window.acceptanceObserverCleanup=()=>{observer.disconnect();document.removeEventListener('keydown',key,true);};
      },marker);
      try{
        await frame.locator('#message-input').press('Enter');
        await frame.waitForFunction(()=>window.acceptanceTiming?.visibleMs!==null,{},{timeout:180000});
        const timing=await frame.evaluate(()=>window.acceptanceTiming);await idle();
        return {durationMs:timing.visibleMs,finalIdleAfterVisibleMs:await frame.evaluate(()=>performance.now()-window.acceptanceTiming.started)};
      }finally{await frame.evaluate(()=>window.acceptanceObserverCleanup?.());}
    }
    for(const [scene,[basePrompt,baseMarker]] of Object.entries(native.prompts))for(const temperature of ['cold','warm']){
      let warmPid,session;
      if(temperature==='warm'){
        session=await fresh();const before=probe().processes;
        await turn(basePrompt.replace(baseMarker,baseMarker+'_WARMUP'),baseMarker+'_WARMUP');
        const after=probe().processes.filter(p=>!before.some(b=>b.pid===p.pid&&b.startTicks===p.startTicks));
        assert.equal(after.length,1,'Warm-up must create one owned CLI');warmPid=after[0];
      }
      for(let index=1;index<=5;index++){
        const marker=baseMarker+'_'+index,prompt=basePrompt.replace(baseMarker,marker);
        const row={path:'sidebar',scene,temperature,index,metric:'submit-to-visible',status:'failed',config:native.config};
        const start=performance.now();
        try{
          if(temperature==='cold')session=await fresh();row.sessionId=session.id;
          await local('/diagnostics clear');const before=probe();assert.deepEqual(before.config,native.config);
          Object.assign(row,await turn(prompt,marker));const after=probe();assert.deepEqual(after.config,native.config);
          const pid=temperature==='warm'?after.processes.find(p=>p.pid===warmPid.pid&&p.startTicks===warmPid.startTicks):
            after.processes.find(p=>!before.processes.some(b=>b.pid===p.pid&&b.startTicks===p.startTicks));
          assert(pid,'Actual owned CLI process missing');assert.equal(pid.model,native.config.model);
          assert.equal(pid.mode,'accept-edits');assert(pid.danger&&pid.stream&&pid.inputStream&&!pid.agent);assert.equal(pid.effort,null);
          assert.deepEqual(pid.directories,[manifest.workspace]);assert.equal(pid.sandbox,false);assert.equal(pid.schema,null);
          row.processPid=pid.pid;row.processIdentity=pid.startTicks;
          row.actualProcessProfile=pid;
          row.actualRuntime=await frame.evaluate(()=>window.acceptanceRuntime);
          assert.equal(row.actualRuntime.workspaceRoot,manifest.workspace);assert.equal(row.actualRuntime.model,native.config.model);
          assert.equal(row.actualRuntime.permission,'always-proceed');assert.equal(row.actualRuntime.planMode,false);
          if(scene==='read')assert((await frame.locator('.tool summary').allTextContents()).some(t=>t.includes('view_file')));
          if(scene==='tool')assert((await frame.locator('.tool summary').allTextContents()).some(t=>t.includes('run_command')));
          await local('/diagnostics');const diagnostic=JSON.parse(await frame.locator('.command-output pre').textContent());
          row.diagnostics=summarizeTurn(diagnostic.events);assert(row.diagnostics?.milestones['first-cli-text']!==undefined);
          row.startupMs=temperature==='cold'?row.diagnostics.milestones['cli-ready']:0;row.status='passed';
        }catch(error){
          if(row.durationMs===undefined)row.durationMs=performance.now()-start;
          row.errorClass=error.name;row.error=String(error);
          report.rows.push(row);save();throw error; // Preserve uncertain active task; no blind next submission.
        }
        report.rows.push(row);save();console.log(JSON.stringify({scene,temperature,index,status:row.status,durationMs:row.durationMs}));
      }
    }
    assert.equal(report.rows.length,30);report.status='passed';
  }catch(error){report.status='failed';report.error=error.stack||String(error);process.exitCode=1;}
  finally{save();await browser?.close();}
})();
