const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto'),{execFileSync}=require('node:child_process');
const {AgyProcessManager}=require('../out/core/agyProcessManager');
const source=path.resolve(process.argv[2]||'diagnostics/protocol-1.2.16-first');
const input=JSON.parse(fs.readFileSync(path.join(source,'report.json'),'utf8'));
assert(input.passed);const identity=()=>({version:execFileSync('/home/ubuntu/.local/bin/agy',['--version'],{encoding:'utf8',timeout:5000}).trim(),binaryHash:createHash('sha256').update(fs.readFileSync('/home/ubuntu/.local/lib/antigravity-cli/agy')).digest('hex')});
assert.deepEqual(identity(),input.identity);
const report={identity:input.identity,model:input.model,cases:[],notes:['Only initialization/stop are tested: schema is experimental; sandbox launch does not prove OS isolation; resume init does not prove full TUI return.']};
async function launch(name,options) {
  const pm=new AgyProcessManager(),record={name,passed:false};report.cases.push(record);
  try {record.id=await pm.start({cliPath:'/home/ubuntu/.local/bin/agy',model:input.model,effort:'high',...options});record.init=pm.initInfo;assert.equal(record.init.model,input.model);assert.equal(record.init.cwd,options.cwd);if(options.conversationId)assert.equal(record.id,options.conversationId);record.passed=true;}
  catch(error){record.error=error.stack;}
  finally {try{await pm.stop();record.exitConfirmed=pm.exitConfirmed;if(!record.exitConfirmed)record.passed=false;}catch(error){record.cleanupError=error.stack;record.passed=false;}}
  if(!record.exitConfirmed)throw new Error('Owned process stop not confirmed');
}
(async()=>{
try {
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'agy-116-schema-launch-'));
  const schemaPath=path.join(cwd,'schema.json');fs.writeFileSync(schemaPath,JSON.stringify({type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false}));
  await launch('schema-sandbox-initialization',{cwd,schemaPath,sandbox:true,createProject:true,additionalDirectories:[cwd]});
  const previous=input.cases.find(c=>c.name==='stream-continuation');
  await launch('resume-initialization',{cwd:previous.cwd,conversationId:previous.cliId,additionalDirectories:[previous.cwd]});
  assert.deepEqual(identity(),input.identity);report.passed=report.cases.every(c=>c.passed);
} catch(error){report.error=error.stack;report.passed=false;}
finally {fs.writeFileSync(path.join(source,'launch-report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));if(!report.passed)process.exitCode=1;}
})();
