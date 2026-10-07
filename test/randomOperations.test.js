const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {ConversationCoordinator}=require('../out/conversation/coordinator');
const {ConversationRepository}=require('../out/conversation/repository');
const {processGroupExited}=require('../out/core/processGroup');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const until=async(check)=>{const end=Date.now()+3000;while(!check()){if(Date.now()>end)throw Error('operation condition timed out');await delay(5);}};
const {operationSequence}=require(process.env.AGY_OPERATION_HELPER||'./helpers/seededOperations');
for(const seed of [17,65537,20261004])test(`seeded real Coordinator operation chain seed=${seed}`,{timeout:20000},async t=>{
  if(process.platform==='win32')return t.skip('WSL POSIX group acceptance');
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'agy-random-')),values=new Map(),state={get:(k,d)=>values.has(k)?values.get(k):d,update:async(k,v)=>values.set(k,v)};
  const context={globalStorageUri:{fsPath:tmp},globalState:state,workspaceState:state};
  const repo=new ConversationRepository(context),c=new ConversationCoordinator({config:()=>({cliPath:path.join(__dirname,'fixtures/fake-agy.js'),defaultModel:'gemini-3.8-flash-high',reasoningEffort:'high',dangerouslySkipPermissions:true,autoScroll:true}),workspace:()=>({root:tmp,directories:[tmp]}),log(){},setPermissions:async()=>{},terminal(){}},repo);
  const groups=new Set(),observed=new WeakSet(),drafts=new Map(),counts=Array(10).fill(0),trace=[];
  let step=0,busyRejected=0;
  const observe=()=>{for(const r of c.runners){if(!observed.has(r)){observed.add(r);r.processManager.on('spawned',pid=>groups.add(pid));}if(r.processManager.processPid)groups.add(r.processManager.processPid);}};
  const normal=async()=>{if(c.currentSessionMeta.planMode)await c.setPlanMode(false);};
  async function perform(action){
    observe();const r=c.executionTarget(),id=c.currentSessionMeta.id;trace.push({step:step++,action,id,busy:r.processing});if(trace.length>25)trace.shift();
    switch(action){
      case 0:{const text=`draft-${seed}-${step}`;await c.saveDraft(text);drafts.set(id,text);counts[action]++;break;}
      case 1:await c.newSession(true);assert.notEqual(c.currentSessionMeta.id,id);assert.equal(c.currentSessionMeta.planMode,false);assert.equal(c.currentSessionMeta.attachment,undefined);counts[action]++;break;
      case 2:{const sessions=repo.getAllSessions();await c.switchSession(sessions[(seed+step)%sessions.length].id);const current=c.currentSessionMeta;if(drafts.has(current.id))assert.equal(current.draft,drafts.get(current.id));counts[action]++;break;}
      case 3:if(!r.processing){await normal();await c.sendMessage(`echo-${seed}-${step}`);drafts.delete(id);await until(()=>!r.processing);assert.equal(r.currentSessionMeta.messages.at(-1).content,`echo-${seed}-${step}`);counts[action]++;}break;
      case 4:if(!r.processing&&[...c.runners].filter(x=>x.processing).length<3){await normal();await c.sendMessage('hang');drafts.delete(id);await until(()=>r.turn?.blocks.get(1)?.startsWith('child:'));const body=r.turn.blocks.get(1);await c.newSession(true);assert(r.processing,'new must preserve background turn');assert.equal(r.turn.blocks.get(1),body);assert.notEqual(c.currentSessionMeta.id,id);counts[action]++;}break;
      case 5:{const otherActive=[...c.runners].filter(x=>x!==r&&x.processing),wasRunning=r.processing;await c.abortTurn();assert.equal(r.processing,false);if(wasRunning)assert.equal(r.currentSessionMeta.messages.at(-1).status,'aborted');for(const other of otherActive)assert(other.processing,'selected Stop cannot stop background');counts[action]++;break;}
      case 6:if(!r.processing){await c.setPlanMode(!c.currentSessionMeta.planMode);counts[action]++;}break;
      case 7:if(!r.processing){await normal();await c.sendMessage('crash').catch(()=>{});drafts.delete(id);await until(()=>!r.processing);assert.equal(r.currentSessionMeta.messages.at(-1).status,'failed');counts[action]++;}break;
      case 8:c.sendSnapshot();assert.equal(c.currentSessionMeta.id,id);counts[action]++;break;
      case 9:if(r.processing){await assert.rejects(c.setModel('gemini-3.8-flash-high','high'));await assert.rejects(c.setPlanMode(!c.currentSessionMeta.planMode));busyRejected++;counts[action]++;}else{await c.setModel('gemini-3.8-flash-high','high');counts[action]++;}break;
    }
    observe();await repo.flush();assert.equal(c.currentSessionMeta.id,repo.getCurrentSessionId());
    const sessions=repo.getAllSessions();assert.equal(new Set(sessions.map(s=>s.id)).size,sessions.length);
    for(const session of sessions){assert.equal(session.model,'gemini-3.8-flash-high');assert.equal(session.effort,'high');const ids=session.messages.map(m=>m.id).filter(Boolean);assert.equal(new Set(ids).size,ids.length);}
    const other=new ConversationRepository(context);for(const active of c.runners)if(active.processing&&active.currentSessionMeta.cliConversationId)assert.throws(()=>other.acquire(active.currentSessionMeta.cliConversationId),'active CLI remains exclusive');
  }
  try{
    c.prepareOrSwitchSessionUI();
    // Deterministic prelude covers guarded categories; the next 120 actions use the seed.
    for(const action of [0,3,4,4])await perform(action);
    const background=[...c.runners].find(r=>r.processing);assert(background);
    await c.switchSession(background.currentSessionMeta.id);await perform(9);await perform(5);
    for(const action of [2,6,6,7,8,9,1])await perform(action);
    for(const action of operationSequence(seed,120,10))await perform(action);
    assert(busyRejected>0,"busy model/Plan guards must actually run");
    for(let i=0;i<counts.length;i++)assert(counts[i]>0,`category ${i} must actually execute`);
    observe();const ids=[...c.runners].map(r=>r.currentSessionMeta?.cliConversationId).filter(Boolean);await c.dispose();await repo.flush();assert.equal(c.runners.size,0);assert.equal(repo.writeQueueStats.estimatedBytes,0);
    for(const group of groups)assert.equal(await processGroupExited(group),true,`own group ${group} must exit`);
    const locks=path.join(tmp,'locks');assert(!fs.existsSync(locks)||!fs.readdirSync(locks).some(name=>name.endsWith('.lock')),'no unreleased own active lock directory');
    const other=new ConversationRepository(context);for(const id of ids)other.acquireExecution(id)();
    t.diagnostic(JSON.stringify({seed,operations:step,counts,busyRejected,ownGroups:groups.size,cleanup:true}));
  }catch(error){error.message+=`\nseed=${seed} trace=${JSON.stringify(trace)}`;throw error;}
  finally{await c.dispose();for(const group of groups)assert.equal(await processGroupExited(group),true);fs.rmSync(tmp,{recursive:true,force:true});}
});
