const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {JSDOM}=require('jsdom'),{buildSync}=require('esbuild');
const source=process.env.AGY_RUNTIME_SOURCE||path.resolve(__dirname,'../src/webview/runtime.ts');
function harness(){
  const dom=new JSDOM('<div></div>',{url:'https://runtime.local',runScripts:'outside-only',pretendToBeVisual:true});
  const sent=[],listeners=new Map();let acquired=0;
  const add=dom.window.addEventListener.bind(dom.window);
  dom.window.addEventListener=(type,...args)=>{listeners.set(type,(listeners.get(type)||0)+1);return add(type,...args);};
  dom.window.acquireVsCodeApi=()=>{acquired++;return {postMessage:data=>sent.push(data),getState:()=>({}),setState(){}};};
  const code=buildSync({entryPoints:[source],bundle:true,write:false,platform:'browser',format:'iife',globalName:'runtime',target:'es2022'}).outputFiles[0].text;
  dom.window.eval(code+"\nwindow.runtime=runtime;");
  const receive=m=>dom.window.dispatchEvent(new dom.window.MessageEvent('message',{data:m}));
  return {dom,sent,listeners,receive,runtime:dom.window.runtime,acquired:()=>acquired};
}
test('runtime singleton routes replies once and pagehide rejects outstanding requests',async()=>{
  const h=harness();try{
    assert.equal(h.acquired(),1);assert.equal(h.listeners.get('message'),1);assert.equal(h.listeners.get('pagehide'),1);
    const request=h.runtime.request({command:'ready'});assert.equal(h.sent.length,1);h.receive({type:'requestComplete',requestId:h.sent[0].requestId});await request;
    assert.equal(h.runtime.renderSourceId('path/中文',2),'render-source-'+encodeURIComponent('path/中文')+':2');
    const pending=h.runtime.request({command:'saveDraft'});const failure=assert.rejects(pending,/界面已关闭/);h.dom.window.dispatchEvent(new h.dom.window.Event('pagehide'));await failure;
    assert.equal(h.sent.length,2);assert.equal(h.acquired(),1);
  }finally{h.dom.window.close();}
});
test('runtime forwards preview, agent and tool events once with current-session showAgents fence',()=>{
  const h=harness();try{
    const counts={};for(const name of ['code-preview','agent-detail','tool-detail','show-agents'])h.dom.window.addEventListener(name,()=>counts[name]=(counts[name]||0)+1);
    h.runtime.store.state.session={id:'current'};
    h.receive({type:'previewReady'});h.receive({type:'agentDetail'});h.receive({type:'toolDetail'});
    h.receive({type:'showAgents',sessionId:'old'});h.receive({type:'showAgents',sessionId:'current'});
    assert.deepEqual(counts,{'code-preview':1,'agent-detail':1,'tool-detail':1,'show-agents':1});
  }finally{h.dom.window.dispatchEvent(new h.dom.window.Event('pagehide'));h.dom.window.close();}
});
