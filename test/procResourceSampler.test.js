const test=require('node:test');
const assert=require('node:assert/strict');
const {sampleProcess}=require('../scripts/owned-process-resource.cjs');
function stat(state='S',identity='100'){
  const fields=Array(20).fill('0');fields[0]=state;fields[11]='12';fields[12]='3';fields[19]=identity;
  return '7 (test name) '+fields.join(' ');
}
function setup(sequence,resourceError){
  let reads=0,pauses=0;const races=[];
  const fs={readFile:async file=>{
    if(file.endsWith('/status'))return 'VmRSS:\t42 kB\n';
    const value=sequence[Math.min(reads++,sequence.length-1)];if(value instanceof Error)throw value;return value;
  },readdir:async()=>{if(resourceError)throw resourceError;return ['0','1'];}};
  return {options:{fs,pause:async ms=>{assert.equal(ms,20);pauses++;},onExitRace:record=>races.push(record)},
    state:()=>({reads,pauses,races})};
}
const error=code=>Object.assign(new Error(code),{code});
test('resource sampling checks identity twice and returns observed metrics',async()=>{
  const s=setup([stat(),stat()]);assert.deepEqual(await sampleProcess(7,s.options),{pid:7,startTicks:'100',cpuTicks:15,rssBytes:43008,fdCount:2});
  assert.equal(s.state().reads,2);
});
test('missing and terminal process samples return null without invented metrics',async()=>{
  for(const value of [error('ENOENT'),error('ESRCH'),stat('Z'),stat('X')]){
    const s=setup([value]);assert.equal(await sampleProcess(7,s.options),null);
  }
});
test('PID replacement during successful resource collection is rejected',async()=>{
  const s=setup([stat(),stat('S','200')]);assert.equal(await sampleProcess(7,s.options),null);
});
test('permission errors are skipped only after confirmed exit or identity change',async()=>{
  for(const final of [stat('Z'),stat('X'),error('ENOENT'),stat('S','200')]){
    const s=setup([stat(),stat(),final],error('EACCES'));
    assert.equal(await sampleProcess(7,s.options),null);assert.equal(s.state().pauses,1);
    assert.deepEqual(s.state().races,[{pid:7,startTicks:'100',code:'EACCES'}]);
  }
});
test('persistent live permissions and unrelated errors remain failures',async()=>{
  for(const code of ['EACCES','EPERM','EIO']){
    const original=error(code),s=setup([stat()],original);
    await assert.rejects(sampleProcess(7,s.options),caught=>caught===original);
    assert.equal(s.state().pauses,code==='EIO'?0:5);assert.equal(s.state().races.length,0);
  }
});
test('invalid PID, malformed data and observer failures propagate',async()=>{
  for(const pid of [0,-1,'7',Infinity])await assert.rejects(sampleProcess(pid),TypeError);
  await assert.rejects(sampleProcess(7,setup(['invalid']).options),/Malformed/);
  const s=setup([stat(),stat('Z')],error('EACCES'));s.options.onExitRace=()=>{throw Error('observer failed');};
  await assert.rejects(sampleProcess(7,s.options),/observer failed/);
});
