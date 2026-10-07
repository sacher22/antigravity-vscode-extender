// Explicit owned fixture only; actual CLI backend, no VS Code window or settings mutation.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {ConversationRepository}=require('../out/conversation/repository');
const {ConversationController}=require('../out/conversation/controller');
const {processGroupExited}=require('../out/core/processGroup');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const output=path.resolve(process.argv[2]);assert(!fs.existsSync(output),'Preserve existing evidence');fs.mkdirSync(output,{recursive:true});
const root=fs.mkdtempSync(path.join(os.tmpdir(),'agy-real-tool-stop-'));
const marker=path.join(root,'owned-tool.json');
fs.writeFileSync(path.join(root,'stop-tool.py'),`import json,os,pathlib,time\npid=os.getpid()\nfields=pathlib.Path('/proc/'+str(pid)+'/stat').read_text().rsplit(')',1)[1].split()\npathlib.Path('owned-tool.json').write_text(json.dumps({'pid':pid,'group':os.getpgrp(),'startTicks':fields[19]}))\ntime.sleep(30)\n`);
function stat(pid){try{const file=fs.readFileSync('/proc/'+pid+'/stat','utf8');const parts=file.slice(file.lastIndexOf(')')+2).trim().split(/\s+/);return {state:parts[0],ppid:Number(parts[1]),group:Number(parts[2]),startTicks:parts[19]};}catch(error){if(error.code==='ENOENT'||error.code==='ESRCH')return;throw error;}}
function ownedTool(identity){const current=stat(identity.pid);if(!current||current.startTicks!==identity.startTicks||['Z','X'].includes(current.state))return false;
 assert.equal(fs.statSync('/proc/'+identity.pid).uid,process.getuid());assert.equal(fs.realpathSync('/proc/'+identity.pid+'/cwd'),root);
 const args=fs.readFileSync('/proc/'+identity.pid+'/cmdline','utf8').split('\0').filter(Boolean);assert.equal(args.length,2);assert.equal(path.basename(args[0]),'python3');assert.equal(args[1],'stop-tool.py');return true;}
(async()=>{const state={get:(_key,fallback)=>fallback,update:async()=>{}};const repo=await ConversationRepository.open({globalStorageUri:{fsPath:path.join(root,'storage')},globalState:state});
 const controller=new ConversationController({config:()=>({cliPath:'/home/ubuntu/.local/bin/agy',defaultModel:'gemini-3.8-flash-high',reasoningEffort:'high',dangerouslySkipPermissions:true}),workspace:()=>({root,directories:[root]}),log(){},setPermissions:async()=>{},terminal(){}},repo);
 const report={root,model:'gemini-3.8-flash-high',effort:'high',permission:'Danger',status:'running',events:[],notes:['Actual Controller/Repository/CLI run_command tool in new owned workspace, no GUI. File marker identifies only this child. Final installed-window Stop still required.']};let identity;
 const save=()=>fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');save();
 controller.on('message',message=>{if(message.type==='turnState')report.events.push({type:message.type,phase:message.state.phase,atMs:performance.now()});});
 try{
  await controller.sendMessage('Explicit isolated acceptance test: use run_command exactly once to execute python3 stop-tool.py in the CURRENT workspace. This prewritten script only records its own PID to owned-tool.json then sleeps for 30 seconds. Do not change this script, do not read or write any other files, do not start agents or repeat the command. Let the command run; the extension will stop it for the test.');
  const deadline=performance.now()+180000;while(!fs.existsSync(marker)){if(performance.now()>deadline)throw Error('Actual tool PID marker deadline');await wait(20);}
  identity=JSON.parse(fs.readFileSync(marker,'utf8'));assert(ownedTool(identity),'Own tool is alive before Stop');
  report.tool=identity;report.cliPid=controller.processManager.processPid;report.toolBefore=stat(identity.pid);report.actualInit=controller.processManager.initInfo;
  assert.equal(report.actualInit.model,report.model);assert.equal(report.actualInit.cwd,root);assert.equal(report.actualInit.permission_mode,'always-proceed');
  const stopped=performance.now();await controller.abortTurn();await repo.flush();report.stopAwaitMs=performance.now()-stopped;
  report.cliGroupExited=await processGroupExited(report.cliPid);report.toolAfter=stat(identity.pid);report.toolExited=!ownedTool(identity);report.status=report.cliGroupExited&&report.toolExited?'passed':'failed';save();
 }catch(error){report.status='failed';report.error=error.message;save();}
 finally{
  await controller.dispose();await repo.flush();
  if(identity&&ownedTool(identity)){// Only verified own fixture PID; never kill its possibly-shared parent group.
   process.kill(identity.pid,'SIGTERM');for(let i=0;i<100&&ownedTool(identity);i++)await wait(20);
   if(ownedTool(identity)){process.kill(identity.pid,'SIGKILL');for(let i=0;i<100&&ownedTool(identity);i++)await wait(20);}
   report.fixtureCleanupRequired=true;report.fixtureCleanupExited=!ownedTool(identity);
  }
  save();console.log(JSON.stringify({status:report.status,cliGroupExited:report.cliGroupExited,toolExited:report.toolExited,toolGroup:report.tool?.group,cliPid:report.cliPid,stopAwaitMs:report.stopAwaitMs,fixtureCleanupRequired:report.fixtureCleanupRequired,error:report.error}));
  if(report.status!=='passed')process.exitCode=1;
 }
})().catch(error=>{console.error(error.message);process.exitCode=1;});
