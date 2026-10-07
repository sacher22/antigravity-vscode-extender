const test=require('node:test'),assert=require('node:assert/strict');
const policy=require(process.env.AGY_PLAN_POLICY_MODULE || '../out/conversation/planPolicy');
const {PLAN_AGENT}=require('../out/core/planAgent');
const assistant=(extra={})=>({id:'plan',role:'assistant',isPlanMode:true,status:'completed',content:'方案正文',...extra});
const session=(messages=[assistant()],extra={})=>({id:'session',planMode:true,messages,...extra});

test('approval capture requires exact latest completed nonblank Plan assistant and does not mutate history',()=>{
  const s=session([{id:'user',role:'user',content:'give plan'},assistant()]);const before=JSON.stringify(s);
  const approval=policy.capturePlanApproval(s,'plan');
  assert.equal(approval.session,s);assert.equal(approval.message,s.messages.at(-1));assert.equal(approval.plan,'方案正文');assert.equal(approval.parallel,false);
  assert.equal(JSON.stringify(s),before);assert(!Object.isFrozen(s));assert(!Object.isFrozen(s.messages.at(-1)));
  for(const invalid of [null,session(undefined,{planMode:false}),session([assistant({role:'user'})]),session([assistant({isPlanMode:false})]),session([assistant({status:'running'})]),session([assistant({content:' \n'})]),session([assistant(),{id:'new',role:'user',content:'later'}])])
    assert.throws(()=>policy.capturePlanApproval(invalid,'plan'),/方案已变化或尚未完成/);
  assert.throws(()=>policy.capturePlanApproval(s,'wrong-id'),/方案已变化或尚未完成/);
});
test('approval keeps stored parallel intent and legacy latest user request without reading generated role names',()=>{
  assert.equal(policy.capturePlanApproval(session([assistant({agentExecution:{state:'planned',required:2,observedIds:[]}})]),'plan').parallel,true);
  assert.equal(policy.capturePlanApproval(session([{role:'user',content:'多 Agent 并行执行'},assistant()]),'plan').parallel,true);
  assert.equal(policy.capturePlanApproval(session([{role:'user',content:'多 Agent 并行执行'},assistant({id:'old'}),{role:'user',content:'不要多 Agent 执行'},assistant()]),'plan').parallel,false);
  assert.equal(policy.capturePlanApproval(session([{role:'user',content:'普通方案'},assistant({content:'Agent A/B 并行分工'})]),'plan').parallel,false);
});
test('post-await approval validates session reference latest message reference content and terminal status',()=>{
  for(const change of ['session','message','content','status']){
    const s=session();const approval=policy.capturePlanApproval(s,'plan');s.planMode=false;
    assert.doesNotThrow(()=>policy.assertPlanApproval(s,approval));
    let current=s;
    if(change==='session')current={...s};
    if(change==='message')s.messages[0]={...s.messages[0]};
    if(change==='content')s.messages[0].content+=' changed';
    if(change==='status')s.messages[0].status='failed';
    assert.throws(()=>policy.assertPlanApproval(current,approval),/批准对象已变化，未提交实施任务/);
  }
});
test('read recovery permits exactly one empty read-only denied Plan continuation regardless of original result status',()=>{
  const result={status:'SUCCESS',denied_actions:[{action:'read_file',display_name:'read'}]};
  assert.equal(policy.shouldRecoverPlanRead(true,false,'',result),true);
  assert.equal(policy.shouldRecoverPlanRead(true,false,' \n',{...result,status:'ERROR'}),true);
  for(const args of [[false,false,'',result],[true,true,'',result],[true,false,'body',result],[true,false,'',{...result,response:'body'}],[true,false,'',{status:'SUCCESS'}],[true,false,'',{...result,denied_actions:[]}],[true,false,'',{...result,denied_actions:[{action:'read_file'},{action:'command'}]}]])
    assert.equal(policy.shouldRecoverPlanRead(...args),false);
});
test('usable denied Plan needs completed visible body and exclusively actual read denials',()=>{
  const result={status:'SUCCESS',denied_actions:[{action:'read_file'}]};
  assert.equal(policy.hasUsableDeniedPlan(true,'body','completed',result),true);
  for(const args of [[false,'body','completed',result],[true,'','completed',result],[true,'body','failed',result],[true,'body','aborted',result],[true,'body','completed',{status:'SUCCESS'}],[true,'body','completed',{...result,denied_actions:[]}],[true,'body','completed',{...result,denied_actions:[{action:'command'}]}]])
    assert.equal(policy.hasUsableDeniedPlan(...args),false);
});
test('Plan agent match is exact and prompt bytes remain identical to the verified restricted flow',()=>{
  assert.equal(policy.planAgentMatches(true,PLAN_AGENT),true);
  for(const actual of [undefined,null,PLAN_AGENT+'-unsafe',{},[PLAN_AGENT]])assert.equal(policy.planAgentMatches(true,actual),false);
  assert.equal(policy.planAgentMatches(false,'custom-agent'),true);
  assert.equal(policy.PLAN_REQUEST_PREFIX,'只做方案，不实施。仅在当前工作区及附加目录内进行必要的读取；不要探查父目录或其他项目。若读取不可用，根据已有信息给出方案并说明假设，不要反复重试。请直接在聊天正文给出方案，完成后停止，等待用户批准。\n\n');
  assert.equal(policy.PLAN_READ_RECOVERY_PREFIX,'读取已被 CLI 自动拒绝，用户没有拒绝，也没有授权扩大范围。现在不要调用任何工具，不要重试读取。请依据已有上下文直接在聊天正文输出完整方案，说明缺失信息与假设，然后停止等待批准。原始任务：\n');
});
