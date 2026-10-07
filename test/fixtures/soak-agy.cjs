#!/usr/bin/env node
// Isolated resource fixture: real stdout protocol and drain-aware producer.
const fs = require('node:fs');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const readline = require('node:readline');
if (process.argv[2] === 'models') {console.log('gemini-3.8-flash-high\tFixture'); process.exit(0);}
if (process.argv[2] === 'agents') {console.log('research'); process.exit(0);}
if (process.argv[2] === '--version') {console.log('1.2.14'); process.exit(0);}
const at = process.argv.indexOf('--conversation');
const id = at >= 0 ? process.argv[at + 1] : 'soak-' + require('node:crypto').randomUUID();
const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'});
fs.appendFileSync('fixture-processes.jsonl', JSON.stringify({pid:process.pid, child:child.pid, id})+'\n');
const write = async value => {if (!process.stdout.write(JSON.stringify(value)+'\n')) await once(process.stdout,'drain');};
let streaming = false;
void write({event:'init',conversation_id:id,init:{cwd:process.cwd(),model:'gemini-3.8-flash-high'}});
readline.createInterface({input:process.stdin,crlfDelay:Infinity}).on('line', async line => {
  const text = JSON.parse(line).message.content[0].text;
  if (text === 'stream') {
    if (streaming) return;
    streaming = true;
    let index=0;
    while (streaming) {
      await write({event:'step_update',step_update:{step_index:2,step_type:'agent_response',state:'ACTIVE',text_delta:'后台流🙂'+index+'\n'}});
      if (++index % 10 === 0) await write({event:'step_update',step_update:{step_index:4,step_type:'tool',state:'ACTIVE',tool_name:'fixture',tool_info:{output:'工具原文 '+index+' '+ 'x'.repeat(2048)}}});
      await new Promise(resolve=>setTimeout(resolve,200));
    }
    return;
  }
  await write({event:'step_update',step_update:{step_index:2,step_type:'agent_response',state:'DONE',text_delta:'持续轮次完成：'+text}});
  await write({event:'result',result:{status:'SUCCESS',duration_seconds:0.01}});
});
