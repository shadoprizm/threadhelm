import type {SourceObservation} from './adapters.js';
import {buildTaskBriefing} from './briefing.js';
import type {AdapterName,Config,Message,RuntimeSnapshot,WorkCapabilities,WorkItem,WorkKind,WorkStatus} from './types.js';
import type {Store} from './store.js';

const observedCapabilities:WorkCapabilities={detail:true,deepLink:false,send:false,steer:false,pause:false,approve:false,git:false};
const codexCapabilities:WorkCapabilities={detail:true,deepLink:false,send:true,steer:true,pause:true,approve:true,git:true};

interface DemoItemInput {
 adapter:AdapterName;sourceId:string;nativeId:string;hostId:string;title:string;kind:WorkKind;status:WorkStatus;
 updatedAt:number;cwd?:string;profile?:string;agent?:string;provider?:string;requestedModel?:string;resolvedModel?:string;
 locality:'local'|'cloud'|'hybrid'|'unknown';watched?:boolean;managed?:boolean;owned?:boolean|null;branch?:string;
 statusConfidence?:'authoritative'|'heuristic';error?:string;messages:Message[];
}

export const DEMO_ITEM_IDS={
 onboarding:'codex:demo-codex:onboarding',
 billing:'codex:demo-codex:billing-audit',
 support:'hermes:demo-hermes:support-triage',
 sync:'hermes:demo-hermes:customer-sync',
 release:'openclaw:demo-openclaw:release-captain',
 dependencies:'openclaw:demo-openclaw:dependency-report',
 research:'openwebui:demo-openwebui:launch-research',
 positioning:'openwebui:demo-openwebui:positioning'
} as const;

export function demoRequested(argv:string[]=process.argv,env:NodeJS.ProcessEnv=process.env){return argv.includes('--demo')||env.THREADHELM_DEMO==='1'||env.ASTRA_DEMO==='1';}

export function demoConfig(port=4318):Config{return {port,hosts:[],mode:'demo'};}

export function demoRejectsMutation(path:string){return new Set(['/api/approval','/api/approval/expired-decision','/api/send','/api/continue','/api/pause','/api/archive','/api/create','/api/chat','/api/hosts/refresh','/api/shadow-analysis/run','/api/briefing/apply']).has(path);}

function message(id:string,role:string,text:string,minutesAgo:number,phase?:string,extra:Partial<Message>={}):Message{return {id,role,text,at:Date.now()-minutesAgo*60000,...(phase?{phase}:{}),...extra};}

function observation(input:DemoItemInput):SourceObservation{
 const capabilities=input.adapter==='codex'?codexCapabilities:observedCapabilities,source={adapter:input.adapter,sourceId:input.sourceId,hostId:input.hostId,nativeId:input.nativeId,profile:input.profile,agent:input.agent,capabilities},latest=input.messages.at(-1),id=`${input.adapter}:${input.sourceId}:${input.nativeId}`;
 const item:WorkItem={key:id,id,kind:input.kind,title:input.title,status:input.status,statusConfidence:input.statusConfidence||'authoritative',updatedAt:input.updatedAt,observedAt:Date.now(),archived:false,pinned:false,watched:!!input.watched,latestExcerpt:latest?.text,sourceRefs:[source],execution:{host:input.hostId,provider:input.provider,requestedModel:input.requestedModel,resolvedModel:input.resolvedModel,locality:input.locality},hostId:input.hostId,cwd:input.cwd||'',branch:input.branch,latest,messages:input.messages,model:input.requestedModel,error:input.error,managed:!!input.managed,owned:input.owned??null};
 return {item,source,correlations:[],native:{demo:true,nativeId:input.nativeId}};
}

export function seedDemoStore(store:Store,now=Date.now()){
 const minutes=(value:number)=>now-value*60000;
 const items=[
  observation({adapter:'codex',sourceId:'demo-codex',nativeId:'onboarding',hostId:'demo-local',title:'Polish the first-run onboarding flow',kind:'agent-task',status:'active',updatedAt:minutes(2),cwd:'/workspace/agent-hub',provider:'openai',requestedModel:'gpt-6-astra',locality:'cloud',watched:true,managed:true,owned:true,branch:'codex/onboarding',messages:[message('onboarding-user','user','Add a zero-credential demo and make the first five minutes feel effortless.',24),message('onboarding-tool','tool','npm test',8,undefined,{status:'completed',exitCode:0,output:'46 tests passed'}),message('onboarding-update','assistant','The sample workspace is isolated in memory. I am tightening the visual demo label and mutation guard now.',2)]}),
  observation({adapter:'codex',sourceId:'demo-codex',nativeId:'billing-audit',hostId:'demo-build',title:'Add a billing audit trail',kind:'agent-task',status:'completed',updatedAt:minutes(7),cwd:'/workspace/customer-portal',provider:'openai',requestedModel:'gpt-5.6-sol',locality:'cloud',watched:true,managed:true,owned:false,branch:'codex/billing-audit',messages:[message('billing-user','user','Record every subscription change and verify the migration.',55),message('billing-change','change','src/billing/audit.ts\ntests/billing-audit.test.ts',18),message('billing-final','assistant','Implemented the subscription audit trail with actor, source, and before/after fields. Added migration coverage and verified the full test suite: 82 tests passed.',7,'final_answer')]}),
  observation({adapter:'hermes',sourceId:'demo-hermes',nativeId:'support-triage',hostId:'demo-build',title:'Triage this week\'s support themes',kind:'agent-task',status:'recent',updatedAt:minutes(5),profile:'support',provider:'ollama',requestedModel:'qwen3:14b',resolvedModel:'qwen3:14b',locality:'local',statusConfidence:'heuristic',messages:[message('support-user','user','Group the latest tickets into themes and flag anything urgent.',38),message('support-latest','assistant','Two themes dominate: onboarding confusion and expired invite links. I am checking whether either correlates with the latest release.',5)]}),
  observation({adapter:'hermes',sourceId:'demo-hermes',nativeId:'customer-sync',hostId:'demo-build',title:'Reconcile customer sync exceptions',kind:'agent-task',status:'failed',updatedAt:minutes(13),profile:'operations',provider:'anthropic',requestedModel:'claude-sonnet-4-5',locality:'cloud',error:'The upstream CRM rejected 12 records after its schema changed.',messages:[message('sync-user','user','Reconcile last night\'s failed customer records.',31),message('sync-error','assistant','The CRM now requires `account_region`. Twelve records are paused; no writes were retried.',13)]}),
  observation({adapter:'openclaw',sourceId:'demo-openclaw',nativeId:'release-captain',hostId:'demo-build',title:'Prepare the v0.3 release',kind:'agent-task',status:'waiting',updatedAt:minutes(4),agent:'release-captain',provider:'openai',requestedModel:'gpt-5.6-terra',locality:'cloud',watched:true,messages:[message('release-user','user','Prepare the release notes and stop before publishing.',27),message('release-latest','assistant','Release notes and checks are ready. Waiting for confirmation of the final version number before tagging.',4)]}),
  observation({adapter:'openclaw',sourceId:'demo-openclaw',nativeId:'dependency-report',hostId:'demo-build',title:'Nightly dependency risk report',kind:'automation',status:'completed',updatedAt:minutes(34),agent:'maintenance',provider:'ollama',requestedModel:'qwen3:8b',locality:'local',watched:true,messages:[message('dependencies-final','assistant','No critical advisories found. Two minor updates are available; neither changes the public API.',34,'final_answer')]}),
  observation({adapter:'openwebui',sourceId:'demo-openwebui',nativeId:'launch-research',hostId:'demo-local',title:'Research launch communities',kind:'conversation',status:'active',updatedAt:minutes(1),provider:'openai',requestedModel:'gpt-5.6-sol',locality:'cloud',messages:[message('research-user','user','Find communities where multi-agent operators already compare workflows.',16),message('research-latest','assistant','I have a shortlist across self-hosting, Codex, OpenClaw, and local-model communities. Next I am ranking them by fit and promotion rules.',1)]}),
  observation({adapter:'openwebui',sourceId:'demo-openwebui',nativeId:'positioning',hostId:'demo-local',title:'Launch positioning brainstorm',kind:'conversation',status:'idle',updatedAt:minutes(42),provider:'openrouter',requestedModel:'anthropic/claude-sonnet-4.5',resolvedModel:'anthropic/claude-sonnet-4.5',locality:'cloud',messages:[message('positioning-user','user','What is the shortest honest description of this product?',49),message('positioning-final','assistant','A private action inbox for every AI agent you already use.',42,'final_answer')]})
 ];
 const ids=items.map(item=>store.upsertSource(item));
 store.watch(DEMO_ITEM_IDS.billing,true);store.watch(DEMO_ITEM_IDS.dependencies,true);store.watch(DEMO_ITEM_IDS.release,true);store.watch(DEMO_ITEM_IDS.onboarding,true);
 store.action('approval','Review database migration command','The agent wants to run the read-only migration verification against the staging snapshot.',DEMO_ITEM_IDS.onboarding,'demo:approval',{demo:true,method:'item/commandExecution/requestApproval',params:{command:'npm run verify:migration -- --staging-snapshot',reason:'Confirm the migration is safe before release.',availableDecisions:['accept','decline']}});
 store.action('failure','Customer sync needs attention','The CRM schema changed. Twelve records remain paused and were not retried.',DEMO_ITEM_IDS.sync,'demo:failure',{demo:true});
 store.action('blocked','Release version needed','Choose the final version number before the release captain creates a tag.',DEMO_ITEM_IDS.release,'demo:blocked',{demo:true});
 store.action('completion','Billing audit is ready for review','The agent added the audit trail and reports 82 passing tests.',DEMO_ITEM_IDS.billing,'demo:billing-complete',{demo:true});
 store.action('review','Migration evidence attached','Review the schema and rollback notes before merging.',DEMO_ITEM_IDS.billing,'demo:billing-review',{demo:true});
 const handled=store.action('completion','Dependency report completed','No critical advisories were found.',DEMO_ITEM_IDS.dependencies,'demo:dependency-complete',{demo:true});store.resolve(handled.id);
 const shadowItem=store.workItem(DEMO_ITEM_IDS.sync);
 if(shadowItem){
  const brief=buildTaskBriefing(shadowItem,store.openActions()),reservation=store.reserveShadowAnalysis(shadowItem.key,brief.evidenceRevision,'demo','gpt-5.6-luna',742,20,100000,now);
  if(reservation.accepted)store.finishShadowAnalysis(reservation.id,{category:'resolve-decision',title:'Confirm the CRM field mapping',recommendation:'Review the proposed account-region mapping before any paused records are retried.',rationale:'The upstream schema changed and twelve records remain paused, so the next useful step is an owner decision on the mapping.',risk:'An incorrect mapping could put customer records in the wrong region.',confidence:'high',nextCheckpoint:'A confirmed mapping or a revised data contract.',inputTokens:1240,outputTokens:118,latencyMs:1650},now);
 }
 return ids;
}

export function demoWorkspace(now=Date.now()){
 const models={
  codex:[{id:'gpt-6-astra'},{id:'gpt-5.6-sol'},{id:'gpt-5.6-terra'}],
  hermes:[{id:'qwen3:14b'},{id:'claude-sonnet-4-5'}],
  openclaw:[{id:'gpt-5.6-terra'},{id:'qwen3:8b'}],
  openwebui:[{id:'gpt-5.6-sol'},{id:'anthropic/claude-sonnet-4.5'}]
 };
 const source=(id:string,adapter:AdapterName,name:string,hostId:string,itemCount:number,activeCount:number,catalog:any[])=>({id,adapter,name,hostId,online:true,stale:false,lastSeen:now,error:'',version:'demo',itemCount,activeCount,models:catalog});
 const runtime:RuntimeSnapshot={observedAt:now,online:true,error:'',catalog:[{id:'qwen3:14b',provider:'ollama',locality:'local'},{id:'qwen3:8b',provider:'ollama',locality:'local'},{id:'gpt-6-astra',provider:'openai',locality:'cloud'},{id:'claude-sonnet-4-5',provider:'anthropic',locality:'cloud'}],router:{mode:'balanced',defaultRoute:'cloud',localFallback:'qwen3:14b',healthyRoutes:3},metrics:{astra_router_requests_total:1842,astra_gpu_loaded_models:2,astra_model_failures_total:1},loadedModels:[{id:'qwen3:14b',size:9000000000,expiresAt:new Date(now+24*60*60000).toISOString()},{id:'qwen3:8b',size:5200000000,expiresAt:new Date(now+6*60*60000).toISOString()}],providers:['ollama','openai','anthropic','openrouter']};
 return {
  demo:{enabled:true,ephemeral:true,label:'Sample workspace'},
  projects:[{id:'demo-agent-hub',hostId:'demo-local',name:'agent-hub',roots:['/workspace/agent-hub'],source:'codex' as const,recencyAt:now},{id:'demo-customer-portal',hostId:'demo-build',name:'customer-portal',roots:['/workspace/customer-portal'],source:'codex' as const,recencyAt:now-60000}],
  hosts:[{id:'demo-local',name:'Studio Mac',online:true,lastSeen:now,error:'',runtimeConnected:true,projectsError:'',inventoryCount:4},{id:'demo-build',name:'Build Server',online:true,lastSeen:now,error:'',runtimeConnected:true,projectsError:'',inventoryCount:4}],
  sources:[source('demo-codex','codex','Codex fleet','demo-local',2,1,models.codex),source('demo-hermes','hermes','Hermes','demo-build',2,1,models.hermes),source('demo-openclaw','openclaw','OpenClaw','demo-build',2,0,models.openclaw),source('demo-openwebui','openwebui','Open WebUI','demo-local',2,1,models.openwebui)],
  runtime
 };
}

export function demoGit(key:string){
 if(key===DEMO_ITEM_IDS.onboarding)return {available:true,branch:'codex/onboarding',head:'ab31fe42d77a',upstream:'origin/main',ahead:1,behind:0,status:' M README.md\n M src/server.ts\n?? src/demo.ts',diffStat:' README.md     | 18 +++++++++++++\n src/demo.ts   | 94 +++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++\n src/server.ts | 12 ++++++--\n 3 files changed, 119 insertions(+), 5 deletions(-)',stagedStat:''};
 if(key===DEMO_ITEM_IDS.billing)return {available:true,branch:'codex/billing-audit',head:'7d2ca19c884f',upstream:'origin/main',ahead:2,behind:0,status:'',diffStat:'',stagedStat:''};
 return {available:false,error:'Repository state is managed by the source system.'};
}
