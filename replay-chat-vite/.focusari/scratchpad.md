This element should start hidden. And the tool tip hint should have a z-index that sits outside it so that it is visible to the user.

<div class="side-card"><div class="side-top"><div class="row"><span class="side-title">This conversation</span><div class="prompt-head-actions"><span class="badge">3 turns</span><button type="button" class="collapse-prompts tooltip" id="hide-conversation" aria-label="Hide this conversation" aria-controls="conversation-sidebar" aria-expanded="true" data-tip="Slide this conversation into the left edge.">−</button></div></div><div class="small" style="margin-top:5px">A creative workspace</div></div><div class="turn-list"><button class="turn-item " data-jump="0"><span class="turn-number">01</span><span class="turn-text">Help me plan a simple website for my new project.</span></button><button class="turn-item " data-jump="1"><span class="turn-number">02</span><span class="turn-text">It’s a creative workspace for small teams. I want it to feel simple and approachable.</span></button><button class="turn-item current" data-jump="2"><span class="turn-number">03</span><span class="turn-text">Can you turn that into a short project brief?</span></button></div><div class="side-footer small"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"></path></svg>Saved to your account</div></div>

##

<main class="container" id="main"><div class="page-heading kb-page-heading"></main>

##

Make it possible to reduce the width of this panel by dragging it.

<section class="panel kb-tree-panel" aria-label="Knowledge base">

##

The decision tree block should clearly label each decision step.

##

On the diff page there should be a tab options:[chat, API logs]

###

Change this save button > <button class="btn" id="save-replay"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"></path></svg>Save replay</button>
to config. The user should be able to change the config after a run. When the config is changed it should reset the replay so that the user can start a new run.

###

Set the max number of user prompts to 10 with a config in the .env

###

We should set up the API list with default API URL routes for OpenAI API, Antropic API, google gemini, fireworks AI, featherless AI, or custom(for local api hosts)

###

For this element

<section class="panel diff-selectors"><div class="diff-selector"><label class="field-label" for="diff-a">Replay A</label><select id="diff-a" class="diff-select">

we need to use the left side slider button like the one used in the replay tab
<button class="prompts-restore visible" id="show-prompts" aria-label="Show your prompts" aria-controls="prompts-panel" aria-expanded="false"><span class="restore-plus" aria-hidden="true">+</span><span>Your prompts</span></button>

It should say Select Replays.

###

Update the following with a new chat button that opens the new chat popup

<div class="toolbar-right"><span class="badge"><span class="dot"></span>API connected</span>{+ New Chat button}</div>

###

Update this > On: "Respond in 100 words or less." is added to the end of each request sent to the model. Off: requests are sent as you wrote them.

with
On: "Respond in 100 words or less." is added to the end of each request sent to the model. Off: requests are sent as you wrote them. -Ron Swanson

###

are you storing the full message in the chat record DB?

###

This should display the settings as a bullet list with font size 10

<div class="source-chat"><div class="field-label">Current chat · Physics</div><div class="config-chips" aria-label="Settings (read-only)"><span class="chip"><b>Agent</b>General assistant</span><span class="chip"><b>Model</b>OpenAI (server key) · gpt-5.5</span><span class="chip"><b>Reasoning</b>Default (model decides)</span><span class="chip"><b>Temperature</b>0</span><span class="chip"><b>KB summary tool</b>Off</span><span class="chip"><b>Brief replies</b>On</span></div><p class="small source-chat-note">A replay starts from these settings. The chat's own settings never change; change the replay's below before you start it.</p></div>

##

On the replay page
The open a chat modal should have 2 steps in the modal.
step 1 is selecting a chat. The open button should say select on this view.
step 2 should display the config menu. The config menu should default to the selected chats settings when opening a chat record in replay. Then this config view should show the open button

###

on the replay page
The reset button should only be displayed after all the user prompts have been sent and other buttons should be hidden so that the user only sees on option

<div class="replay-controls"><button class="btn blue tooltip" id="reset-replay" data-tip="Start a new replay. Saved results remain available in Diff."><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m11 5-8 7 8 7V5Zm10 0-8 7 8 7V5Z"></path></svg>Reset</button><button class="btn" id="step-replay"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 4 12 8-12 8V4ZM20 4v16"></path></svg>Step through</button><button class="btn yellow" id="play-replay"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 4 14 8-14 8V4Z"></path></svg>Play all</button><button class="btn" id="open-config"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h9M17 7h3M4 17h3M11 17h9"></path><circle cx="15" cy="7" r="2"></circle><circle cx="9" cy="17" r="2"></circle></svg>Config</button></div>
