const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {toolPreview,toolPreviewLimit,TOOL_PREVIEW_BYTES}=require('../out/conversation/toolPreview');
const {ConversationRepository}=require('../out/conversation/repository');
test('tool preview budget bounds large messages and never splits surrogate pairs',()=>{
 assert.equal(toolPreviewLimit(1),2048);assert.equal(toolPreviewLimit(100),2048);
 const count=10000,limit=toolPreviewLimit(count);assert(limit*count*2<=TOOL_PREVIEW_BYTES);
 assert.equal(toolPreview('A🙂B',2),'A');assert.equal(toolPreview('A🙂B',3),'A🙂');
});
test('adaptive previews persist bounded metadata and preserve all independent originals',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'agy-tool-preview-budget-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const state={get:(_key,fallback)=>fallback,update:async()=>{}};
 const context={globalStorageUri:{fsPath:root},globalState:state};
 const repo=new ConversationRepository(context),s=repo.createSession('many-tools','m','high');
 const output='完整原文🙂'.repeat(1000),count=600;
 s.messages=[{id:'reply',role:'assistant',content:'reply',timestamp:1,status:'running',toolCalls:Array.from({length:count},(_,i)=>({name:'test',stepIndex:i,state:'DONE',output}))}];
 repo.saveSession(s);await repo.flush();
 assert(s.messages[0].toolCalls.reduce((sum,tool)=>sum+tool.output.length*2,0)<=TOOL_PREVIEW_BYTES);
 for(const index of [0,count-1])assert.equal((await repo.toolOutputAsync(s.id,'reply',index)).output,output);
 repo.saveSession(s);await repo.flush();
 const restored=await ConversationRepository.open(context),saved=await restored.getSessionAsync(s.id);
 assert(saved.messages[0].toolCalls.reduce((sum,tool)=>sum+tool.output.length*2,0)<=TOOL_PREVIEW_BYTES);
 assert.equal((await restored.toolOutputAsync(s.id,'reply',count-1)).output,output);
});
