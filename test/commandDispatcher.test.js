const test=require('node:test');
const assert=require('node:assert/strict');
const {WebviewCommandDispatcher}=require('../out/ui/commandDispatcher');
function harness() {
  const calls=[];
  const methods=name=>new Proxy({}, {get:(target,key)=>Object.hasOwn(target,key)?target[key]:(...args)=>{calls.push([name+'.'+key,...args]);return Promise.resolve();}});
  const ports={service:methods('service'),editorActions:methods('editor'),executeSlash:async(...args)=>{calls.push(['slash',...args]);return false;},pickHistory:async()=>{calls.push(['history']);},publishCommands:()=>{calls.push(['commands']);},openResource:async href=>{calls.push(['resource',href]);},confirmRunningDelete:async()=>{calls.push(['confirm']);return true;},requestContext:async type=>{calls.push(['context',type]);},copy:async text=>{calls.push(['copy',text]);},openWorkspace:async()=>{calls.push(['workspace']);},openSettings:()=>{calls.push(['settings']);}};
  ports.service.isSessionRunning=id=>{calls.push(['running',id]);return false;};
  return {ports,calls,dispatcher:new WebviewCommandDispatcher(ports)};
}
test('dispatcher routes all direct operations with unchanged identity arguments',async()=>{
  const cases=[
    [{command:'approvePlan',messageId:'m'},['service.approvePlan','m']],
    [{command:'getAgents'},['service.agents']],
    [{command:'watchAgents',enabled:false},['service.watchAgents',false]],
    [{command:'getAgentDetail',agentId:'child',offset:0},['service.agentDetail','child',0]],
    [{command:'pickSession'},['history']],
    [{command:'saveDraft',text:'draft',attachment:{code:'x'}},['service.saveDraft','draft',{code:'x'}]],
    [{command:'openNativeCli'},['service.openNativeCli']],
    [{command:'loadHistory',before:0},['service.loadHistory',0]],
    [{command:'getToolDetail',messageId:'m',stepIndex:0,offset:0},['service.toolDetail','m',0,0]],
    [{command:'openResource',href:'file:///a'},['resource','file:///a']],
    [{command:'abortCurrentTurn'},['service.abortTurn']],
    [{command:'newSession'},['service.newSession']],
    [{command:'switchSession',conversationId:'s'},['service.switchSession','s']],
    [{command:'changeModel',model:'gemini-3.8-flash-high',effort:'high'},['service.setModel','gemini-3.8-flash-high','high']],
    [{command:'togglePermission',dangerouslySkipPermissions:false},['service.setDangerouslySkipPermissions',false]],
    [{command:'togglePlanMode',isPlanMode:true},['service.setPlanMode',true]],
    [{command:'viewDiff',code:'',filePath:'a',messageId:'m',blockIndex:0},['editor.showDiffView','','a','m',0]],
    [{command:'requestContext',contextType:'selection'},['context','selection']],
    [{command:'applyCodeToEditor',previewId:'p',code:'new',messageId:'m',blockIndex:0},['editor.applyCode','p','new','m',0]],
    [{command:'copyToClipboard',text:'text'},['copy','text']],
    [{command:'openWorkspace'},['workspace']],
    [{command:'openSettings'},['settings']],
  ];
  for(const [request,expected] of cases){const h=harness();await h.dispatcher.dispatch({...request,requestId:'r',sessionId:'s'});assert.deepEqual(h.calls,[expected],request.command);}
  const h=harness();await h.dispatcher.dispatch({command:'reportRender',receipt:{},requestId:'r'});assert.deepEqual(h.calls,[]);
});
test('ready awaits restoration before snapshot and commands',async()=>{
  const h=harness();let resolve;
  h.ports.service.restoreSelection=()=>new Promise(done=>{resolve=done;h.calls.push(['restore']);});
  const done=h.dispatcher.dispatch({command:'ready'});
  await Promise.resolve();assert.deepEqual(h.calls,[['restore']]);resolve();await done;
  assert.deepEqual(h.calls,[['restore'],['service.sendSnapshot'],['commands']]);
});
test('send uses slash short-circuit and preserves escape/context prompt bytes',async()=>{
  for(const [text,context,file,expected,escaped] of [
    ['plain',undefined,undefined,'plain',false],
    ['  //plan',undefined,undefined,'用户的普通文字（不是斜杠命令）：\n  /plan',true],
    ['//plan','上下文','文件 a.ts','Selected context (文件 a.ts):\n```\n上下文\n```\n\n//plan',true],
    ['read','x',undefined,'Selected context (attached files/selections):\n```\nx\n```\n\nread',false],
  ]){
    const h=harness();await h.dispatcher.dispatch({command:'sendMessage',text,contextCode:context,filePath:file,requestId:'r'});
    assert.deepEqual(h.calls,[['slash',text,'r',{code:context,file}],['service.sendMessage',expected,'r',text,undefined,escaped]]);
  }
  const h=harness();h.ports.executeSlash=async()=>true;
  await h.dispatcher.dispatch({command:'sendMessage',text:'/plan',requestId:'r'});assert.deepEqual(h.calls,[]);
});
test('delete captures target, cancels running deletion and does not confirm idle deletion',async()=>{
  for(const running of [false,true])for(const approved of [false,true]){
    const h=harness();h.ports.service.isSessionRunning=id=>{h.calls.push(['running',id]);return running;};h.ports.confirmRunningDelete=async()=>{h.calls.push(['confirm']);return approved;};
    await h.dispatcher.dispatch({command:'deleteSession',conversationId:'target'});
    const expected=[['running','target']];if(running)expected.push(['confirm']);if(!running||approved)expected.push(['service.deleteSession','target',running&&approved]);
    assert.deepEqual(h.calls,expected);
  }
});
test('dispatcher propagates operation failure once and settings remain fire-and-forget',async()=>{
  const h=harness(),failure=new Error('stop failed');let count=0;
  h.ports.service.abortTurn=async()=>{count++;throw failure;};
  await assert.rejects(h.dispatcher.dispatch({command:'abortCurrentTurn'}),error=>error===failure);assert.equal(count,1);
  h.ports.openSettings=()=>({then(){throw new Error('unexpected await');}});
  await h.dispatcher.dispatch({command:'openSettings'});
});
