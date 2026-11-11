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
