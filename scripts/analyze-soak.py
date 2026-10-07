"""Offline factual resource summary; never infer precise allocation ownership from RSS."""
import argparse,json,pathlib,statistics

def ranges(values):
    return {'min':min(values),'median':statistics.median(values),'max':max(values)}
def interval(before,after):
    elapsed=after['atMs']-before['atMs']
    if elapsed<=0:raise ValueError('Invalid observation interval')
    host_microseconds=sum(after['host']['cpu'][key]-before['host']['cpu'][key] for key in ['user','system'])
    types=set(before['ipc']['types'])|set(after['ipc']['types'])
    result={'elapsedMs':elapsed,'hostCPUPercent':host_microseconds/(elapsed*1000)*100,
      'webviewTaskSeconds':after['webview']['TaskDuration']-before['webview']['TaskDuration'],
      'ipcMessages':after['ipc']['messages']-before['ipc']['messages'],
      'ipcBytes':after['ipc']['bytes']-before['ipc']['bytes'],
      'ipcTypes':{key:after['ipc']['types'].get(key,0)-before['ipc']['types'].get(key,0) for key in sorted(types)},
      'sourceEvents':after['sourceEvents']-before['sourceEvents']}
    result['stableChromiumCPUPercent']={}
    prior={(p['pid'],p['startTicks']):p for p in before['chromium']}
    for p in after['chromium']:
        old=prior.get((p['pid'],p['startTicks']))
        if old:
            kind=p['type']
            result['stableChromiumCPUPercent'][kind]=result['stableChromiumCPUPercent'].get(kind,0)+(p['cpuSeconds']-old['cpuSeconds'])/(elapsed/1000)*100
    return result
def summarize(report):
    if report.get('status')!='passed' or report.get('durationMs')!=7200000 or report.get('actualContinuousMs',0)<7200000:
        raise ValueError('Complete two-hour report not passed')
    if report.get('cleanup',{}).get('ownLiveProcessCount')!=0:raise ValueError('Owned cleanup not proven')
    samples=[sample for sample in report['samples'] if sample.get('phase')=='continuous']
    if len(samples)<100:raise ValueError('Insufficient resource observations')
    quarters=[]
    for index in range(4):
        group=samples[index*len(samples)//4:(index+1)*len(samples)//4]
        quarters.append({'quarter':index+1,'samples':len(group),'fromMs':group[0]['atMs'],'toMs':group[-1]['atMs'],
          'hostRSSBytes':ranges([s['host']['memory']['rss'] for s in group]),
          'hostHeapUsedBytes':ranges([s['host']['memory']['heapUsed'] for s in group]),
          'webviewHeapUsedBytes':ranges([s['webview']['JSHeapUsedSize'] for s in group]),
          'hostHandles':ranges([s['host']['handles'] for s in group]),
          'runners':ranges([s['runners'] for s in group]),
          'transcriptBytes':ranges([s['caches']['transcripts']['estimatedBytes'] for s in group]),
          'trackedLiveCLIProcesses':ranges([len(s['cli']) for s in group])})
    budget_violations=sum(s['caches']['transcripts']['overBudget'] or
        s['caches']['transcripts']['sessions']>s['caches']['transcripts']['maxSessions'] or
        s['caches']['messages']['entries']>s['caches']['messages']['maxEntries'] or
        s['caches']['messages']['estimatedBytes']>s['caches']['messages']['maxBytes'] or
        s['caches']['tools']['entries']>s['caches']['tools']['maxEntries'] or
        s['caches']['tools']['estimatedBytes']>s['caches']['tools']['maxBytes'] for s in samples)
    return {'status':'summarized-passed-two-hour-report','actualContinuousMs':report['actualContinuousMs'],
      'loops':report['loops'],'samples':len(samples),'idle':interval(report['idle']['before'],report['idle']['after']),
      'hidden':interval(report['hidden']['before'],report['hidden']['after']),
      'continuous':interval(samples[0],samples[-1]),'quarters':quarters,'observedCacheBudgetViolations':budget_violations,
      'queuePeakEstimatedBytes':max(s['writeQueue']['peakEstimatedBytes'] for s in samples),
      'finalQueueEstimatedBytes':report['after']['writeQueue']['estimatedBytes'],'cleanup':report['cleanup'],
      'notes':['No forced GC during original continuous observation; window minima are observed low points, not controlled retained-heap measurements.',
        'Host RSS includes V8 allocation capacity, live output, production caches and the benchmark retaining every resource sample; exact allocation attribution is unavailable.',
        'Three fake CLI background answers keep growing; transcript byte growth is real retained conversation data.',
        'CPU percentages use local cumulative counters and sampled wall intervals; newly created/exited Chromium processes are not imputed.',
        'Real CLI/delegation and short backend/Chromium probes ran on this host during continuous phase after idle/hidden baseline; rendering latency matrix ran separately.',
        'Write budget is an estimated soft queue/backpressure threshold, not an RSS cap; GC collectibility from the separate panel probe is not a controlled GC of this full soak.']}
def main():
    parser=argparse.ArgumentParser();parser.add_argument('input');parser.add_argument('output');args=parser.parse_args()
    report=summarize(json.loads(pathlib.Path(args.input).read_text()))
    pathlib.Path(args.output).write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({key:report[key] for key in ['actualContinuousMs','loops','samples','observedCacheBudgetViolations','finalQueueEstimatedBytes']}))
if __name__=='__main__':main()
