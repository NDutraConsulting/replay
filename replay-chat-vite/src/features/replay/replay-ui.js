// View-model keys used by the templates below (all provided by replay-controller.js):
// replay, replayTab, replayBusy, playing, activeResult, promptsHidden, savedReplays,
// chat (the replay's source chat, with all its messages), diffA, diffB, models, connected, prompts (that chat's user prompts), agents ([{id, name}]),
// savedDetails ({id: full saved replay}, loaded on demand for the Diff tab).
// savedReplays are summaries: {id, runId, slot, model, agentId, completed, sourceConversationId, promptCount, responseCount, createdAt}.
import { STEP_HEADING, decisionTreeHTML, decisionTreeIfAny, kbNotesHTML, traceLines } from '../../shared/decision-tree-ui.js';
import { CALL_HEADING, callDiffText, purposeLabel } from '../../shared/api-log-ui.js';
import { CLIFF_THRESHOLD, cliffTip, divergenceSummary, divergenceTip, findCliffs, findDivergence } from '../../shared/logprob-cliffs.js';
import { configChipsHTML, configListHTML } from '../../shared/config-chips-ui.js';
import { reasoningLabel, reasoningOptionsHTML } from '../../shared/reasoning.js';
import { TEMPERATURE_HINT, temperatureLabel } from '../../shared/temperature.js';

export { decisionTreeHTML }; // (the collapsible lives in shared/ now; the Diff tab and its tests still use it from here)
import { esc } from '../../shared/html.js';
import { modelLabel } from '../../shared/model-label.js';
import { showModal } from '../../shared/modal-ui.js';
import { icon } from '../../shared/icons.js';
import { footerHTML, modeBadgeHTML } from '../../shared/shell-ui.js';

export function dateLabel(date){return new Date(date).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}
/** The current chat's settings, read-only: a replay starts from them but may change them before it starts. */
export function sourceChatHTML(v){const c=v.conversation;if(!c)return '';
  return `<div class="source-chat"><div class="field-label">Current chat · ${esc(c.name)}</div>${configListHTML({agentName:v.agents.find(a=>a.id===c.agentId)?.name||c.agentId,model:c.model,reasoningLevel:c.reasoningLevel,temperature:c.temperature,kbSummaryTool:c.kbSummaryTool,briefReplies:c.briefReplies})}<p class="small source-chat-note">A replay starts from these settings. The chat's own settings never change; change the replay's below before you start it.</p></div>`}
/** unsent | pending | complete | failed for prompt i. */
export function promptStatus(v,i){const {replay,replayBusy,failedPrompt}=v;if(i<replay.cursor)return 'complete';if(i===replay.cursor){if(replayBusy)return 'pending';if(failedPrompt===i)return 'failed'}return 'unsent'}

/** "{seconds.ms} seconds elapsed" since a step started. */
export function elapsedText(startedAt){const ms=startedAt?Math.max(0,Date.now()-startedAt):0;return `${(Math.floor(ms/100)/10).toFixed(1)} seconds elapsed`}

export function replayTabsHTML(v){const {replay,replayTab,replayBusy,playing,activeResult,promptsHidden,chat,savedReplays,diffA,diffB,models,connected,prompts,agents,savedDetails}=v;
  return `<div class="workspace-tabs" role="tablist" aria-label="Replay workspace">${[['history','chat','History'],['replay','replay','Replay'],['diff','diff','Diff']].map(([id,ic,label])=>`<button role="tab" id="tab-${id}" aria-selected="${replayTab===id}" aria-controls="workspace-content" tabindex="${replayTab===id?'0':'-1'}" data-workspace-tab="${id}" class="workspace-tab ${replayTab===id?'active':''}">${icon(ic)}${label}</button>`).join('')}</div>`}
/**
 * What the Replay page is for, in a popup that opens when the page does (it used to be the page's heading).
 * One button closes it; Escape and a click outside do too.
 */
export const openReplayIntro = (onLesson = null) =>
  showModal({
    title: 'Model & hardware comparison',
    bodyHTML: '<p class="modal-lead">Same conversation. Different results.</p><p class="modal-text">Replay your prompts on other models, then compare how the output differs.</p>',
    submitLabel: 'Got it',
    cancelLabel: null,
    className: 'replay-intro-modal',
    // With a lesson to offer, a "Take lesson" button sits beside "Got it" (it closes the popup and starts the lesson).
    onMount(form, handle) {
      if (!onLesson) return;
      const take = document.createElement('button');
      take.type = 'button';
      take.className = 'btn';
      take.id = 'take-lesson';
      take.textContent = 'Take lesson';
      take.onclick = () => {
        handle.close();
        onLesson();
      };
      form.querySelector('button[type="submit"]').before(take);
    },
  });

export function replayPageHTML(v){
  const {replay,replayTab,replayBusy,playing,activeResult,promptsHidden,chat,savedReplays,diffA,diffB,models,connected,prompts,agents,savedDetails}=v;
  return `<div class="page-heading replay-status-row">${replayBusy?'<span class="badge"><span class="dot"></span>Replay in progress</span>':modeBadgeHTML(connected)}</div>${replayTabsHTML(v)}<section id="workspace-content" role="tabpanel" aria-labelledby="tab-${replayTab}">${replayTab==='replay'?replayBodyHTML(v):replayTab==='history'?historyHTML(v):diffHTML(v)}</section>${footerHTML()}`;
}
/** The replay's settings (the chat's, read-only, and the replay's own), shown in the File > Config popup. */
export function replayConfigHTML(v){
  const {replay,replayBusy,models,agents}=v;
  return `<div id="replay-config">${replay.cursor?'<p class="small config-reset-note" role="note">This replay has started. Changing any setting resets it: the results so far are kept as a saved replay, and you start a new run with the new setting.</p>':''}${sourceChatHTML(v)}<label class="field-label" for="replay-agent">AI agent</label><select id="replay-agent" class="model-select replay-agent-select" ${replayBusy?'disabled':''}>${agents.map(a=>`<option value="${a.id}" ${replay.agentId===a.id?'selected':''}>${a.name}</option>`).join('')}</select><div class="replay-options"><div><label class="field-label" for="replay-reasoning">Reasoning level</label><select id="replay-reasoning" class="model-select" ${replayBusy?'disabled':''}>${reasoningOptionsHTML(replay.reasoningLevel)}</select></div><div><label class="field-label" for="replay-temperature">Temperature <span class="info-dot tooltip" tabindex="0" data-tip="${esc(TEMPERATURE_HINT)} One setting for the whole replay. Changing it after the replay has started resets the replay.">i</span></label><input type="number" id="replay-temperature" class="model-select replay-temperature" min="0" max="2" step="0.1" inputmode="decimal" value="${replay.temperature}" ${replayBusy?'disabled':''}></div><div class="kb-switch"><input type="checkbox" class="switch" role="switch" id="replay-kb-summary" ${replay.kbSummaryTool?'checked':''} ${replayBusy?'disabled':''}><label for="replay-kb-summary">KB summary tool <span class="info-dot tooltip" tabindex="0" data-tip="One switch for the whole replay, so Model A and Model B are compared under the same setting. Off: each model is sent the whole knowledge base file. On: each model first writes a summary of the file (under 1000 words) and that is sent instead. Changing it after the replay has started resets the replay.">i</span></label></div><div class="kb-switch"><input type="checkbox" class="switch" role="switch" id="replay-brief" ${replay.briefReplies?'checked':''} ${replayBusy?'disabled':''}><label for="replay-brief">Brief replies <span class="info-dot tooltip" tabindex="0" data-tip="Add &quot;Respond in 100 words or less.&quot; to the end of each request, for both models. One switch for the whole replay. Changing it after the replay has started resets the replay.">i</span></label></div><div class="kb-switch"><input type="checkbox" class="switch" role="switch" id="replay-logprobs" ${replay.logprobs?'checked':''} ${replayBusy?'disabled':''}><label for="replay-logprobs">Log probabilities <span class="info-dot tooltip" tabindex="0" data-tip="Ask the model to return the log probability of every token it writes. They come back in the raw response, which the API log shows. One switch for the whole replay. A reasoning model returns them only when the reasoning level is None; otherwise they are not requested and the API log says so. Changing it after the replay has started resets the replay.">i</span></label></div></div><div class="field-label">Compare models <span class="info-dot tooltip" tabindex="0" data-tip="Model A and Model B each get your prompts and their own previous responses. Results never cross between them. You can pick the same model for both.">i</span></div><div class="model-compare">${['a','b'].map((slot,i)=>`<div><label class="field-label" for="model-${slot}">Model ${slot.toUpperCase()}</label><select id="model-${slot}" class="model-select" ${replayBusy?'disabled':''}>${models.map(m=>`<option value="${esc(m)}" ${replay.selected[i]===m?'selected':''}>${esc(modelLabel(m))}</option>`).join('')}</select></div>`).join('')}</div></div>`}
export function replayBodyHTML(v){
  const {stepped,replay,replayTab,replayBusy,playing,activeResult,promptsHidden,chat,savedReplays,diffA,diffB,models,connected,prompts,agents,savedDetails}=v;
return `<div class="replay-layout ${promptsHidden?'prompts-hidden':''}" id="replay-layout"><div class="prompts-slot" id="prompts-slot" ${promptsHidden?'inert':''}><section class="panel prompts-panel" id="prompts-panel"><div class="panel-head prompt-toolbar"><div><h2>Your prompts</h2><p>Just your side of the conversation.</p></div><div class="prompt-head-actions"><span class="badge">${replay.prompts.length} turns</span><button class="collapse-prompts tooltip" id="hide-prompts" aria-label="Hide your prompts" aria-controls="prompts-panel" aria-expanded="${!promptsHidden}" data-tip="Slide your prompts into the left edge.">−</button></div></div><div>${replay.prompts.length?replay.prompts.map((p,i)=>`<article class="prompt-row ${i<replay.cursor?'done':''} ${i===replay.cursor?'active':''}"><span class="turn-number">${i<replay.cursor?icon('check'):String(i+1).padStart(2,'0')}</span><div><div class="row-label">Prompt ${String(i+1).padStart(2,'0')} ${i===replay.cursor&&!replayBusy?'· Up next':''}<span class="prompt-status ${promptStatus(v,i)}">${promptStatus(v,i)}</span></div><p>${esc(p)}</p></div></article>`).join(''):'<div class="empty"><p>Send a message in Chat, then load it here.</p><a class="btn" href="/">Open Chat</a></div>'}</div></section></div><div class="replay-main"><section class="panel"><div class="panel-head"><h2>Replay controls</h2><p>One prompt at a time, or the whole conversation.</p></div><div class="control-panel"><div class="replay-controls">${replay.prompts.length&&replay.cursor>=replay.prompts.length?`<button class="btn blue tooltip" id="reset-replay" data-tip="Start a new replay. Saved results remain available in Diff." >${icon('rewind')}Reset</button><button class="btn yellow" id="diff-api-btn">${icon('diff')}Diff API</button><button class="btn yellow" id="diff-chat-btn">${icon('diff')}Diff Chat</button>`:`<button class="btn" id="step-replay" ${replayBusy||!replay.prompts.length||replay.cursor>=replay.prompts.length?'disabled':''}>${icon('step')}Step through</button><button class="btn yellow" id="play-replay" ${!replay.prompts.length||(!playing&&replayBusy)||replay.cursor>=replay.prompts.length?'disabled':''}>${icon(playing?'pause':'play')}${playing?'Stop playback':'Play all'}</button><button class="btn" id="open-config">${icon('config')}Config</button>`}</div><div class="progress-row"><span id="run-status" role="status">${replayBusy?'Running prompt '+(replay.cursor+1)+'…':replay.cursor===replay.prompts.length&&replay.cursor?'Replay complete':replay.cursor?'Ready for the next prompt':'Ready when you are'}</span><span>${replay.cursor} / ${replay.prompts.length} prompts</span></div><div class="progress-track" role="progressbar" aria-label="Replay progress" aria-valuemin="0" aria-valuemax="${replay.prompts.length||1}" aria-valuenow="${replay.cursor}"><div style="width:${replay.prompts.length?100*replay.cursor/replay.prompts.length:0}%"></div></div><div class="notice-bar ${replayBusy?'running':''}" ${replayBusy?'role="timer"':''}>${replayBusy?`<span class="spinner" aria-hidden="true"></span><span id="step-elapsed">${elapsedText(v.stepStartedAt)}</span>`:connected?'Uses your configured API. Each selected model receives a separate request per prompt.':'Demo mode · Try the controls, then connect your API in Account.'}</div></div></section>${stepped?`<section class="panel results"><div class="results-head"><div class="results-title"><h2>Model responses</h2><span class="badge replay-number" id="replay-number" title="This chat's replays are numbered from 1">Replay v${currentReplayNumber(v)}</span></div></div><div class="result-tabs">${['a','b'].map((slot,i)=>`<button data-result="${slot}" class="${slot===activeResult?'active':''}">${slot.toUpperCase()} · ${esc(modelLabel(replay.selected[i]))}</button>`).join('')}</div><div id="result-content">${resultHTML(v)}</div></section>`:''}</div>${playOverlayHTML(v)}<button class="prompts-restore ${promptsHidden?'visible':''}" id="show-prompts" aria-label="Show your prompts" aria-controls="prompts-panel" aria-expanded="${!promptsHidden}" ${promptsHidden?'':'inert'}><span class="restore-plus" aria-hidden="true">+</span><span>Your prompts</span></button></div>`}
/** The popup shown over the Replay tab while Play all runs, and when it has finished. */
export function playOverlayHTML(v){
  const {playOverlay,playVersion}=v;
  if(!playOverlay)return '';
  const done=playOverlay==='done';
  const {replay,agents=[]}=v;
  const slots=['a','b'].map((slot,i)=>`<li><b>${slot.toUpperCase()}</b>${esc(modelLabel(replay.selected[i]))}</li>`).join('');
  const settings=`<ul class="play-models" aria-label="Models in use">${slots}</ul><div class="play-settings">${configChipsHTML({agentName:agents.find(a=>a.id===replay.agentId)?.name||'AI agent',reasoningLevel:replay.reasoningLevel,temperature:replay.temperature,kbSummaryTool:replay.kbSummaryTool,briefReplies:replay.briefReplies}).replace('</div>',`<span class="chip"><b>Log probs</b>${replay.logprobs?'On':'Off'}</span></div>`)}</div>`;
  return `<div class="modal-overlay play-overlay" id="play-all-popup"><div class="modal play-modal" role="dialog" aria-modal="true" aria-labelledby="play-all-popup-title"><div class="play-body">${done?`<div class="play-check" aria-hidden="true">${icon('check')}</div>`:'<div class="play-spinner" id="play-spinner" role="presentation"></div>'}<h2 id="play-all-popup-title">${done?`Replay v${playVersion} complete`:`Replay v${playVersion} is running`}</h2><p class="small" role="status">${done?'Both models answered every prompt.':`Prompt ${Math.min(v.replay.cursor+1,v.replay.prompts.length)} of ${v.replay.prompts.length}…`}</p>${settings}${done?`<div class="play-actions"><button class="btn yellow" id="view-diff-api">${icon('diff')}Diff API</button><button class="btn yellow" id="view-diff-chat">${icon('diff')}Diff Chat</button></div>`:'<button class="btn" id="stop-play">Stop playback</button>'}</div></div></div>`}
export function applyPromptsHidden(hidden) {
  document.getElementById('replay-layout').classList.toggle('prompts-hidden', hidden);
  document.getElementById('prompts-slot').inert = hidden;
  const show = document.getElementById('show-prompts');
  show.classList.toggle('visible', hidden);
  show.inert = !hidden;
  show.setAttribute('aria-expanded', !hidden);
  document.getElementById('hide-prompts').setAttribute('aria-expanded', !hidden);
  (hidden ? show : document.getElementById('hide-prompts')).focus();
}
export function resultHTML(v){
  const {replay,replayTab,replayBusy,playing,activeResult,promptsHidden,chat,savedReplays,diffA,diffB,models,connected,prompts,agents,savedDetails}=v;
const r=replay.results[activeResult]||[];return r.length?r.map((x,i)=>`<article class="result-entry"><div class="result-label"><span>PROMPT ${String(i+1).padStart(2,'0')}</span><span>${esc(modelLabel(x.model||activeResult))} · ${x.demo?'Demo':x.error?'Error':'API response'}</span></div>${decisionTreeIfAny(x.decision_trace)}${kbNotesHTML(x)}<div class="${x.error?'error':'message-copy'}">${esc(x.content)}</div></article>`).join(''):`<div class="empty"><div class="circle-icon">${icon('replay')}</div><h2>Let’s compare the output.</h2><p>Select your models, then step through a prompt or play the full conversation.</p></div>`}
/** A chat's saved replays as numbered versions (v1 is the oldest). Each version is one run: slot A and slot B. */
export function replayVersions(savedReplays,chatId){
  const runs=[];
  for(const r of savedReplays){
    if(r.sourceConversationId!==chatId)continue;
    let run=runs.find(x=>x.runId===r.runId);
    if(!run){run={runId:r.runId,version:runs.length+1,slots:[]};runs.push(run)}
    run.slots.push(r);
  }
  return runs;
}
const versionRowHTML=(r,v,comparable=true)=>{const {savedReplays,agents,chat}=v;const comparableCount=chatReplays(savedReplays,chat?.conversation_id).length;return `<div class="record-row"><div class="record-symbol replay-record-symbol">${icon('replay')}</div><div class="record-detail"><h3>${r.slot.toUpperCase()} · ${esc(modelWithSettings(r))}</h3><p>${esc(agents.find(a=>a.id===r.agentId)?.name||'AI agent')} · ${r.completed?'Complete':'Partial replay'} · KB summary tool ${r.kbSummaryTool?'on':'off'}</p><span class="small">${r.responseCount} / ${r.promptCount} prompts · ${esc(dateLabel(r.createdAt))}</span></div><div class="record-actions"><button class="btn" data-api-log="${esc(r.id)}">API log</button><button class="btn" data-compare-record="${esc(r.id)}" ${!comparable||comparableCount<2?'disabled':''} ${comparable?'':'title="This replay is not tied to a chat, so it cannot be compared here."'}>Diff ${icon('diff')}</button></div></div>`};
const versionBlockHTML=(title,slots,v,comparable=true)=>`<div class="version-block"><div class="version-head"><h3>${title}</h3><span class="small">${esc(dateLabel(slots[0].createdAt))}</span></div>${slots.map(r=>versionRowHTML(r,v,comparable)).join('')}</div>`;
/** The History tab: that chat's saved replays as versions. */
export function historyHTML(v){
  const {savedReplays,chat}=v;
  const messages=chat?.messages??[];
  const versions=chat?replayVersions(savedReplays,chat.conversation_id):[];
  const earlier=savedReplays.filter(r=>!r.sourceConversationId);
  const earlierRuns=[...new Set(earlier.map(r=>r.runId))];
  return `${messages.length?'':'<div class="empty"><p>Nothing here yet. Send a message in Chat, or use File &gt; Open to load another chat.</p><a class="btn" href="/">Open Chat</a></div>'}<div class="replay-section-heading saved-records-heading"><div><h2>Saved replays</h2><p class="small">Each time this chat is replayed and saved, it becomes the next version. A finished run saves automatically, and so does a partial one when you reset the replay or change its config.</p></div><span class="badge">${versions.length} ${versions.length===1?'version':'versions'}</span></div><section class="panel">${versions.length?[...versions].reverse().map(x=>versionBlockHTML(`Replay v${x.version}`,x.slots,v)).join(''):'<div class="empty"><div class="circle-icon">'+icon('replay')+'</div><h2>No replay versions yet</h2><p>Play a replay of this chat to the end, or reset it (or change its config) part way. Its results will be ready to compare.</p></div>'}</section>${earlierRuns.length?`<div class="replay-section-heading saved-records-heading"><div><h2>Earlier replays</h2><p class="small">Saved before replays were tied to a chat. They are kept for reference and cannot be compared.</p></div><span class="badge">${earlierRuns.length} saved</span></div><section class="panel">${[...earlierRuns].reverse().map(id=>versionBlockHTML('Earlier replay',earlier.filter(r=>r.runId===id),v,false)).join('')}</section>`:''}`}
/** The saved replays of one chat (all of them when no chat is on screen), in the order they were made. */
export function chatReplays(savedReplays,chatId){return chatId?savedReplays.filter(r=>r.sourceConversationId===chatId):savedReplays}
/** A saved replay's number within its chat: the first run of a chat is 1, whatever else was run before on other chats. */
export function versionNumber(list,r){return [...new Set(list.map(x=>x.runId))].indexOf(r.runId)+1}
/** The number of the run on screen within its chat: the next version after the chat's saved ones, or its own when it is saved. */
export function currentReplayNumber(v){
  const order=[...new Set(chatReplays(v.savedReplays??[],v.chat?.conversation_id).map(x=>x.runId))];
  const at=order.indexOf(v.replay?.runId);
  return at>=0?at+1:order.length+1;
}
export function runLabel(r,savedReplays){return `Replay v${versionNumber(savedReplays,r)} · ${r.slot.toUpperCase()} · ${modelLabel(r.model)} · temp ${temperatureLabel(r.temperature)} · reasoning ${r.reasoningLevel} · ${dateLabel(r.createdAt)} · ${r.responseCount} turns`}
/** A replay's model with its temperature and reasoning level, the way every comparison names a side. */
const shortReasoning=(id)=>id==='default'?'Default':reasoningLabel(id);
const modelWithSettings=(x)=>`${modelLabel(x.model)} · Temperature ${temperatureLabel(x.temperature)} · Reasoning ${shortReasoning(x.reasoningLevel)}`;
/** The Diff's two views: the answers compared as chat, or the raw API calls behind them. */
const DIFF_VIEWS=[['chat','Chat'],['api','API logs']];
export function diffViewTabsHTML(v){
  const view=v.diffView==='api'?'api':'chat';
  return `<div class="workspace-tabs diff-views" role="tablist" aria-label="Diff view">${DIFF_VIEWS.map(([id,label])=>`<button type="button" role="tab" id="diff-view-${id}" aria-selected="${view===id}" tabindex="${view===id?'0':'-1'}" data-diff-view="${id}" class="workspace-tab ${view===id?'active':''}">${label}</button>`).join('')}<button type="button" class="icon-btn diff-settings-btn tooltip" id="diff-settings" aria-label="Diff settings" aria-haspopup="dialog" data-tip="Diff settings">${icon('gear')}</button></div>`;
}
/** The Diff settings popup: the log prob cliff threshold. */
export function diffSettingsHTML(v){
  return `<div class="modal-field"><label class="cliff-control" for="cliff-threshold">Cliff threshold <input type="number" id="cliff-threshold" class="model-select" min="0.1" max="20" step="0.1" inputmode="decimal" value="${v.cliffThreshold??CLIFF_THRESHOLD}"></label><p class="modal-hint">A log prob cliff is a drop in log probability from the token before it (2 is about 7 times less likely). Lower it to flag more, raise it to flag fewer. It applies to replays that asked for log probabilities.</p></div>`;
}
/**
 * The API logs view: the REST calls behind Replay A and Replay B, prompt by prompt, call by call, side by side. The first
 * call of A sits beside the first call of B and so on, each as its own collapsible; a call only one side made leaves a gap.
 */
export function apiDiffHTML(v,a,b){
  const {diffA,diffB,apiLogs={}}=v;
  const la=apiLogs[diffA],lb=apiLogs[diffB];
  if(!la||!lb)return '<section class="panel"><div class="empty" role="status"><p>Loading the API logs…</p></div></section>';
  const head=`<div class="api-diff-row api-diff-head"><div>Replay A · ${esc(modelWithSettings(a))}</div><div>Replay B · ${esc(modelWithSettings(b))}</div></div>`;
  const note=(log,name)=>log.failed?`${name}: the API log could not be loaded.`:!log.recorded?`${name}: no API log was kept (it was saved before API logs existed).`:'';
  const notes=[note(la,'Replay A'),note(lb,'Replay B')].filter(Boolean).map(t=>`<p class="small api-diff-note">${esc(t)}</p>`).join('');
  const turns=Math.max(la.turns?.length??0,lb.turns?.length??0);
  const calls=(log,i)=>log.turns?.find(t=>t.turn_index===i)?.calls??[];
  const brief=(c)=>c?`${c.response?c.response.status:'no response'} · ${c.duration_ms} ms`:'no call';
  const labels={a:`Replay A · ${modelWithSettings(a)}`,b:`Replay B · ${modelWithSettings(b)}`};
  const sections=Array.from({length:turns},(_,i)=>{
    const ca=calls(la,i),cb=calls(lb,i);
    if(!ca.length&&!cb.length)return '';
    // every call is open and compared line by line: A's first call with B's first call, and so on
    const pairs=Array.from({length:Math.max(ca.length,cb.length)},(_,k)=>{
      const x=ca[k],y=cb[k];
      const what=(c)=>c?purposeLabel(c.purpose):'no call';
      const title=x&&y&&x.purpose!==y.purpose?`${what(x)} / ${what(y)}`:what(x||y);
      return `<section class="api-pair" aria-label="Call ${k+1}"><div class="api-pair-head"><h4><span class="api-index">#${k+1}</span> ${esc(title)}</h4><div class="api-pair-brief"><span>A · ${esc(brief(x))}</span><span>B · ${esc(brief(y))}</span></div></div>${lineDiffHTML(callDiffText(x),callDiffText(y),null,(t)=>CALL_HEADING.test(t))}</section>`;
    }).join('');
    return `<article class="panel diff-turn api-diff-turn"><div class="diff-prompt"><div class="eyebrow">Prompt ${String(i+1).padStart(2,'0')}</div><p>${esc(a.prompts[i]??b.prompts[i]??'No prompt')}</p><span class="small">A made ${ca.length} ${ca.length===1?'call':'calls'}, B made ${cb.length}</span></div><div class="api-diff-calls">${pairs}</div></article>`;
  }).join('');
  const any=sections!=='';
  return `<div class="api-diff">${notes}${any?`<div class="panel api-diff-headbar">${head}</div>${sections}`:`<section class="panel"><div class="empty"><p>${la.recorded||lb.recorded?'No API calls were made. These replays ran in demo mode, so nothing was sent to the provider.':'No API calls to show.'}</p></div></section>`}</div>`;
}
/** The Model Diff collapsible: only what differs between the two replays (the models, then the config), as a small table. */
function modelDiffHTML(v,a,b){
  const agent=(d)=>v.agents?.find(x=>x.id===d.agentId)?.name||d.agentId||'AI agent';
  const rows=[['Model',d=>modelLabel(d.model)],['AI agent',agent],['KB summary tool',d=>d.kbSummaryTool?'On':'Off'],['Brief replies',d=>d.briefReplies?'On':'Off'],['Reasoning',d=>reasoningLabel(d.reasoningLevel)],['Temperature',d=>temperatureLabel(d.temperature)],['Log probabilities',d=>d.logprobs?'On':'Off']];
  const differing=rows.map(([name,get])=>[name,String(get(a)),String(get(b))]).filter(([,x,y])=>x!==y);
  const body=differing.length
    ?`<table class="model-diff-table"><thead><tr><th scope="col">Setting</th><th scope="col">Replay A</th><th scope="col">Replay B</th></tr></thead><tbody>${differing.map(([name,x,y])=>`<tr><th scope="row">${esc(name)}</th><td class="diff-changed">${esc(x)}</td><td class="diff-changed">${esc(y)}</td></tr>`).join('')}</tbody></table>`
    :'<p class="small model-diff-none">No differences: both replays used the same model and the same settings.</p>';
  return `<details class="model-diff" id="model-diff" ${v.modelDiffOpen?'open':''}><summary>Model Diff <span class="badge">${differing.length} ${differing.length===1?'difference':'differences'}</span></summary>${body}</details>`;
}
/** One replay's settings as badges, model first. A badge that differs from the other replay's is highlighted. */
function settingsHTML(side,x,other){
  const rows=[['Model',d=>modelLabel(d.model)],['KB summary tool',d=>d.kbSummaryTool?'on':'off'],['Brief replies',d=>d.briefReplies?'on':'off'],['Reasoning',d=>reasoningLabel(d.reasoningLevel)],['Temperature',d=>temperatureLabel(d.temperature)],['Log probabilities',d=>d.logprobs?'on':'off']];
  return `<div class="diff-settings" data-side="${side}" aria-label="Settings Replay ${side.toUpperCase()} used">${rows.map(([name,get])=>{const value=String(get(x));const differs=value!==String(get(other));return `<span class="badge${differs?' diff-changed':''}" ${differs?'data-differs="true" title="Differs from the other replay"':''}>${side.toUpperCase()} · ${name} ${esc(value)}</span>`}).join('')}</div>`;
}
/** The Diff page frame: the replay selectors in a left panel that slides away (like Your prompts), the comparison beside it. */
function diffLayoutHTML(v,selectors,main){
  const hidden=!!v.selectorsHidden;
  return `<div class="replay-layout diff-layout ${hidden?'prompts-hidden':''}" id="diff-layout"><div class="prompts-slot" id="selectors-slot" ${hidden?'inert':''}><section class="panel prompts-panel diff-selectors" id="selectors-panel"><div class="panel-head prompt-toolbar"><div><h2>Select Replays</h2><p>Choose the two replays to compare.</p></div><div class="prompt-head-actions"><button class="collapse-prompts tooltip" id="hide-selectors" aria-label="Hide the replay selection" aria-controls="selectors-panel" aria-expanded="${!hidden}" data-tip="Slide the selection into the left edge.">−</button></div></div><div class="diff-selector-list">${selectors}</div></section></div><div class="replay-main">${main}</div><button class="prompts-restore ${hidden?'visible':''}" id="show-selectors" aria-label="Show the replay selection" aria-controls="selectors-panel" aria-expanded="${!hidden}" ${hidden?'':'inert'}><span class="restore-plus" aria-hidden="true">+</span><span>Select Replays</span></button></div>`;
}
export function applySelectorsHidden(hidden) {
  document.getElementById('diff-layout').classList.toggle('prompts-hidden', hidden);
  document.getElementById('selectors-slot').inert = hidden;
  const show = document.getElementById('show-selectors');
  show.classList.toggle('visible', hidden);
  show.inert = !hidden;
  show.setAttribute('aria-expanded', !hidden);
  document.getElementById('hide-selectors').setAttribute('aria-expanded', !hidden);
  (hidden ? show : document.getElementById('hide-selectors')).focus();
}
export function diffHTML(v){
  const {replay,replayTab,replayBusy,playing,activeResult,promptsHidden,chat,savedReplays,diffA,diffB,models,connected,prompts,agents,savedDetails}=v;
  const list=chatReplays(savedReplays,chat?.conversation_id); // the Diff compares this chat's replays only
  if(list.length<2)return `<div class="replay-section-heading"><div><h2>Compare two replays</h2><p class="small">See what changed, one response at a time.</p></div></div><section class="panel"><div class="empty"><div class="circle-icon">${icon('diff')}</div><h2>Two replays make a comparison.</h2><p>Two saved replay results of this chat are needed. Run two models together, or replay the same prompts twice.</p><button class="btn yellow" id="diff-start">${icon('replay')}Open Replay</button></div></section>`;
  const selectorsHTML=(under={})=>[['a','Replay A',diffA],['b','Replay B',diffB]].map(([id,label,value])=>`<div class="diff-selector"><label class="field-label" for="diff-${id}">${label}</label><select id="diff-${id}" class="diff-select">${[...list].reverse().map(r=>`<option value="${esc(r.id)}" ${r.id===value?'selected':''}>${esc(runLabel(r,list))}</option>`).join('')}</select>${under[id]||''}</div>`).join('');
  const a=savedDetails?.[diffA],b=savedDetails?.[diffB];
  if(!a||!b)return diffLayoutHTML(v,selectorsHTML(),`<div class="replay-section-heading"><div><h2>Compare two replays</h2><p class="small">See what changed, one response at a time.</p></div></div><section class="panel"><div class="empty" role="status"><p>Loading the comparison…</p></div></section>`);
  const count=Math.max(a.prompts.length,b.prompts.length),samePrompts=JSON.stringify(a.prompts)===JSON.stringify(b.prompts);
  const changed=Array.from({length:count},(_,i)=>i).filter(i=>a.prompts[i]!==b.prompts[i]||a.responses[i]?.content!==b.responses[i]?.content).length;
  const summaryHTML=(selectorsInner,mainInner)=>diffLayoutHTML(v,selectorsInner,mainInner);
  return summaryHTML(selectorsHTML({a:settingsHTML('a',a,b),b:settingsHTML('b',b,a)}),`<div class="replay-section-heading"><div><h2>Compare two replays</h2><p class="small">See what changed, one response at a time.</p></div><div class="diff-legend"><span><i class="diff-removed"></i>Removed from A</span><span><i class="diff-added"></i>Added in B</span>${a.logprobs||b.logprobs?'<span><i class="logprob-diverge-swatch"></i>Where A and B diverge</span><span><i class="logprob-cliff-swatch"></i>Log prob cliff</span>':''}</div></div><section class="panel diff-summary-panel"><div class="diff-summary"><span class="badge">${changed} changed ${changed===1?'turn':'turns'}</span><span class="small">${samePrompts?'Same source prompts':'Different source prompts · aligned by turn number'} · ${count} total</span></div>${modelDiffHTML(v,a,b)}</section>${diffViewTabsHTML(v)}${v.diffView==='api'?apiDiffHTML(v,a,b):`<div class="diff-table">${Array.from({length:count},(_,i)=>{
    const aa=a.responses[i]?.content,bb=b.responses[i]?.content;
    const tokens=(id)=>v.savedLogprobs?.[id]?.turns?.find(t=>t.turn_index===i)?.tokens;
    const threshold=v.cliffThreshold??CLIFF_THRESHOLD;
    const ta=tokens(diffA),tb=tokens(diffB);
    const cliffs={a:findCliffs(ta,aa||'',threshold),b:findCliffs(tb,bb||'',threshold)};
    const diverge=ta?.length&&tb?.length?findDivergence(ta,tb,aa||'',bb||''):null;
    // what is drawn: each cliff in red, and the word where the answers diverge (it wins where the two overlap)
    const marks={};
    for(const [side,name,other] of [['a','A','B'],['b','B','A']]){
      const own=diverge?.[side];
      marks[side]=[
        ...cliffs[side].filter(c=>!(own&&c.start<own.end&&c.end>own.start)).map(c=>({start:c.start,end:c.end,kind:'cliff',tip:cliffTip(c)})),
        ...(own?[{start:own.start,end:own.end,kind:'diverge',tip:divergenceTip(diverge,name,other)}]:[]),
      ].sort((x,y)=>x.start-y.start);
    }
    // a replay that asked for log probabilities says how many it found (0 included), or that none came back
    const cliffNote=(asked,list,toks)=>!asked?'':toks?.length?` · ${list.length} log prob ${list.length===1?'cliff':'cliffs'}`:' · no log probabilities returned';
    return `<article class="panel diff-turn"><div class="diff-prompt"><div class="eyebrow">Prompt ${String(i+1).padStart(2,'0')}</div>${a.prompts[i]===b.prompts[i]?`<p>${esc(a.prompts[i]||'No prompt')}</p>`:`<div class="different-prompts"><p><b>A</b> ${esc(a.prompts[i]??'No prompt')}</p><p><b>B</b> ${esc(b.prompts[i]??'No prompt')}</p></div>`}${diverge?`<p class="small diverge-note">${esc(divergenceSummary(diverge))}</p>`:''}</div><div class="diff-columns"><div class="diff-response"><div class="result-label"><span>REPLAY A · ${esc(modelWithSettings(a))}</span><span>${aa===bb?'Unchanged':'Changed'}${cliffNote(a.logprobs,cliffs.a,ta)}</span></div>${aa===undefined?'':kbNotesHTML(a.responses[i])}${aa===undefined?'<div class="small">This turn has not been replayed.</div>':''}</div><div class="diff-response"><div class="result-label"><span>REPLAY B · ${esc(modelWithSettings(b))}</span><span>${aa===bb?'Unchanged':'Changed'}${cliffNote(b.logprobs,cliffs.b,tb)}</span></div>${bb===undefined?'':kbNotesHTML(b.responses[i])}${bb===undefined?'<div class="small">This turn has not been replayed.</div>':''}</div></div>${aa===undefined&&bb===undefined?'':decisionTreeDiffHTML(a.responses[i]?.decision_trace,b.responses[i]?.decision_trace,{a:`Replay A · ${modelWithSettings(a)}`,b:`Replay B · ${modelWithSettings(b)}`})}${lineDiffHTML(aa||'',bb||'',{a:`Replay A · ${modelWithSettings(a)}`,b:`Replay B · ${modelWithSettings(b)}`},null,marks)}</article>`}).join('')}</div>`}`);
}
/** The words of two texts as [[text, type|null], ...] per side: type is 'removed' (left only) or 'added' (right only). */
export function wordDiffParts(left,right){
  if(left===right)return {a:[[left,null]],b:[[right,null]]};
  const a=left.match(/\s+|[^\s]+/g)||[],b=right.match(/\s+|[^\s]+/g)||[];
  if(a.length*b.length>1000000){
    let start=0;while(start<a.length&&start<b.length&&a[start]===b[start])start++;
    let end=0;while(end<a.length-start&&end<b.length-start&&a[a.length-end-1]===b[b.length-end-1])end++;
    const side=(t,from,to,type)=>[[t.slice(0,from).join(''),null],[t.slice(from,to).join(''),type],[t.slice(to).join(''),null]].filter(([x])=>x!=='');
    return {a:side(a,start,a.length-end,'removed'),b:side(b,start,b.length-end,'added')};
  }
  const dp=Array.from({length:a.length+1},()=>new Uint32Array(b.length+1));
  for(let i=a.length-1;i>=0;i--)for(let j=b.length-1;j>=0;j--)dp[i][j]=a[i]===b[j]?1+dp[i+1][j+1]:Math.max(dp[i+1][j],dp[i][j+1]);
  let i=0,j=0;const aa=[],bb=[];
  while(i<a.length||j<b.length){if(i<a.length&&j<b.length&&a[i]===b[j]){aa.push([a[i],null]);bb.push([b[j],null]);i++;j++}else if(i<a.length&&(j===b.length||dp[i+1][j]>=dp[i][j+1]))aa.push([a[i++],'removed']);else bb.push([b[j++],'added'])}
  return {a:aa,b:bb};
}
const partsHTML=(parts)=>parts.map(([t,type])=>type?`<mark class="diff-${type}">${esc(t)}</mark>`:esc(t)).join('');
export function wordDiff(left,right){
  const {a,b}=wordDiffParts(left,right);
  return {a:partsHTML(a),b:partsHTML(b)};
}
/** Parts of one line drawn with its marks: a cliff is a red span, the word where the answers diverge a purple one, each with its
 *  tooltip, inside any diff mark. `base` is where the line starts in the whole text; `ranges` are that text's marks
 *  ({start, end, kind: 'cliff'|'diverge', tip}, sorted, not overlapping). */
function partsWithCliffsHTML(parts,base,ranges){
  let position=base,out='';
  for(const [text,type] of parts){
    let i=0;
    while(i<text.length){
      const at=position+i;
      const inside=ranges.find(r=>at>=r.start&&at<r.end);
      const next=inside?null:ranges.find(r=>r.start>at);
      const stop=Math.min(text.length,(inside?inside.end:next?next.start:Infinity)-position);
      let html=esc(text.slice(i,stop));
      if(inside)html=`<span class="logprob-${inside.kind==='diverge'?'diverge':'cliff'}" tabindex="0" data-cliff-tip="${esc(inside.tip)}">${html}</span>`;
      out+=type?`<mark class="diff-${type}">${html}</mark>`:html;
      i=stop;
    }
    position+=text.length;
  }
  return out;
}

/**
 * A side-by-side line comparison of two texts. Rows stay aligned: an unchanged line sits on both sides, a changed line
 * pairs the old and new wording (with the changed words marked), and a line only one side has leaves a gap on the other.
 * Row: {type: 'equal'|'changed'|'removed'|'added', a: {n, html}|null, b: {n, html}|null}; n is the 1-based line number.
 */
export function lineDiff(left,right){
  const a=left===''?[]:left.split('\n'),b=right===''?[]:right.split('\n');
  let ops=[];
  if(a.length*b.length>250000){
    let start=0;while(start<a.length&&start<b.length&&a[start]===b[start])start++;
    let end=0;while(end<a.length-start&&end<b.length-start&&a[a.length-end-1]===b[b.length-end-1])end++;
    for(let i=0;i<start;i++)ops.push(['equal',i,i]);
    for(let i=start;i<a.length-end;i++)ops.push(['removed',i,-1]);
    for(let j=start;j<b.length-end;j++)ops.push(['added',-1,j]);
    for(let k=0;k<end;k++)ops.push(['equal',a.length-end+k,b.length-end+k]);
  }else{
    const dp=Array.from({length:a.length+1},()=>new Uint32Array(b.length+1));
    for(let i=a.length-1;i>=0;i--)for(let j=b.length-1;j>=0;j--)dp[i][j]=a[i]===b[j]?1+dp[i+1][j+1]:Math.max(dp[i+1][j],dp[i][j+1]);
    let i=0,j=0;
    while(i<a.length||j<b.length){
      if(i<a.length&&j<b.length&&a[i]===b[j]){ops.push(['equal',i,j]);i++;j++}
      else if(i<a.length&&(j===b.length||dp[i+1][j]>=dp[i][j+1]))ops.push(['removed',i++,-1]);
      else ops.push(['added',-1,j++]);
    }
  }
  const rows=[];
  for(let k=0;k<ops.length;){
    if(ops[k][0]==='equal'){const [,i,j]=ops[k++];rows.push({type:'equal',a:{n:i+1,html:esc(a[i]),text:a[i]},b:{n:j+1,html:esc(b[j]),text:b[j]}});continue}
    const removed=[],added=[];
    while(k<ops.length&&ops[k][0]!=='equal'){const [t,i,j]=ops[k++];(t==='removed'?removed:added).push(t==='removed'?i:j)}
    const pairs=Math.min(removed.length,added.length);
    for(let p=0;p<pairs;p++){const w=wordDiffParts(a[removed[p]],b[added[p]]);rows.push({type:'changed',a:{n:removed[p]+1,html:partsHTML(w.a),text:a[removed[p]],parts:w.a},b:{n:added[p]+1,html:partsHTML(w.b),text:b[added[p]],parts:w.b}})}
    for(const i of removed.slice(pairs))rows.push({type:'removed',a:{n:i+1,html:esc(a[i]),text:a[i]},b:null});
    for(const j of added.slice(pairs))rows.push({type:'added',a:null,b:{n:j+1,html:esc(b[j]),text:b[j]}});
  }
  // where each line starts in its whole text (for the log prob cliffs), and its words as parts
  const starts=(lines)=>{let at=0;return lines.map(l=>{const s=at;at+=l.length+1;return s})};
  const aStart=starts(a),bStart=starts(b);
  for(const row of rows){
    if(row.a){row.a.offset=aStart[row.a.n-1];row.a.parts??=[[row.a.text,null]]}
    if(row.b){row.b.offset=bStart[row.b.n-1];row.b.parts??=[[row.b.text,null]]}
  }
  return rows;
}
/** The rows as one aligned grid (line number and text on each side), headed by the model that produced each side.
 *  `cliffs` ({a: [...], b: [...]}: marks as in partsWithCliffsHTML) are drawn inside the lines. */
export function lineDiffHTML(left,right,labels={},isHeading=null,cliffs=null){
  // labels === null: no header row (the caller already names the two sides)
  const rows=lineDiff(left,right);
  if(!rows.length)return '';
  const inLine=(side,c)=>c&&(cliffs?.[side]??[]).filter(r=>r.end>c.offset&&r.start<c.offset+c.text.length);
  const body=(side,c)=>{const here=inLine(side,c);return c?(here&&here.length?partsWithCliffsHTML(c.parts,c.offset,here):c.html)||'&nbsp;':''};
  const cell=(side,c,type)=>`<span class="diff-num" aria-hidden="true">${c?c.n:''}</span><div class="diff-cell ${side} ${c?(type==='equal'?'':type==='changed'?'changed':side==='a'?'removed':'added'):'gap'} ${c&&isHeading&&isHeading(c.text)?'heading':''}">${body(side,c)}</div>`;
  const head=labels===null?'':`<div class="diff-row diff-head"><span class="diff-num" aria-hidden="true"></span><div class="diff-cell a">${esc(labels.a||'Replay A')}</div><span class="diff-num" aria-hidden="true"></span><div class="diff-cell b">${esc(labels.b||'Replay B')}</div></div>`;
  return `<div class="diff-lines" role="group" aria-label="Line by line comparison">${head}${rows.map(x=>`<div class="diff-row ${x.type}">${cell('a',x.a,x.type)}${cell('b',x.b,x.type)}</div>`).join('')}</div>`;
}

/**
 * The Diff's decision tree for one turn: a collapsible holding both replays' walks side by side, line by line, headed
 * by the model that made each (so a different choice, option list or reason stands out as a changed line).
 */
export function decisionTreeDiffHTML(traceA,traceB,labels){
  const la=traceLines(traceA),lb=traceLines(traceB);
  if(!la.length&&!lb.length)return '<details class="decision-tree"><summary>Decision tree <span class="badge">none recorded</span></summary><p class="small decision-empty">No decision tree was recorded for either response.</p></details>';
  const steps=(t)=>Array.isArray(t)?t.length:0;
  const n=(x)=>`${x} ${x===1?'step':'steps'}`;
  const differs=la.join('\n')!==lb.join('\n');
  return `<details class="decision-tree diff-tree"><summary>Decision tree <span class="badge">A · ${n(steps(traceA))}</span><span class="badge">B · ${n(steps(traceB))}</span>${differs?'<span class="badge decision-differs">Differs</span>':''}</summary>${lineDiffHTML(la.join('\n'),lb.join('\n'),labels,(t)=>STEP_HEADING.test(t))}</details>`;
}

const $ = (id) => document.getElementById(id);
const all = (sel) => [...document.querySelectorAll(sel)];

/** Wire the tablist (click + arrow-key navigation). */
export function bindTabs(onSelect) {
  const tabs = all('[data-workspace-tab]');
  tabs.forEach((b, index) => {
    b.onclick = () => onSelect(b.dataset.workspaceTab);
    b.onkeydown = (e) => {
      let next = index;
      if (e.key === 'ArrowRight') next = (index + 1) % tabs.length;
      else if (e.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = tabs.length - 1;
      else return;
      e.preventDefault();
      tabs[next].click();
    };
  });
}

export const focusTab = (id) => $('tab-' + id).focus();

export function bindReplayConfig(h) {
  $('replay-agent').onchange = (e) => h.onAgent(e.target.value);
  $('replay-reasoning').onchange = (e) => h.onReasoning(e.target.value);
  $('replay-temperature').onchange = (e) => h.onTemperature(e.target.value);
  $('replay-kb-summary').onchange = (e) => h.onKbSummary(e.target.checked);
  $('replay-logprobs').onchange = (e) => h.onLogprobs(e.target.checked);
  $('replay-brief').onchange = (e) => h.onBriefReplies(e.target.checked);
  for (const slot of ['a', 'b']) {
    $('model-' + slot).onchange = () => h.onModels([$('model-a').value, $('model-b').value]);
  }
}

export function bindReplayControls(h) {
  if ($('stop-play')) $('stop-play').onclick = h.onPlay;
  if ($('view-diff-chat')) $('view-diff-chat').onclick = () => h.onViewDiff('chat');
  if ($('view-diff-api')) $('view-diff-api').onclick = () => h.onViewDiff('api');
  $('hide-prompts').onclick = () => h.onTogglePrompts(true);
  $('show-prompts').onclick = () => h.onTogglePrompts(false);
  all('[data-result]').forEach((b) => (b.onclick = () => h.onResultTab(b.dataset.result)));
  if ($('reset-replay')) $('reset-replay').onclick = h.onReset;
  if ($('diff-api-btn')) $('diff-api-btn').onclick = () => h.onViewDiff('api');
  if ($('diff-chat-btn')) $('diff-chat-btn').onclick = () => h.onViewDiff('chat');
  if ($('open-config')) $('open-config').onclick = h.onConfig;
  if ($('step-replay')) $('step-replay').onclick = h.onStep;
  if ($('play-replay')) $('play-replay').onclick = h.onPlay;
}

export function bindHistory(h) {
  all('[data-compare-record]').forEach((b) => (b.onclick = () => h.onCompare(b.dataset.compareRecord)));
  all('[data-api-log]').forEach((b) => (b.onclick = () => h.onApiLog(b.dataset.apiLog)));
}

export function bindDiff(h) {
  const start = $('diff-start');
  if (start) {
    start.onclick = h.onOpenReplay;
    return;
  }
  for (const side of ['a', 'b']) {
    const select = $('diff-' + side);
    if (select) select.onchange = (e) => h.onSelect(side, e.target.value);
  }
  if ($('hide-selectors')) $('hide-selectors').onclick = () => h.onToggleSelectors(true);
  if ($('show-selectors')) $('show-selectors').onclick = () => h.onToggleSelectors(false);
  if ($('model-diff')) $('model-diff').ontoggle = (e) => h.onToggleModelDiff(e.target.open);
  const settings = $('diff-settings');
  if (settings) settings.onclick = () => h.onDiffSettings();
  const views = all('[data-diff-view]');
  views.forEach((b, index) => {
    b.onclick = () => h.onView(b.dataset.diffView);
    b.onkeydown = (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      views[(index + (e.key === 'ArrowRight' ? 1 : views.length - 1)) % views.length].click();
    };
  });
}
