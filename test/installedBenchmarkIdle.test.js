const test=require('node:test');
const assert=require('node:assert/strict');
const {sidebarIdle}=require('../scripts/sidebar-idle.cjs');
function document(overrides={}){
  const nodes={'#send-btn':{disabled:true},'#mode-select':{disabled:false},'#new-session-btn':{disabled:false},...overrides};
  return {querySelector:selector=>nodes[selector]||null};
}
test('installed-window probe accepts idle empty composer with disabled Send',()=>{
  assert.equal(sidebarIdle(document()),true);
  assert.equal(sidebarIdle(document({'#send-btn':{disabled:false}})),true);
});
test('installed-window probe rejects running, transition and missing controls',()=>{
  for(const nodes of [{'#stop-btn':{}},{'#mode-select':{disabled:true}},{'#new-session-btn':{disabled:true}},
    {'#send-btn':null},{'#mode-select':null},{'#new-session-btn':null}])assert.equal(sidebarIdle(document(nodes)),false);
});
