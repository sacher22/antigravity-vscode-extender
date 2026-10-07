const test=require('node:test');
const assert=require('node:assert/strict');
const {TurnRunner}=require('../out/conversation/turnRunner');
const {OperationCancelledError,ProcessExitUnconfirmedError}=require('../out/core/operationErrors');
function harness() {
  const events=[],session={id:'s',title:'New Conversation',messages:[],draft:'draft',attachment:{code:'x'}};
  const turn={cancelled:false,user:{id:'u',role:'user',status:'pending'},message:{id:'a',role:'assistant',isPlanMode:false},state:{turnId:'t',sessionId:'s',generation:0},requestId:'r',diagnostics:{mark:name=>events.push(['mark',name])}};
  let current=true,epoch=1,stopping;
  const ports={process:{currentGeneration:4,initInfo:{tools:['invoke_subagent']},exitConfirmed:true,sendMessage:async text=>{events.push(['stdin',text]);}},repository:{saveSession:(s,ids)=>events.push(['save',s.id,ids]),saveMetadata:s=>events.push(['metadata',s.id])},epoch:()=>epoch,current:t=>current&&t===turn,ready:async s=>{events.push(['ready',s.id]);return s;},stopping:()=>stopping,terminationPending:()=>false,releaseConfirmed:()=>events.push(['release']),runtime:()=>events.push(['runtime']),finish:(status,error)=>events.push(['finish',status,error]),phase:(phase,detail)=>events.push(['phase',phase,detail]),snapshot:()=>events.push(['snapshot']),publish:m=>events.push(['publish',m]),persistPartial:()=>events.push(['checkpoint'])};
  const runner=new TurnRunner(ports);
  return {runner,ports,turn,session,events,setCurrent:v=>{current=v;},setEpoch:v=>{epoch=v;},setStopping:v=>{stopping=v;}};
}
function fakeTimers(work) {
  const saved={setTimeout:global.setTimeout,setInterval:global.setInterval,clearTimeout:global.clearTimeout,clearInterval:global.clearInterval};
  const scheduled=[],cleared=[];
  global.setTimeout=(fn,ms)=>{const id=scheduled.length;scheduled.push({fn,ms,type:'timeout',id});return id;};
  global.setInterval=(fn,ms)=>{const id=scheduled.length;scheduled.push({fn,ms,type:'interval',id});return id;};
  global.clearTimeout=id=>{if(id!==undefined)cleared.push(['timeout',id]);};
  global.clearInterval=id=>{if(id!==undefined)cleared.push(['interval',id]);};
  return Promise.resolve().then(()=>work(scheduled,cleared)).finally(()=>Object.assign(global,saved));
}
test('runner preserves successful submit ordering, draft commit and maintenance cadence',()=>fakeTimers(async(timers,cleared)=>{
  const h=harness();const id=await h.runner.run(h.turn,h.session,1,'actual text','visible text',false);
  assert.equal(id,'t');assert.deepEqual(h.session.messages,[h.turn.user]);assert.equal(h.session.title,'visible text');assert.equal(h.turn.user.status,'sent');assert.equal(h.turn.state.generation,4);assert.equal(h.session.draft,'');assert.equal(h.session.attachment,undefined);
  assert.deepEqual(h.events,[['ready','s'],['mark','cli-ready'],['phase','submitted',undefined],['snapshot'],['stdin','actual text'],['mark','stdin-submitted'],['save','s',['u']],['metadata','s'],['publish',{type:'sendAccepted',requestId:'r',turnId:'t'}]]);
  assert.deepEqual(timers.map(x=>[x.type,x.ms]),[['timeout',30000],['interval',1000]]);
  timers[0].fn();timers[1].fn();assert.equal(h.events.at(-1)[0],'checkpoint');
  h.runner.clear();assert(cleared.some(x=>x[0]==='timeout'&&x[1]===0));assert(cleared.some(x=>x[0]==='interval'&&x[1]===1));
  const count=h.events.length;timers[0].fn();timers[1].fn();assert.equal(h.events.length,count);
}));
test('runner startup cancellation and mode/tool mismatch submit no input and preserve draft',async()=>{
  for(const cause of ['cancel-before','cancel-ready','mode','subagent']){
    const h=harness();
    if(cause==='cancel-before')h.turn.cancelled=true;
    if(cause==='cancel-ready')h.ports.ready=async s=>{h.turn.cancelled=true;return s;};
    if(cause==='mode')h.session.planMode=true;
    if(cause==='subagent')h.ports.process.initInfo.tools=[];
    await assert.rejects(h.runner.run(h.turn,h.session,1,'text','display',cause==='subagent'),cause.startsWith('cancel')?OperationCancelledError:/模式|invoke_subagent/);
    assert.equal(h.events.some(e=>e[0]==='stdin'),false);assert.equal(h.session.messages.length,0);assert.equal(h.session.draft,'draft');assert.equal(h.turn.user.status,'failed');h.runner.clear();
  }
});
test('runner awaiting cancelled cleanup preserves uncertain exit error and publishes runtime before finish',async()=>{
  const h=harness(),failure=new ProcessExitUnconfirmedError();
  h.ports.process.exitConfirmed=false;h.ports.terminationPending=()=>true;
  h.ports.ready=async()=>{h.turn.cancelled=true;h.setStopping(Promise.reject(failure));throw new Error('cancelled startup');};
  await assert.rejects(h.runner.run(h.turn,h.session,1,'text','display',false),error=>error===failure);
  assert.equal(h.events.some(e=>e[0]==='release'),false);
  const terminal=h.events.findIndex(e=>e[0]==='finish');assert.equal(h.events[terminal][1],'failed');assert.equal(h.events[terminal-1][0],'runtime');assert.equal(h.events.at(-1)[0],'runtime');
});
test('runner failed send preserves draft and pending user while retaining unconfirmed process claim',async()=>{
  const h=harness(),failure=new Error('stdin result unknown');h.ports.process.exitConfirmed=false;h.ports.terminationPending=()=>true;h.ports.process.sendMessage=async()=>{throw failure;};
  await assert.rejects(h.runner.run(h.turn,h.session,1,'actual','display',false),error=>error===failure);
  assert.equal(h.session.messages[0],h.turn.user);assert.equal(h.turn.user.status,'failed');assert.equal(h.session.draft,'draft');assert.equal(h.session.attachment.code,'x');assert.equal(h.events.some(e=>e[0]==='release'||e[0]==='publish'),false);
});
test('runner does not arm maintenance if protocol result finishes during stdin submission',()=>fakeTimers(async timers=>{
  const h=harness();h.ports.process.sendMessage=async()=>{h.setCurrent(false);};
  assert.equal(await h.runner.run(h.turn,h.session,1,'text','display',false),'t');assert.equal(timers.length,0);assert.equal(h.turn.user.status,'sent');h.runner.clear();
}));
test('runner uses exact Plan and parallel prompts, replacement timers reject stale callbacks',()=>fakeTimers(async timers=>{
  const {PLAN_REQUEST_PREFIX}=require('../out/conversation/planPolicy');const {PARALLEL_EXECUTION_INSTRUCTIONS}=require('../out/conversation/executionIntent');
  const h=harness();h.turn.message.isPlanMode=true;h.session.planMode=true;
  await h.runner.run(h.turn,h.session,1,'方案','display',true);assert(h.events.some(e=>e[0]==='stdin'&&e[1]===PLAN_REQUEST_PREFIX+'方案'));
  h.turn.message.isPlanMode=false;h.session.planMode=false;
  await h.runner.run(h.turn,h.session,1,'实施','display',true);assert(h.events.some(e=>e[0]==='stdin'&&e[1]===PARALLEL_EXECUTION_INSTRUCTIONS+'实施'));
  const count=h.events.length;timers[0].fn();timers[1].fn();assert.equal(h.events.length,count);
  timers[2].fn();timers[3].fn();assert.equal(h.events.length,count+2);h.runner.clear();
}));

test('runner cleanup release error cannot skip failed-round completion or mask original submit failure',async()=>{
  const h=harness(),primary=new Error('submit failed'),cleanup=new Error('claim release I/O failed');
  h.ports.ready=async()=>{throw primary;};h.ports.releaseConfirmed=()=>{throw cleanup;};
  await assert.rejects(h.runner.run(h.turn,h.session,1,'text','display',false),error=>{
    assert(error instanceof AggregateError);assert.equal(error.errors[0],primary);assert.equal(error.errors[1],cleanup);return true;
  });
  const finishes=h.events.filter(e=>e[0]==='finish');assert.equal(finishes.length,1);assert.equal(finishes[0][1],'failed');assert(finishes[0][2].includes('submit failed'));assert(finishes[0][2].includes('claim release I/O failed'));
  assert.equal(h.events[h.events.findIndex(e=>e[0]==='finish')-1][0],'runtime');
  assert.equal(h.session.draft,'draft');assert.equal(h.turn.user.status,'failed');
});
