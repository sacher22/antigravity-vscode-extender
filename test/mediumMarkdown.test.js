const test=require('node:test');const assert=require('node:assert/strict');const {JSDOM}=require('jsdom');
const {segmentLongMarkdown,updateStreamText,TEXT_SEGMENT_SIZE,LONG_TEXT_THRESHOLD,MARKDOWN_TEXT_SEGMENT_THRESHOLD}=require('../out/webview/longText');
const {linkFileReferences}=require('../out/webview/fileLinks');
test('medium completed paragraphs become bounded without changing streaming threshold',()=>{
 const dom=new JSDOM('<main></main>');try{const main=dom.window.document.querySelector('main');
 for(let i=0;i<32;i++){const p=dom.window.document.createElement('p');p.textContent='中文🙂 '+ 'word '.repeat(6000);main.append(p);}
 const before=main.textContent;segmentLongMarkdown(main);assert.equal(main.textContent,before);
 for(const p of main.children){assert(p.querySelectorAll('.text-segment').length>=3);for(const span of p.querySelectorAll('.text-segment'))assert(span.textContent.length<=TEXT_SEGMENT_SIZE);}
 assert.equal(LONG_TEXT_THRESHOLD,32768);assert.equal(MARKDOWN_TEXT_SEGMENT_THRESHOLD,16384);
 const stream=dom.window.document.createElement('div');updateStreamText(stream,'s'.repeat(25000),'');assert.equal(stream.children.length,0);
 }finally{dom.window.close();}
});
test('medium Markdown segmentation retains inline markup and boundary file targets',()=>{
 const dom=new JSDOM('<main><p><strong>Heading</strong> </p></main>');const prior={document:global.document,NodeFilter:global.NodeFilter};
 try{global.document=dom.window.document;global.NodeFilter=dom.window.NodeFilter;const main=dom.window.document.querySelector('main'),p=main.firstChild;
 const target='/tmp/owned-target.ts:12';p.append(dom.window.document.createTextNode('x'.repeat(8180)+' '+target+' '+'y'.repeat(17000)));
 const code=dom.window.document.createElement('code');code.textContent='/tmp/owned path.ts';p.append(code);const before=p.textContent;
 segmentLongMarkdown(main);linkFileReferences(main);assert.equal(p.textContent,before);assert.equal(p.querySelector('strong').textContent,'Heading');
 const links=[...p.querySelectorAll('a')].map(n=>n.getAttribute('href'));assert(links.includes(target));assert(links.includes('/tmp/owned path.ts'));
 }finally{global.document=prior.document;global.NodeFilter=prior.NodeFilter;dom.window.close();}
});
