const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

function safeHref(value){
 try { const url=new URL(value); return url.protocol==='https:'||url.protocol==='http:'?url.href:null; }
 catch { return null; }
}

function inlineMarkdown(value){
 const tokens=[];
 const hold=html=>{const marker=`\uE000${tokens.length}\uE001`;tokens.push(html);return marker;};
 let source=String(value??'');
 source=source.replace(/`([^`\n]+)`/g,(_,code)=>hold(`<code>${escapeHtml(code)}</code>`));
 source=source.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g,(whole,label,url)=>{
  const href=safeHref(url);
  return href?hold(`<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`):whole;
 });
 let html=escapeHtml(source)
  .replace(/\*\*([^*\n]+)\*\*/g,'<strong>$1</strong>')
  .replace(/__([^_\n]+)__/g,'<strong>$1</strong>')
  .replace(/~~([^~\n]+)~~/g,'<del>$1</del>');
 return html.replace(/\uE000(\d+)\uE001/g,(_,index)=>tokens[Number(index)]||'');
}

const signalClass=value=>{
 const text=String(value).replace(/[*_`:#]/g,'').trim();
 if(/^(questions?|answer needed|need from you|decision needed)/i.test(text))return ' signal-question';
 if(/^(next (?:step|steps|action|actions)|action required|to continue)/i.test(text))return ' signal-next';
 if(/^(complete|completed|done|finished|result|summary)/i.test(text))return ' signal-complete';
 return '';
};

const listMatch=line=>line.match(/^\s*([-+*]|\d+[.)])\s+(.+)$/);
const tableCells=line=>line.trim().replace(/^\||\|$/g,'').split('|').map(cell=>cell.trim());
const tableDivider=line=>/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);

/** Render the small, safe Markdown subset commonly used in Codex responses. */
export function renderRichText(value){
 const lines=String(value??'').replace(/\r\n?/g,'\n').split('\n');
 const blocks=[];
 for(let i=0;i<lines.length;){
  const line=lines[i];
  if(!line.trim()){i++;continue;}
  const fence=line.match(/^\s*```([\w+-]*)\s*$/);
  if(fence){
   const code=[];i++;
   while(i<lines.length&&!/^\s*```\s*$/.test(lines[i]))code.push(lines[i++]);
   if(i<lines.length)i++;
   const language=fence[1]?`<span>${escapeHtml(fence[1])}</span>`:'';
   blocks.push(`<div class="code-block">${language}<pre><code>${escapeHtml(code.join('\n'))}</code></pre></div>`);
   continue;
  }
  const heading=line.match(/^(#{1,4})\s+(.+)$/);
  if(heading){const level=Math.min(4,heading[1].length+1);blocks.push(`<h${level} class="rich-heading${signalClass(heading[2])}">${inlineMarkdown(heading[2])}</h${level}>`);i++;continue;}
  if(/^\s*(?:-{3,}|\*{3,})\s*$/.test(line)){blocks.push('<hr>');i++;continue;}
  if(i+1<lines.length&&line.includes('|')&&tableDivider(lines[i+1])){
   const headers=tableCells(line);i+=2;const rows=[];
   while(i<lines.length&&lines[i].includes('|')&&lines[i].trim())rows.push(tableCells(lines[i++]));
   blocks.push(`<div class="table-wrap"><table><thead><tr>${headers.map(cell=>`<th>${inlineMarkdown(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${headers.map((_,column)=>`<td>${inlineMarkdown(row[column]||'')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
   continue;
  }
  if(listMatch(line)){
   const ordered=/^\d/.test(listMatch(line)[1]),items=[];
   while(i<lines.length){
    const match=listMatch(lines[i]);if(!match||/^\d/.test(match[1])!==ordered)break;
    let body=match[2];const check=body.match(/^\[([ xX])\]\s+(.+)$/);
    if(check)body=`<span class="check ${check[1].trim()?'checked':''}" aria-hidden="true">${check[1].trim()?'✓':''}</span>${inlineMarkdown(check[2])}`;
    else body=inlineMarkdown(body);
    items.push(`<li>${body}</li>`);i++;
   }
   const tag=ordered?'ol':'ul';blocks.push(`<${tag}>${items.join('')}</${tag}>`);continue;
  }
  if(/^\s*>\s?/.test(line)){
   const quote=[];while(i<lines.length&&/^\s*>\s?/.test(lines[i]))quote.push(lines[i++].replace(/^\s*>\s?/,''));
   blocks.push(`<blockquote>${quote.map(inlineMarkdown).join('<br>')}</blockquote>`);continue;
  }
  const paragraph=[];
  while(i<lines.length&&lines[i].trim()&&!/^\s*```/.test(lines[i])&&!/^(#{1,4})\s+/.test(lines[i])&&!listMatch(lines[i])&&!/^\s*>\s?/.test(lines[i])&&!/^\s*(?:-{3,}|\*{3,})\s*$/.test(lines[i])){
   if(i+1<lines.length&&lines[i].includes('|')&&tableDivider(lines[i+1]))break;
   paragraph.push(lines[i++]);
  }
  if(paragraph.length)blocks.push(`<p>${paragraph.map(inlineMarkdown).join('<br>')}</p>`);
 }
 return blocks.join('');
}

export function plainPreview(value,max=450){
 const text=String(value??'')
  .replace(/```[\s\S]*?```/g,' Code example. ')
  .replace(/\[([^\]]+)\]\([^)]+\)/g,'$1')
  .replace(/^\s{0,3}(?:#{1,6}|[-+*>]|\d+[.)])\s+/gm,'')
  .replace(/[*_`~]/g,'').replace(/\s+/g,' ').trim();
 return text.length>max?`${text.slice(0,max-1).trimEnd()}…`:text;
}

const messageSignature=message=>[message.role,message.text,message.output,message.status,message.exitCode].map(value=>String(value??'')).join('\u0000');

/** Remove repeated projection rows while retaining an explicit repeat count. */
export function compactConversation(messages){
 const compact=[];
 for(const message of messages||[]){
  if(!message?.text)continue;
  const previous=compact.at(-1);
  if(previous&&['tool','change'].includes(message.role)&&messageSignature(previous)===messageSignature(message)){
   previous.repeatCount=(previous.repeatCount||1)+1;
   previous.at=message.at||previous.at;
   continue;
  }
  compact.push({...message,repeatCount:message.repeatCount||1});
 }
 return compact;
}

/** Keep a reader's place across a live panel render, while following new content at the bottom. */
export function scrollTopAfterRender(previous,nextScrollHeight,stickThreshold=48){
 const clientHeight=Math.max(0,Number(previous?.clientHeight)||0);
 const previousHeight=Math.max(clientHeight,Number(previous?.scrollHeight)||0);
 const previousTop=Math.max(0,Number(previous?.scrollTop)||0);
 const distanceFromBottom=Math.max(0,previousHeight-clientHeight-previousTop);
 const nextMaximum=Math.max(0,(Number(nextScrollHeight)||0)-clientHeight);
 return distanceFromBottom<=stickThreshold?nextMaximum:Math.min(previousTop,nextMaximum);
}

function verificationLine(value){
 const lines=signalText(value).split('\n').map(line=>line.replace(/^[-+*\d.)\s]+/,'').trim()).filter(Boolean);
 return lines.find(line=>/\b(?:tests?|checks?|build|lint|typecheck|pytest|vitest|jest|npm test)\b/i.test(line)&&/\b(?:pass(?:ed|ing)?|fail(?:ed|ing)?|green|successful|complete|not run|not tested|pending)\b/i.test(line))?.slice(0,220)||null;
}

/** Build a compact review header from the latest response and observed Git state. */
export function reviewSummary(messages,git={}){
 const conversation=compactConversation(messages);
 const assistants=conversation.filter(message=>message.role==='assistant'&&message.text);
 const final=assistants.findLast(message=>message.phase==='final_answer')||assistants.at(-1)||null;
 const statusLines=String(git.status||'').split('\n').filter(Boolean);
 return {
  final,
  changedFiles:statusLines.length,
  repository:git.available===false?'Unavailable':statusLines.length?'Local changes':'Clean',
  branch:git.branch||'No branch',
  verification:verificationLine(final?.text||'')||'No verification result was reported in the latest response.'
 };
}

function signalText(value){
 return String(value??'').replace(/```[\s\S]*?```/g,'').replace(/`[^`]+`/g,'').replace(/\[([^\]]+)\]\([^)]+\)/g,'$1').replace(/[*_#>]/g,'').trim();
}

function directQuestion(value){
 const text=signalText(value),matches=[...text.matchAll(/(?:^|[.!]\s+|\n)\s*((?:(?:would|could|can|which|what|when|where|who|why|how|should|do|does|did|are|is|will|may)\b|please\s+(?:choose|confirm|tell))[^?\n]{2,260}\?)/gim)];
 return matches.at(-1)?.[1]?.replace(/\s+/g,' ').trim()||null;
}

function nextAction(value){
 const lines=signalText(value).split('\n').map(line=>line.trim()).filter(Boolean);
 const labelPattern=/^(?:(?:your\s+)?next (?:step|steps|action|actions)|action required|to continue|what i need from you|the remaining (?:owner )?step)\b/i;
 const index=lines.findIndex(line=>labelPattern.test(line.replace(/^[-+\d.)\s]+/,'')));
 if(index>=0){
  const label=lines[index].replace(/^[-+\d.)\s]+/,'');
  const inline=label.replace(/^(?:(?:your\s+)?next (?:step|steps|action|actions)|action required|to continue|what i need from you|the remaining (?:owner )?step(?: is)?)\s*[:—-]?\s*/i,'');
  const detail=(inline||lines[index+1]||'').replace(/^[-+\d.)\s]+/,'').trim();
  return detail.slice(0,280)||'The agent outlined a next step in its final response.';
 }
 const text=lines.join('\n');
 const direct=[...text.matchAll(/(?:^|[.!]\s+|\n)\s*((?:please\s+(?!note\b|see\b)|(?:you|this)\s+(?:still\s+)?need(?:s)?\s+(?:you\s+)?to\b|(?:open|refresh|upload|sign in|choose|select|reply|send|run|add|confirm|unlock|review|download)\b)[^.!?\n]{3,260}[.!]?)/gim)];
 return direct.at(-1)?.[1]?.replace(/\s+/g,' ').trim().slice(0,280)||null;
}

/** Translate runtime state into one unambiguous, user-facing outcome. */
export function conversationSignal(task,actions=[]){
 const related=actions.filter(action=>action.task_key===task.key&&(action.status==='open'||action.status==='responding'));
 const openApproval=related.find(action=>action.kind==='approval'&&action.status==='open');
 if(openApproval){
  const question=openApproval.payload?.method==='item/tool/requestUserInput';
  return {kind:question?'question':'action',icon:question?'?':'!',label:question?'Answer needed':'Decision needed',title:question?'The agent is waiting for your answer':'Your approval is required',body:openApproval.body,actionId:openApproval.id,actionLabel:question?'Answer question':'Review request'};
 }
 const responding=related.find(action=>action.kind==='approval'&&action.status==='responding');
 if(responding)return {kind:'working',icon:'↗',label:'Answer sent',title:'Waiting for the agent to continue',body:'Your response was submitted. No further action is needed unless the agent asks again.'};
 const blocked=related.find(action=>action.kind==='blocked');
 if(blocked)return {kind:'action',icon:'!',label:'Your choice',title:blocked.title||'This task was interrupted',body:task.owned?'This task stopped before it could continue. Open it in Codex to review the latest report, then resume, redirect, or leave it stopped.':'This task stopped before it could continue. Review the latest report, then give the agent a clear next instruction or leave it stopped.',focusComposer:true,actionLabel:task.owned?'Open in Codex':'Choose what to do'};
 const problem=related.find(action=>['failure','delivery'].includes(action.kind));
 if(problem)return {kind:'action',icon:'!',label:'Next action',title:problem.title,body:problem.body,actionId:problem.id,actionLabel:'Review issue'};
 const latest=task.latest?.text||'';
 if(task.status==='failed')return {kind:'action',icon:'!',label:'Next action',title:'This turn failed',body:'Review the latest response and error details before continuing.'};
 if(task.status==='paused')return {kind:'action',icon:'!',label:'Next action',title:'This turn is paused',body:'Send a new instruction when you are ready to continue.'};
 if(task.status==='offline')return {kind:'action',icon:'!',label:'Connection issue',title:'This task may be out of date',body:'Reconnect its machine before relying on the status shown here.'};
 if(task.status==='running'||task.status==='active'||task.status==='recent')return {kind:'working',icon:'↗',label:task.status==='recent'?'Recently active':'In progress',title:task.status==='recent'?'The source reported recent activity':'The agent is working',body:'Nothing is needed from you right now. This panel will update if the agent asks a question.'};
 const question=directQuestion(latest);
 if(question)return {kind:'question',icon:'?',label:'Question to answer',title:'The agent needs your reply',body:question,focusComposer:true,actionLabel:'Write an answer'};
 const next=nextAction(latest);
 if(next)return {kind:'next',icon:'→',label:'Next action',title:'There is a clear next step',body:next,focusComposer:true,actionLabel:'Continue this task'};
 if((task.status==='idle'||task.status==='completed')&&task.latest?.phase==='final_answer')return {kind:'complete',icon:'✓',label:'Complete',title:'Turn complete — no reply needed',body:'The agent finished its response and is not waiting for anything from you.'};
 if(task.status==='idle'||task.status==='completed')return {kind:'ready',icon:'✓',label:task.status==='completed'?'Complete':'Ready',title:task.status==='completed'?'The turn is complete':'Ready for your next instruction',body:'No turn is running and there is no unanswered request.'};
 return {kind:'ready',icon:'•',label:'Status',title:'No action is currently identified',body:'Review the latest response before deciding what to do next.'};
}
