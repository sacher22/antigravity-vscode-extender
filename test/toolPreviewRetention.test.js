const test=require('node:test');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const path=require('node:path');
test('small tool previews do not retain their multi-megabyte source strings after GC',()=>{
 const probe=`const {toolPreview}=require(process.argv[1]);
 function collect(){for(let i=0;i<3;i++)global.gc();return process.memoryUsage().heapUsed;}
 const before=collect();
 function make(i){const original=String(i).padStart(8,'0')+'中文🙂'.repeat(250000);return toolPreview(original,128);}
 const previews=Array.from({length:30},(_,i)=>make(i));
 const after=collect();
 if(previews.some((value,i)=>!value.startsWith(String(i).padStart(8,'0'))||value.length>128))throw Error('preview content');
 const delta=after-before;
 console.log(JSON.stringify({sources:30,sourceCharactersEach:1000008,previewCharactersMax:128,before,after,delta}));
 if(delta>4*1024*1024)throw Error('small previews retain large sources');`;
 const result=spawnSync(process.execPath,['--expose-gc','-e',probe,path.resolve('out/conversation/toolPreview.js')],{encoding:'utf8',timeout:30000});
 assert.equal(result.status,0,result.stderr+result.stdout);
 const report=JSON.parse(result.stdout);assert(report.delta<4*1024*1024);
 console.log(JSON.stringify({probe:'tool-preview-retention',...report}));
});
