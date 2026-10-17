import test from 'node:test';
import assert from 'node:assert/strict';
import {compactConversation,conversationSignal,plainPreview,renderRichText,reviewSummary,scrollTopAfterRender} from '../public/conversation.js';

const task=(status='idle',text='All requested work is done.')=>({
 key:'local:task-1',status,latest:{phase:'final_answer',text}
});

test('finished turns clearly say that no reply is needed',()=>{
 const signal=conversationSignal(task(),[]);
 assert.equal(signal.kind,'complete');
 assert.match(signal.title,/no reply needed/i);
});

test('explicit agent questions and next steps take priority over completion',()=>{
 const question=conversationSignal(task('idle','The change is ready. Would you like me to deploy it?'),[]);
 assert.equal(question.kind,'question');
 assert.match(question.body,/deploy it\?/);
 const next=conversationSignal(task('idle','## Next action\nRun the release workflow.'),[]);
 assert.equal(next.kind,'next');
 assert.equal(next.body,'Run the release workflow.');
 const imperative=conversationSignal(task('idle','The automated work is finished. Please unlock the Mac so I can continue.'),[]);
 assert.equal(imperative.kind,'next');
 assert.match(imperative.body,/unlock the Mac/i);
});

test('live approval questions are the clearest and highest-priority signal',()=>{
 const signal=conversationSignal(task('running'),[{id:'a1',task_key:'local:task-1',kind:'approval',status:'open',body:'Which environment?',payload:{method:'item/tool/requestUserInput'}}]);
 assert.deepEqual({kind:signal.kind,title:signal.title,actionId:signal.actionId},{kind:'question',title:'The agent is waiting for your answer',actionId:'a1'});
});

test('interrupted work gives the owner a choice instead of a blank status',()=>{
 const signal=conversationSignal(task('waiting'),[{id:'b1',task_key:'local:task-1',kind:'blocked',status:'open',title:'Task was interrupted',body:'The task stopped.'}]);
 assert.deepEqual({kind:signal.kind,label:signal.label,title:signal.title,focusComposer:signal.focusComposer},{kind:'action',label:'Your choice',title:'Task was interrupted',focusComposer:true});
 assert.match(signal.body,/give the agent a clear next instruction or leave it stopped/i);
});

test('rich conversation formatting is readable and escapes unsafe markup',()=>{
 const html=renderRichText('# Result\n\n- **Done**\n- [Docs](https://example.com)\n\n<script>alert(1)</script>');
 assert.match(html,/<h2[^>]*>Result<\/h2>/);
 assert.match(html,/<ul><li><strong>Done<\/strong><\/li>/);
 assert.match(html,/href="https:\/\/example\.com\/"/);
 assert.doesNotMatch(html,/<script>/);
 assert.match(html,/&lt;script&gt;/);
 const unsafe=renderRichText('[bad](javascript:alert(1))');
 assert.doesNotMatch(unsafe,/href=/);
});

test('task previews remove markdown noise',()=>{
 assert.equal(plainPreview('## Complete\n- Changed `app.js`\n- Added **tests**'),'Complete Changed app.js Added tests');
});

test('repeated technical projection rows collapse without hiding their frequency',()=>{
 const messages=[
  {id:'1',role:'tool',text:'npm test',output:'ok',status:'completed'},
  {id:'2',role:'tool',text:'npm test',output:'ok',status:'completed'},
  {id:'3',role:'assistant',phase:'final_answer',text:'All 12 tests passed.'}
 ];
 const compact=compactConversation(messages);
 assert.equal(compact.length,2);assert.equal(compact[0].repeatCount,2);assert.equal(compact[1].repeatCount,1);
});

test('review summary prioritizes the final response and observed evidence',()=>{
 const summary=reviewSummary([{id:'f',role:'assistant',phase:'final_answer',text:'Implementation complete. All 12 tests passed.'}],{available:true,branch:'codex/work',status:' M app.js\n?? test.js'});
 assert.equal(summary.final.id,'f');assert.equal(summary.changedFiles,2);assert.equal(summary.repository,'Local changes');assert.match(summary.verification,/tests passed/i);
});

test('live conversation renders preserve the reader position and follow the bottom',()=>{
 assert.equal(scrollTopAfterRender({scrollTop:420,scrollHeight:1600,clientHeight:600},1900),420);
 assert.equal(scrollTopAfterRender({scrollTop:995,scrollHeight:1600,clientHeight:600},1900),1300);
 assert.equal(scrollTopAfterRender({scrollTop:900,scrollHeight:1600,clientHeight:600},800),200);
});
