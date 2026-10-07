const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {ConversationCoordinator}=require('../out/conversation/coordinator');
const {ConversationRepository}=require('../out/conversation/repository');
const {processGroupExited}=require('../out/core/processGroup');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
test('Coordinator disposal release I/O failure remains observable and retains failed executor for explicit retry',async()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'agy-dispose-release-')),map=new Map(),state={get:(k,d)=>map.has(k)?map.get(k):d,update:async(k,v)=>map.set(k,v)};
  const context={globalStorageUri:{fsPath:tmp},globalState:state,workspaceState:state};
  const repo=new ConversationRepository(context),c=new ConversationCoordinator({config:()=>({cliPath:path.join(__dirname,'fixtures/fake-agy.js'),defaultModel:'gemini-3.8-flash-high',reasoningEffort:'high',dangerouslySkipPermissions:true,autoScroll:true}),workspace:()=>({root:tmp,directories:[tmp]}),log(){},setPermissions:async()=>{},terminal(){}},repo);
  const rename=fs.renameSync;let group;
  try{
    await c.sendMessage('dispose fixture');const runner=c.executionTarget();group=runner.processManager.processPid;
    const deadline=Date.now()+3000;while(c.processing&&Date.now()<deadline)await delay(5);assert.equal(c.processing,false);await repo.flush();
    const cliId=c.currentSessionMeta.cliConversationId;
    fs.renameSync=function(from,...args){if(String(from).startsWith(tmp+path.sep)&&String(from).endsWith('.lock'))throw Object.assign(Error('dispose release EIO'),{code:'EIO'});return rename.call(this,from,...args);};
    const first=c.dispose(),duplicate=c.dispose();assert.equal(first,duplicate,'simultaneous lifecycle cleanup must share one operation');
    await assert.rejects(first,/dispose release EIO/);await assert.rejects(duplicate,/dispose release EIO/);
    assert(c.runners.has(runner),'failed disposal must retain its release callback owner');
    assert.equal(await processGroupExited(group),true);const other=new ConversationRepository(context);assert.throws(()=>other.acquire(cliId));
    fs.renameSync=rename;await c.dispose();assert.equal(c.runners.size,0);const release=other.acquireExecution(cliId);release();assert.equal(repo.writeQueueStats.estimatedBytes,0);
  }finally{fs.renameSync=rename;await c.dispose().catch(()=>{});if(group)assert.equal(await processGroupExited(group),true);fs.rmSync(tmp,{recursive:true,force:true});}
});
