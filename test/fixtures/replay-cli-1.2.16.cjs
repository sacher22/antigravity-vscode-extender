#!/usr/bin/env node
if(process.argv[2]==='--version'){console.log('1.2.16');process.exit(0);}
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
const samples=JSON.parse(fs.readFileSync(path.join(__dirname,'cli-1.2.16-captured.json'),'utf8'));
const plan=process.argv.includes('plan');
const base=samples.cases[plan?'readonly-plan':'stream-continuation'];
const cliId='captured-replay-root';
const write=event=>process.stdout.write(JSON.stringify(event)+'\n');
write({event:'init',conversation_id:cliId,init:{...base.init,cwd:process.cwd()}});
readline.createInterface({input:process.stdin}).on('line',line=>{
  const input=JSON.parse(line),text=input.message.content[0].text;
  const name=Object.keys(samples.cases).find(name=>text.includes(name));
  const sample=samples.cases[name];if(!sample)throw new Error('Unknown captured case');
  for(const event of sample.events){const copied=JSON.parse(JSON.stringify(event));if(copied.step_update.conversation_id)copied.step_update.conversation_id=cliId;write(copied);}
  write({event:'result',result:{...sample.result,conversation_id:cliId}});
});
