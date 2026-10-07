// Negative protocol probe only: never starts a model turn or sends an approval.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto'),{execFileSync}=require('node:child_process');
const {AgyProcessManager}=require('../out/core/agyProcessManager');
const directory=path.resolve(process.argv[2]||'diagnostics/protocol-1.2.16-first');
const acceptance=JSON.parse(fs.readFileSync(path.join(directory,'report.json'),'utf8'));
const binaryHash=createHash('sha256').update(fs.readFileSync('/home/ubuntu/.local/lib/antigravity-cli/agy')).digest('hex');
assert.equal(binaryHash,acceptance.identity.binaryHash);assert.equal(execFileSync('/home/ubuntu/.local/bin/agy',['--version'],{encoding:'utf8',timeout:5000}).trim(),'1.2.16');
const pm=new AgyProcessManager(),report={identity:acceptance.identity,format:'event=control_request, request_id, request.type=initialize',notes:['This tests only the former proposed control_request envelope. A rejection does not rule out other undocumented protocol formats. No live approval protocol is verified.'],modelTurns:0};
(async()=>{let timer;
try {
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'agy-116-control-'));report.cwd=cwd;
  await pm.start({cliPath:'/home/ubuntu/.local/bin/agy',cwd,model:'gemini-3.8-flash-high',effort:'high',createProject:true,additionalDirectories:[cwd]});
  const observed=new Promise(resolve=>{
    pm.once('agy_error',error=>resolve({event:'error',error}));
    pm.once('custom_event',event=>resolve({event}));
    pm.once('result',result=>resolve({event:'result',result}));
    pm.once('error',error=>resolve({event:'process-error',error:error.message}));
    timer=setTimeout(()=>resolve({event:'no-response-before-3000ms'}),3000);
  });
  pm.childProcess.stdin.write(JSON.stringify({event:'control_request',request_id:'isolated-probe',request:{type:'initialize'}})+'\n');
  report.observed=await observed;
} catch(error){report.error=error.stack;}
finally {clearTimeout(timer);try{await pm.stop();report.exitConfirmed=pm.exitConfirmed;}catch(error){report.cleanupError=error.stack;report.exitConfirmed=false;}
 fs.writeFileSync(path.join(directory,'control-request-report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));if(!report.exitConfirmed)process.exitCode=1;}
})();
