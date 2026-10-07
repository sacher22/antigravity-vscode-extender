const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs'),os=require('node:os');
const {once}=require('node:events');
const {AgyProcessManager}=require('../out/core/agyProcessManager');
const {versionCapabilities}=require('../out/core/cliCapabilities');
const {ConversationController}=require('../out/conversation/controller');
const {ConversationRepository}=require('../out/conversation/repository');
const samples=require('./fixtures/cli-1.2.16-captured.json');
const cliPath=path.join(__dirname,'fixtures/replay-cli-1.2.16.cjs');
const until=async check=>{const start=performance.now();while(!check()){if(performance.now()-start>4000)throw new Error('Capture timed out');await new Promise(resolve=>setTimeout(resolve,5));}};

test('captured 1.2.16 stream/Plan/approval/denial/child/skill payloads all pass the actual NDJSON parser',async()=>{
  for(const [name,sample] of Object.entries(samples.cases)) {
    const manager=new AgyProcessManager(),seen=[];manager.on('step_update',step=>seen.push(step));
    try {
      await manager.start({cliPath,cwd:__dirname,model:'gemini-3.8-flash-high',isPlanMode:name==='readonly-plan'});
      const ready=once(manager,'result');await manager.sendMessage(name);const [result]=await ready;
      assert.equal(seen.length,sample.events.length,`${name}: parser must not silently drop new event shapes`);
      assert.equal(result.status,sample.result.status);assert.deepEqual(result.usage,sample.result.usage);
      if(name==='safe-denial')assert.deepEqual(result.denied_actions,sample.result.denied_actions);
      if(name==='parallel-subagents')assert(seen.some(step=>step.step_type==='subagent' && step.subagent_info?.subagents.length>=2));
    } finally {await manager.stop();assert(manager.exitConfirmed);}
  }
});

test('version 1.2.16 is enabled from actual captures while future and prerelease versions remain conservative',()=>{
  const supported=versionCapabilities('/cli','1.2.16',1);
  assert.equal(supported.status,'verified');assert.equal(supported.streamJson,true);assert.equal(supported.readOnlyPlan,true);assert.equal(supported.subagents,true);assert.equal(supported.skills,true);
  assert.equal(supported.toolApproval,false);assert.equal(supported.schema,'experimental');assert.equal(supported.sandbox,'launch-only');
  for(const unknown of ['1.2.17','1.2.16-preview.1'])assert.equal(versionCapabilities('/cli',unknown,1).streamJson,false);
});

test('actual captured 1.2.16 events drive Controller Plan, denial, child cards and completed skill messages',async()=>{
  for(const name of ['readonly-plan','safe-denial','parallel-subagents','native-skill']) {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'agy-116-controller-')),values=new Map();
    const state={get:(key,fallback)=>values.has(key)?values.get(key):fallback,update:async(key,value)=>values.set(key,value)};
    const repo=new ConversationRepository({globalStorageUri:{fsPath:root},globalState:state,workspaceState:state});
    const config={cliPath,defaultModel:'gemini-3.8-flash-high',reasoningEffort:'high',dangerouslySkipPermissions:false,autoScroll:true};
    const environment={config:()=>config,workspace:()=>({root,directories:[root]}),log(){},setPermissions:async()=>{},terminal(){}};
    const controller=new ConversationController(environment,repo),messages=[];controller.on('message',message=>messages.push(message));
    try {
      controller.prepareOrSwitchSessionUI();if(name==='readonly-plan')await controller.setPlanMode(true);
      await controller.sendMessage(name);await until(()=>!controller.processing);
      const session=controller.currentSessionMeta,answer=session.messages.at(-1);
      assert.equal(answer.status,name==='safe-denial'?'permission_denied':'completed',name+': '+(answer.error||''));
      if(name==='safe-denial')assert.match(answer.error,/拒绝|CLI/);
      if(name==='readonly-plan'){
        assert.equal(session.planMode,true);assert.equal(answer.isPlanMode,true);assert(answer.content.length>0);
        // cliConversationId aliases the active mode; saved Plan ID is assigned on mode exit.
        const planId=session.cliConversationId;assert(planId);assert.equal(session.normalCliConversationId,undefined);
        await controller.setPlanMode(false);
        assert.equal(session.planCliConversationId,planId);assert.equal(session.cliConversationId,undefined);
        assert.equal(session.normalCliConversationId,undefined);
      }
      if(name==='parallel-subagents'){const ids=new Set(session.agents.map(agent=>agent.id));assert.equal(ids.size,2);assert(messages.some(message=>message.type==='agents' && message.agents.length===2));}
      if(name==='native-skill')assert.match(answer.content,/SKILL_116_NATIVE/);
    } finally {await controller.dispose();fs.rmSync(root,{recursive:true,force:true});}
  }
});
