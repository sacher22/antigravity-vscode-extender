const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {JSDOM}=require('jsdom'),{buildSync}=require('esbuild');
const source=path.resolve(process.env.AGY_COMPOSER_SOURCE||path.resolve(__dirname,'../src/webview/ComposerInput.tsx'));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function harness(){
  const dom=new JSDOM('<div id="root"></div>',{url:'https://input.local',runScripts:'outside-only',pretendToBeVisual:true});
  const code=buildSync({stdin:{contents:'import React from "react";import {createRoot} from "react-dom/client";import {ComposerInput} from '+JSON.stringify(source)+';const root=createRoot(document.getElementById("root"));window.renderInput=props=>root.render(React.createElement(ComposerInput,props));window.disposeInput=()=>root.unmount();',resolveDir:path.resolve(__dirname,'..')},bundle:true,write:false,platform:'browser',format:'iife',target:'es2022'}).outputFiles[0].text;
  dom.window.eval(code);
  const edits=[],selections=[],dismissals=[];let sends=0;
  const props={draft:'/',planMode:false,candidates:[{command:'/help',description:'help'},{command:'/plan',description:'plan'}],completionIndex:-1,
    setCompletionIndex:next=>{props.completionIndex=typeof next==='function'?next(props.completionIndex):next;selections.push(props.completionIndex);dom.window.renderInput(props);},
    setCompletionDismissed:value=>dismissals.push(value),input:{current:null},composing:{current:false},compositionEnded:{current:0},edit:text=>edits.push(text),send:()=>sends++};
  dom.window.renderInput(props);await delay(25);const input=dom.window.document.querySelector('#message-input');assert(input);
  const key=(key,extra={})=>{const e=new dom.window.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...extra});input.dispatchEvent(e);return e;};
  return {dom,props,input,key,edits,selections,dismissals,sends:()=>sends,async close(){dom.window.disposeInput();dom.window.close();}};
}
test('standalone input preserves IME selection, post-composition fence and Shift+Enter across renders',async()=>{
  const h=await harness();try{
    h.input.dispatchEvent(new h.dom.window.CompositionEvent('compositionstart',{bubbles:true}));
    h.key('Enter',{isComposing:true,keyCode:229});h.key('Tab');assert.equal(h.sends(),0);assert.deepEqual(h.edits,[]);
    h.props.planMode=true;h.dom.window.renderInput({...h.props});await delay(10);assert.equal(h.props.composing.current,true,'parent IME ref survives re-render');
    h.input.dispatchEvent(new h.dom.window.CompositionEvent('compositionend',{bubbles:true}));h.key('Enter');assert.equal(h.sends(),0);
    await delay(40);h.key('Enter',{shiftKey:true});assert.equal(h.sends(),0);
    h.dom.window.renderInput({...h.props,candidates:[],draft:'你好'});await delay(10);h.key('Enter');assert.equal(h.sends(),1);
    assert(h.input.placeholder.includes('规划'));assert.equal(h.props.input.current,h.input);
  }finally{await h.close();}
});
test('standalone input preserves arrows Tab Escape mouse selection and modified Enter semantics',async()=>{
  const h=await harness();try{
    assert.equal(h.input.getAttribute('aria-controls'),'slash-completions');
    h.key('ArrowDown');await delay(10);assert.equal(h.selections.at(-1),0);assert.equal(h.input.getAttribute('aria-activedescendant'),'slash-completion-0');
    h.key('ArrowUp');await delay(10);assert.equal(h.selections.at(-1),1);
    h.key('Tab');assert.equal(h.edits.at(-1),'/plan ');assert.equal(h.sends(),0);
    h.key('Escape');assert.equal(h.dismissals.at(-1),true);assert.equal(h.selections.at(-1),-1);
    h.dom.window.document.querySelector('#slash-completion-0').click();assert.equal(h.edits.at(-1),'/help ');
    h.key('Enter',{ctrlKey:true});assert.equal(h.sends(),1,'preserve original ctrl+Enter send semantics');
  }finally{await h.close();}
});
