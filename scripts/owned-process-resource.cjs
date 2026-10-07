// Benchmark-only /proc sampling. Missing or exited identities are not live resources.
const path=require('node:path');
const missing=error=>['ENOENT','ESRCH'].includes(error?.code);
function parseStat(raw) {
  const boundary=raw.lastIndexOf(')');
  const fields=raw.slice(boundary+1).trim().split(/\s+/);
  if(boundary<0 || fields.length<20 || !/^\d+$/.test(fields[19]) ||
    !/^\d+$/.test(fields[11]) || !/^\d+$/.test(fields[12]))throw new Error('Malformed process stat');
  return {state:fields[0],startTicks:fields[19],cpuTicks:Number(fields[11])+Number(fields[12])};
}
async function sampleProcess(pid,{fs=require('node:fs').promises,procRoot='/proc',
  pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),onExitRace=()=>{}}={}) {
  if(!Number.isSafeInteger(pid)||pid<=0)throw new TypeError('Invalid process PID');
  const root=path.join(procRoot,String(pid));
  const readStat=async()=>{try{return parseStat(await fs.readFile(path.join(root,'stat'),'utf8'));}
    catch(error){if(missing(error))return null;throw error;}};
  const exited=stat=>!stat || ['Z','X'].includes(stat.state);
  const before=await readStat();
  if(exited(before))return null;
  let status,fd;
  try{[status,fd]=await Promise.all([fs.readFile(path.join(root,'status'),'utf8'),fs.readdir(path.join(root,'fd'))]);}
  catch(error){
    if(missing(error))return null;
    if(!['EACCES','EPERM'].includes(error.code))throw error;
    for(let index=0;index<6;index++){
      const current=await readStat();
      if(exited(current)||current.startTicks!==before.startTicks){
        onExitRace({pid,startTicks:before.startTicks,code:error.code});return null;
      }
      if(index<5)await pause(20);
    }
    throw error;
  }
  const after=await readStat();
  if(exited(after)||after.startTicks!==before.startTicks)return null;
  const rss=status.match(/^VmRSS:\s+(\d+)\s+kB\s*$/m);
  if(!rss || !Array.isArray(fd))throw new Error('Malformed process resources');
  return {pid,startTicks:after.startTicks,cpuTicks:after.cpuTicks,rssBytes:Number(rss[1])*1024,fdCount:fd.length};
}
module.exports={sampleProcess};
