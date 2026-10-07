const test = require('node:test');
const assert = require('node:assert/strict');
const {validateComparison} = require(process.env.AGY_COMPARISON_VALIDATOR || '../scripts/comparison-validator.cjs');
const config = {model:'gemini-3.8-flash-high',effort:'high',permission:'Danger',launcherIdentity:'launcher-hash',cliVersion:'1.2.16',binaryHash:'binary-hash',workspace:'private-directory',interfaceFingerprint:'private-interface-hash'};
function fixture(){return ['native','stream','sidebar'].flatMap(path=>['short','read','tool'].flatMap(scene=>['cold','warm'].flatMap(temperature=>[1,2,3,4,5].map(index=>({path,scene,temperature,index,status:'passed',durationMs:index,metric:path==='stream'?'submit-to-first-response-event':'submit-to-visible',config:{...config}})))));}
test('full90 result is deterministic, exact nearest rank and does not mutate frozen rows',()=>{
 const rows=fixture();for(const row of rows){Object.freeze(row.config);Object.freeze(row)}Object.freeze(rows);
 const result=validateComparison(rows);assert.equal(result.success,true);assert.equal(result.total,90);assert.equal(result.groups.length,18);
 assert.deepEqual(result.groups[0],{path:'native',scene:'short',temperature:'cold',samples:5,passed:5,failed:0,p95Ms:5});assert.equal(result.groups.at(-1).path,'sidebar');assert.deepEqual(validateComparison([...rows].reverse()),result);
});
test('failed slow samples count, remain in nearest rank and make success false',()=>{
 const rows=fixture();rows[0].status='failed';rows[0].durationMs=999;const result=validateComparison(rows);assert.equal(result.success,false);assert.equal(result.groups[0].failed,1);assert.equal(result.groups[0].passed,4);assert.equal(result.groups[0].p95Ms,999);
});
test('missing, extra, duplicate, invalid dimensions and metrics reject with static errors',()=>{
 for(const value of [undefined,null,{},[],fixture().slice(1),[...fixture(),fixture()[0]]])assert.throws(()=>validateComparison(value));
 for(const key of ['path','scene','temperature','metric'])for(const value of ['private-secret',[],{},null,17]){const rows=fixture();rows[1][key]=value;assert.throws(()=>validateComparison(rows),error=>!error.message.includes('private-secret'))}
 for(const [key,value] of [['path',['native']],['scene',['short']],['temperature',['cold']]]){const rows=fixture();rows[0][key]=value;assert.throws(()=>validateComparison(rows),'array coercion must not become valid dimension')}
 const duplicate=fixture();duplicate[1].index=1;assert.throws(()=>validateComparison(duplicate));
});
test('durations, index, status and every required effective config field verified without leaking values',()=>{
 for(const value of [NaN,Infinity,-1,'1',null]){const rows=fixture();rows[0].durationMs=value;assert.throws(()=>validateComparison(rows))}
 for(const value of [0,6,1.5,'1',null]){const rows=fixture();rows[0].index=value;assert.throws(()=>validateComparison(rows))}
 const failed=fixture();failed[0].status='error';assert.throws(()=>validateComparison(failed));
 for(const key of Object.keys(config))for(const value of [undefined,'','private-secret',null,42]){const rows=fixture();rows[1].config[key]=value;assert.throws(()=>validateComparison(rows),error=>!error.message.includes('private-secret'))}
 for(const value of [null,[],42]){const rows=fixture();rows[0].config=value;assert.throws(()=>validateComparison(rows))}
 const extra=fixture();extra[1].config.optional='ignored';assert.equal(validateComparison(extra).success,true);
});
