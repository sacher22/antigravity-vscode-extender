const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {resolveModel,resolveExecutionProfile}=require(process.env.AGY_PROFILE_MODULE || '../out/conversation/executionProfileResolver');
const session=(extra={})=>({id:'local',model:'gemini-3.8-flash-high',effort:'high',messages:[],...extra});
const config={dangerouslySkipPermissions:true};
const workspace={root:'/workspace',directories:['/workspace','/extra']};
const input=(extra={})=>({session:session(),config,cliPath:'/launcher/agy',workspace,...extra});

test('resolver preserves verified family depths and refuses unsupported max without downgrade',()=>{
  for(const family of ['gemini-3.8-flash','gemini-3.7-flash','gemini-3.6-flash'])for(const effort of ['low','medium','high'])
    assert.deepEqual(resolveModel(family+'-high',effort),{familyModel:family+'-high',effectiveModel:family+'-'+effort,effort});
  assert.throws(()=>resolveModel('gemini-3.1-pro-high','medium'),/不支持/);
  assert.throws(()=>resolveModel('gemini-3.8-flash-high','max'),/没有降级/);
  assert.throws(()=>resolveModel('unverified-high','max'),/没有降级/);
  assert.deepEqual(resolveModel('external-model','max'),{familyModel:'external-model',effectiveModel:'external-model',effort:'max'});
  assert.equal(resolveModel('external-low','high').effort,'low');
});
test('ordinary profile preserves launcher cwd native ID agent permissions sandbox and frozen directories',()=>{
  const data=input({session:session({cliConversationId:'native',customAgent:'research',sandbox:true})});
  const before=JSON.stringify(data);let planCalls=0;
  const profile=resolveExecutionProfile(data,()=>{planCalls++;throw Error('not Plan');});
  assert.equal(planCalls,0);assert.equal(JSON.stringify(data),before);
  assert.equal(profile.requestedModel,data.session.model);assert.equal(profile.options.cliPath,'/launcher/agy');
  assert.equal(profile.options.cwd,'/workspace');assert.equal(profile.options.conversationId,'native');
  assert.equal(profile.options.createProject,false);assert.equal(profile.options.agent,'research');
  assert.equal(profile.options.dangerouslySkipPermissions,true);assert.equal(profile.options.sandbox,true);
  assert(Object.isFrozen(profile));assert(Object.isFrozen(profile.options));assert(Object.isFrozen(profile.options.additionalDirectories));
  assert.notEqual(profile.options.additionalDirectories,workspace.directories);
});
test('Plan resolves only restricted agent and excludes Danger and schema while preserving native identity',()=>{
  const directories=['/workspace','/extra'];const data=input({session:session({planMode:true,cliConversationId:'plan-native',customAgent:'unsafe',schemaPath:'/missing-schema'}),workspace:{root:'/workspace',directories}});
  const before=JSON.stringify(data);const calls=[];
  const profile=resolveExecutionProfile(data,(...args)=>{calls.push(args);return 'readonly-agent';});
  assert.deepEqual(calls,[[undefined,directories]]);assert.equal(profile.options.agent,'readonly-agent');
  assert.equal(profile.options.dangerouslySkipPermissions,false);assert.equal(profile.options.schemaPath,undefined);
  assert.equal(profile.options.conversationId,'plan-native');assert.equal(profile.options.isPlanMode,true);
  assert.equal(JSON.stringify(data),before);
  assert.throws(()=>resolveExecutionProfile(data,()=>{throw Error('Agent definition changed');}),/definition changed/);
});
test('ordinary schema fingerprint and config changes affect signature; native ID alone does not',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agy-profile-resolver-'));const file=path.join(dir,'schema.json');
  try {
    fs.writeFileSync(file,'{"type":"object"}');
    const data=input({session:session({schemaPath:file})});const first=resolveExecutionProfile(data);
    assert.equal(first.options.createProject,true);assert.equal(first.options.schemaPath,file);
    const second=resolveExecutionProfile({...data,session:{...data.session,cliConversationId:'new-native'}});
    assert.equal(first.signature,second.signature);
    fs.writeFileSync(file,'{"type":"string"}');const third=resolveExecutionProfile(data);
    assert.notEqual(first.schemaFingerprint,third.schemaFingerprint);assert.notEqual(first.signature,third.signature);
    assert.notEqual(third.signature,resolveExecutionProfile({...data,config:{dangerouslySkipPermissions:false}}).signature);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
