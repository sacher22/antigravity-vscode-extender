const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const assert=require('node:assert/strict');
const {ConversationRepository}=require('../out/conversation/repository');
const {ConversationController}=require('../out/conversation/controller');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check){for(let i=0;i<3000;i++){if(await check())return;await delay(10);}throw new Error('real pipe probe timed out');}
(async()=>{
 if(typeof global.gc!=='function')throw new Error('requires --expose-gc for post-run diagnostic');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'agy-real-pipe-resource-'));
 const state={get:(_key,fallback)=>fallback,update:async()=>{}};
 const repo=await ConversationRepository.open({globalStorageUri:{fsPath:root},globalState:state});
 const c=new ConversationController({config:()=>({cliPath:path.resolve('test/fixtures/pressure-agy.cjs'),defaultModel:'gemini-3.8-flash-high',reasoningEffort:'high',dangerouslySkipPermissions:false}),workspace:()=>({root,directories:[root]}),log(){},setPermissions:async()=>{},terminal(){}},repo);
 const before=process.memoryUsage(),cpu=process.cpuUsage(),started=performance.now(),samples=[],transitions=[];
 let steps=0,unblock,blocked=false;const gate=new Promise(r=>unblock=r);
 const atomic=repo.atomic.bind(repo);
 repo.atomic=async(file,raw)=>{if(!blocked&&file.includes(path.sep+'tools'+path.sep)){blocked=true;await gate;}return atomic(file,raw);};
 c.processManager.on('step_update',step=>{if(step.step_type==='tool'&&++steps%10===0)c.persistPartial();});
 repo.on('storagePressure',()=>transitions.push({atMs:performance.now()-started,...repo.writeQueueStats}));
 const timer=setInterval(()=>samples.push({atMs:performance.now()-started,memory:process.memoryUsage(),queue:repo.writeQueueStats}),100);
 try{
  await c.sendMessage('stress');await until(()=>repo.writeQueueStats.paused);
  await delay(200);const pausedSteps=steps,producer=JSON.parse(await fs.readFile(path.join(root,'progress.json'),'utf8'));
  await delay(200);assert.equal(steps,pausedSteps);assert(pausedSteps<2000);assert(producer.written<2000);
  assert.equal(JSON.parse(await fs.readFile(path.join(root,'progress.json'),'utf8')).written,producer.written);
  unblock();await until(()=>!c.processing);await repo.flush();clearInterval(timer);assert.equal(steps,2000);
  const queue=repo.writeQueueStats;assert.equal(queue.estimatedBytes,0);
  const session=c.currentSessionMeta,reply=session.messages.find(message=>message.role==='assistant');assert.equal(reply.toolCalls.length,2000);
  let bytes=0;
  for(let i=0;i<2000;i++){
   let offset=0,output='';for(;;){const page=await repo.toolOutputAsync(session.id,reply.id,i+1,offset);output+=page.output;if(!page.hasMore)break;offset=page.nextOffset;}
   assert.equal(output,('工具原文🙂'+i+':').repeat(4000));bytes+=Buffer.byteLength(output);
  }
  const after=process.memoryUsage();global.gc();await delay(0);global.gc();const afterGC=process.memoryUsage();
  await c.dispose();await repo.releaseTranscript(session.id,()=>true);global.gc();await delay(0);global.gc();const afterReleaseGC=process.memoryUsage();
  const report={environment:'isolated WSL Node/controller/repository/drain-aware POSIX CLI, actual stdout; no Webview/model',steps,toolOutputBytes:bytes,pausedSteps,producerPausedAt:producer.written,queue,before,after,afterGC,afterReleaseGC,samples,transitions,cachesAfterRelease:repo.cacheStats,cpuMicroseconds:process.cpuUsage(cpu),elapsedMs:performance.now()-started,notes:['Default 64MiB/16MiB write budget; soft threshold and conservative UTF-16 reference accounting, not RSS limit','Full originals verified for all 2000 tools; forced GC is post-run diagnostics only','100ms samples cannot prove true instantaneous peaks; no GUI/model latency or 2h acceptance claim']};
  await fs.writeFile(path.resolve(process.env.AGY_PIPE_OUTPUT || 'diagnostics/optimization-real-pipe-resource.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({steps,toolOutputBytes:bytes,pausedSteps,producerPausedAt:producer.written,queue,afterGC,afterReleaseGC,samplePeakHeap:Math.max(...samples.map(s=>s.memory.heapUsed)),samplePeakRSS:Math.max(...samples.map(s=>s.memory.rss))},null,2));
 }finally{clearInterval(timer);unblock();await c.dispose();await repo.flush();await fs.rm(root,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
