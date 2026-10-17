import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {Engine} from '../src/engine.js';
import {Store} from '../src/store.js';
import {DEMO_ITEM_IDS,demoConfig,demoRejectsMutation,demoRequested} from '../src/demo.js';

async function unusedPort(){const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');const port=address.port;server.close();await once(server,'close');return port;}

test('demo workspace is synthetic, useful, and disconnected from real integrations',async()=>{
 const store=new Store(':memory:'),engine=new Engine(demoConfig(0),store,'.');
 try{
  engine.start();
  const state=engine.state(),work=engine.workItems({limit:50}).items;
  assert.deepEqual(engine.config.hosts,[]);assert.equal(engine.config.sources,undefined);assert.equal(engine.config.runtime,undefined);
  assert.equal(engine.hosts.length,0);assert.equal(engine.adapters.length,0);assert.equal(engine.runtime.config,undefined);assert.equal(engine.timer,undefined);
  assert.equal(state.demo.enabled,true);assert.equal(state.demo.ephemeral,true);assert.equal(work.length,8);
  assert.deepEqual(new Set(work.flatMap(item=>item.sourceRefs.map(source=>source.adapter))),new Set(['codex','hermes','openclaw','openwebui']));
  assert.ok(state.actions.some(action=>action.kind==='approval'&&action.status==='open'));assert.ok(state.actions.some(action=>action.kind==='failure'&&action.status==='open'));assert.ok(state.actions.some(action=>action.kind==='completion'&&action.status==='open'));
  assert.equal(state.shadowAnalysis.mode,'proposal-only');assert.equal(state.shadowAnalysis.enabled,false);assert.equal(state.shadowAnalysis.total.analyses,1);
  assert.ok(state.briefing.recommendations.items.some((entry:any)=>entry.analysisMode==='shadow'));
  assert.equal(state.sources.length,4);assert.equal(state.sources.every(source=>source.online&&!source.stale),true);assert.equal(state.runtime.online,true);assert.ok(state.runtime.loadedModels.length>=2);
  const detail=await engine.detail(DEMO_ITEM_IDS.billing);assert.equal(detail.task.title,'Add a billing audit trail');assert.ok(detail.messages.some(message=>message.phase==='final_answer'));assert.equal(detail.git.available,true);
 }finally{engine.close();store.close();}
});

test('demo selection and mutation guard are explicit',()=>{
 assert.equal(demoRequested(['node','server','--demo'],{}),true);assert.equal(demoRequested(['node','server'],{THREADHELM_DEMO:'1'}),true);assert.equal(demoRequested(['node','server'],{ASTRA_DEMO:'1'}),true);assert.equal(demoRequested(['node','server'],{}),false);
 for(const path of ['/api/approval','/api/approval/expired-decision','/api/send','/api/continue','/api/pause','/api/archive','/api/create','/api/chat','/api/hosts/refresh','/api/shadow-analysis/run','/api/briefing/apply'])assert.equal(demoRejectsMutation(path),true,path);
 for(const path of ['/api/refresh','/api/watch','/api/actions/resolve','/api/actions/resolve-many'])assert.equal(demoRejectsMutation(path),false,path);
 const pkg=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));assert.equal(pkg.scripts.demo,'tsx src/server.ts --demo');
});

test('demo server starts without a config file and blocks real-agent control routes',{timeout:15000},async()=>{
 const port=await unusedPort(),env={...process.env,THREADHELM_DEMO_PORT:String(port)};delete env.THREADHELM_CONFIG;delete env.ASTRA_CONFIG;
 const child=spawn(process.execPath,['--import','tsx','src/server.ts','--demo'],{cwd:new URL('..',import.meta.url),env,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
 try{
  let health:any;for(let attempt=0;attempt<50;attempt++){try{const response=await fetch(`http://127.0.0.1:${port}/healthz`);if(response.ok){health=await response.json();break;}}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
  assert.ok(health,output||'Demo server did not become ready');assert.equal(health.demo,true);assert.equal(health.hosts.length,2);assert.equal(health.sources.length,4);
  const stateResponse=await fetch(`http://127.0.0.1:${port}/api/state`),state:any=await stateResponse.json();assert.equal(stateResponse.status,200);assert.equal(state.demo.enabled,true);
  assert.ok(state.briefing.nowRunning.total>=1);assert.ok(state.briefing.decisions.total>=1);assert.ok(state.briefing.recommendations.total>=1);assert.ok(state.briefing.nextSteps.total>=1);
  const recommendation=state.briefing.recommendations.items[0],feedback=await fetch(`http://127.0.0.1:${port}/api/briefing/feedback`,{method:'POST',headers:{Origin:`http://127.0.0.1:${port}`,'Content-Type':'application/json','X-ThreadHelm':state.csrf},body:JSON.stringify({recommendationId:recommendation.id,evidenceRevision:recommendation.evidenceRevision,taskKey:recommendation.taskKey||null,rating:'useful'})});assert.equal(feedback.status,200);
  const blocked=await fetch(`http://127.0.0.1:${port}/api/send`,{method:'POST',headers:{Origin:`http://127.0.0.1:${port}`,'Content-Type':'application/json','X-ThreadHelm':state.csrf},body:JSON.stringify({requestId:'demo-request-1',key:DEMO_ITEM_IDS.onboarding,prompt:'hello'})}),blockedBody:any=await blocked.json();
  assert.equal(blocked.status,409);assert.match(blockedBody.error,/disabled in demo mode/i);
 }finally{child.kill('SIGTERM');await Promise.race([once(child,'exit'),new Promise(resolve=>setTimeout(resolve,3000))]);}
});
