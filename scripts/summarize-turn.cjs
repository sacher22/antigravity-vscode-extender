// Offline acceptance helper; no production imports, clocks or private fields.
const milestones=new Set(['accepted','cli-ready','stdin-submitted','first-cli-text',
  'webview-first-posted','execution-ended','storage-committed']);
const renderKeys=['hostPostToAckUpperBoundMs','receiptToDOMMs','DOMToFrameMs'];
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const bounded=(value,max)=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=max;
function summarizeTurn(events){
  if(!Array.isArray(events)||events.length>512)throw new Error('Malformed diagnostic events');
  let turn;
  for(let index=events.length-1;index>=0;index--){
    const e=events[index];
    if(object(e)&&e.milestone==='accepted'&&typeof e.turn==='string'&&e.turn.length>0&&e.turn.length<=128){turn=e.turn;break;}
  }
  if(turn===undefined)return null;
  const result={turn,milestones:{},firstRender:null,completedRender:null};
  for(const e of events){
    if(!object(e)||e.turn!==turn)continue;
    if(milestones.has(e.milestone)&&bounded(e.elapsedMs,3600000)&&!Object.hasOwn(result.milestones,e.milestone))
      result.milestones[e.milestone]=e.elapsedMs;
    if(e.milestone!=='webview-render'||!['firstText','completedText'].includes(e.kind)||
      !renderKeys.every(key=>bounded(e[key],60000))||!Number.isSafeInteger(e.sourceLength)||e.sourceLength<1||e.sourceLength>50000000)continue;
    const key=e.kind==='firstText'?'firstRender':'completedRender';
    if(result[key]!==null)continue;
    result[key]=Object.fromEntries([...renderKeys,'sourceLength'].map(key=>[key,e[key]]));
  }
  return result;
}
module.exports={summarizeTurn};
