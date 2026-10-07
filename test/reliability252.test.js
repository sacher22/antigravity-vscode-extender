const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {messageTimeline}=require('../out/webview/messageTimeline');
const {toolOutcome,toolPresentation}=require('../out/core/toolPresentation');
const {actionableCodeBlocks}=require('../out/core/codeBlocks');
const {RecoveryGuard}=require('../out/conversation/recoveryGuard');
const {decodeImage,storeImage}=require('../out/conversation/imageStore');
const {AgyProcessManager}=require('../out/core/agyProcessManager');
const {once}=require('node:events');
test('indexed text/tool/error timeline preserves chronology and late replacements; legacy result comes after known tools',()=>{
 const m={content:'方案',blocks:[{stepIndex:8,text:'方案'}],toolCalls:[{stepIndex:4,name:'list_dir',state:'DONE'},{stepIndex:2,name:'view_file',state:'DONE'}],executionNotices:[{stepIndex:6,text:'错误'}]};
 const timeline=messageTimeline(m);assert.deepEqual(timeline.map(x=>x.stepIndex),[2,4,6,8]);
 assert.deepEqual(messageTimeline(JSON.parse(JSON.stringify(m))),timeline);
 m.toolCalls[1].output='late';assert.deepEqual(messageTimeline(m).map(x=>x.key),timeline.map(x=>x.key));
 delete m.blocks;assert.equal(messageTimeline(m).at(-1).kind,'text');
});
test('tool status distinguishes diagnostics, nonzero exit, active and background; ordinary prose is not parsed as failure',()=>{
 assert.equal(toolOutcome('The command exited with code 1.\n'), 'failed');
 assert.equal(toolOutcome('Traceback (most recent call last):\n'), 'warning');
 assert.equal(toolOutcome('sudo: a password is required\r\n'), 'warning');
 assert.equal(toolOutcome('Tool is running as a background task with task id: xyz'), 'background');
 assert.equal(toolOutcome('Documentation mentions Traceback and code 1'),undefined);
 for(const [name,parameters,expected] of [['view_file',{AbsolutePath:'/project/ref.png'},'已读取 /project/ref.png'],['list_dir',{DirectoryPath:'/project'},'已列出 /project 中的文件'],['run_command',{CommandLine:'blender --version'},'已运行 blender --version']])assert.equal(toolPresentation({name,state:'DONE',parameters}).label,expected);
 assert.equal(toolPresentation({name:'run_command',state:'DONE',outcome:'unknown'}).status,'结果未确认');
});
test('diagram filtering retains exact original fence index and requires a target for file controls',()=>{
 const blocks=actionableCodeBlocks('```mermaid\ngraph TD\n```\n```ts file="src/a.ts"\nx\n```\n```js\ny\n```');
 assert.deepEqual(blocks,[{code:'x\n',blockIndex:1,filePath:'src/a.ts'},{code:'y\n',blockIndex:2,filePath:undefined}]);
});
test('explicit error watchdog deduplicates, resets on real progress, bounds repeated failures and cancels on disposal',async()=>{
 const reasons=[],g=new RecoveryGuard(x=>reasons.push(x),25,3);
 assert.equal(g.error(1),1);assert.equal(g.error(1),undefined);g.progress();assert.equal(g.error(2),1);g.error(3);g.error(4);assert.equal(reasons.length,1);g.dispose();await new Promise(r=>setTimeout(r,40));assert.equal(reasons.length,1);
 const timeout=[],h=new RecoveryGuard(x=>timeout.push(x),15,3);await new Promise(r=>setTimeout(r,20));assert.equal(timeout.length,0,'slow healthy turns have no timer');h.error(9);await new Promise(r=>setTimeout(r,25));assert.equal(timeout.length,1);h.dispose();
});
test('native locally captured error_message is accepted by actual NDJSON parser',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agy-error-replay-'));
 const events=fs.readFileSync(path.join(__dirname,'../diagnostics/local-error-events.jsonl'),'utf8');
 const cli=path.join(dir,'replay.cjs');fs.writeFileSync(cli,'#!/usr/bin/env node\nprocess.stdout.write('+JSON.stringify(events)+');setInterval(()=>{},1000);');fs.chmodSync(cli,0o700);
 const manager=new AgyProcessManager(),seen=[];manager.on('step_update',s=>seen.push(s));try{await manager.start({cliPath:cli,cwd:dir});await new Promise(r=>setTimeout(r,30));assert(seen.some(s=>s.step_type==='error_message'));}finally{await manager.stop();fs.rmSync(dir,{recursive:true,force:true});}
});
test('restored image storage retains bounded originals outside metadata and rejects MIME/header mismatch',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agy-image-store-'));
 const image={mime:'image/png',data:Buffer.from([137,80,78,71,13,10,26,10,0]).toString('base64'),thumbnail:'data:image/jpeg;base64,/9j/'};
 try{const stored=await storeImage(dir,image);assert.equal(fs.statSync(stored.file).mode&0o777,0o600);assert.deepEqual(fs.readFileSync(stored.file),decodeImage(image));assert.throws(()=>decodeImage({...image,mime:'image/jpeg'}));assert.throws(()=>decodeImage({...image,data:'a'.repeat(8*1024*1024)}));}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
