const {chromium}=require('playwright'),fs=require('fs'),assert=require('assert/strict');
(async()=>{const b=await chromium.connectOverCDP('http://127.0.0.1:9333'),p=b.contexts()[0].pages()[0],r={version:'2.1.2'};
try{
r.title=await p.title();assert.match(r.title,/agy-2\.1\.2-window-acceptance/);assert(!r.title.includes('扩展开发宿主'));
await p.keyboard.press('Control+Shift+P');await p.locator('.quick-input-widget input').fill('>Developer: Reload Window');await p.keyboard.press('Enter');await p.waitForTimeout(7500);
await p.keyboard.press('Control+Shift+P');await p.locator('.quick-input-widget input').fill('>Antigravity: Open Chat Sidebar');await p.keyboard.press('Enter');
let f;for(let i=0;i<50&&!f;i++){for(const frame of p.frames())if(await frame.locator('#message-input').count())f=frame;if(!f)await p.waitForTimeout(500);}if(!f)throw Error('No installed Webview');
r.script=await f.locator('script[src]').getAttribute('src');assert(r.script.includes('antigravity-vscode-extender-2.1.2'));
await f.waitForFunction(()=>document.querySelector('#session-select')?.value && !document.querySelector('#new-session-btn').disabled);const old=await f.locator('#session-select').inputValue();const hadMessages=await f.locator('.message').count();if(hadMessages){await f.locator('#new-session-btn').click();await f.waitForFunction(id=>document.querySelector('#session-select').value!==id,old);}assert.equal(await f.locator('.message').count(),0);await f.locator('#mode-select').selectOption('plan');await f.waitForFunction(()=>!document.querySelector('#mode-select').disabled);
await f.locator('#message-input').fill('请给极简多agent并行执行方案，批准后用一次 invoke_subagent 调用启动两个 research 子代理，第一位只回答 ALPHA_WINDOW212，第二位只回答 BETA_WINDOW212。主代理等待并汇总。不要读取文件、执行命令或写文件。现在只给方案等待批准。');await f.locator('#send-btn').click();
await f.locator('#approve-plan-btn').waitFor({timeout:120000});assert.match(await f.locator('#approve-plan-btn').innerText(),/多 Agent/);assert.equal(await f.locator('#agents-btn').innerText(),'0 Agents');r.planWaiting=true;
await f.locator('#approve-plan-btn').click();await f.locator('#agents-btn').filter({hasText:'2 Agents'}).waitFor({timeout:120000});await f.locator('#send-btn').waitFor({timeout:120000});
await f.locator('#agents-btn').click();await f.locator('.agent-card').first().waitFor();assert.equal(await f.locator('.agent-card').count(),2);r.cards=2;
await f.locator('.agent-card').first().click();await f.locator('.agent-transcript').filter({hasText:/ALPHA_WINDOW212|BETA_WINDOW212/}).waitFor({timeout:10000});r.childDetail=true;r.passed=true;
await p.screenshot({path:'C:/Users/Public/agy-2-acceptance/2.1.2-installed.png'});console.log(r);
}catch(e){r.passed=false;r.error=e.stack;await p.screenshot({path:'C:/Users/Public/agy-2-acceptance/2.1.2-error.png'}).catch(()=>{});console.error(e);}finally{fs.writeFileSync('C:/Users/Public/agy-2-acceptance/2.1.2-installed.json',JSON.stringify(r,null,2));await p.close();await b.close().catch(()=>{});}
})();
