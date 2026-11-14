"""Lesson 2: replay a chat on two models and compare them (Replay page: File > Open and Config, Replay tab with Play all, then the
Diff tab: Chat view, API logs view and Model Diff).

The lesson replays a sample chat that is seeded into each user's chat history (`sample_conversation`, below): the five prompts of
the lesson with short answers. Its id is `lesson-<slug>-<user id>`, so the lesson can find it in the Open popup.
`target` selectors are ids and classes of the Replay page (replay-ui.js, chat-picker-ui.js, replay-file-menu.js); a test checks
that each still exists. `advance_on` waits for an element (the "Replay complete" popup) and then moves on by itself.
"""

SLUG = "replay-compare-models"
SAMPLE_ID_PREFIX = f"lesson-{SLUG}-"
"""The Open popup radio for the sample chat has a value that starts with this (it ends with the user id)."""

SAMPLE_CONVERSATION = {
    "name": "Lesson: Happiness books",
    "agent_id": "assistant",
    "temperature": 0.0,
    "brief_replies": True,
    "messages": [
        {"role": "user", "content": "List the 10 best books about happiness"},
        {
            "role": "assistant",
            "content": "Popular picks: The Happiness Hypothesis (Haidt), Authentic Happiness (Seligman), Flow "
            "(Csikszentmihalyi), The Art of Happiness (Dalai Lama and Cutler), Stumbling on Happiness (Gilbert), The How of "
            "Happiness (Lyubomirsky), Happier (Ben-Shahar), The Happiness Project (Rubin), Man's Search for Meaning "
            '(Frankl) and The Book of Joy (Dalai Lama and Tutu). "Best" depends on whether you want science, memoir or '
            "practice.",
        },
        {"role": "user", "content": "What about Yojokun and Nicomachean ethics?"},
        {
            "role": "assistant",
            "content": "Both are older and more practical. Yojokun, by the Japanese scholar Kaibara Ekiken (1713), is a "
            "guide to living well through moderation, routine and care for the body. Aristotle's Nicomachean Ethics argues "
            "that happiness (eudaimonia) is a life of virtue, built by habit and used well over a whole life.",
        },
        {"role": "user", "content": "What about the Tao te ching"},
        {
            "role": "assistant",
            "content": "The Tao Te Ching, attributed to Laozi, is a short book of verses. It treats contentment as living "
            "in step with the Way: simplicity, humility, and wu wei, acting without forcing. Happiness there is less a goal "
            "to chase than what remains when you stop striving against things.",
        },
        {"role": "user", "content": "How do the tao te ching, Yojokun, and Nicomachean ethics overlap?"},
        {
            "role": "assistant",
            "content": "All three prize moderation and balance over excess. All treat a good life as something practiced "
            "daily, not found once. And each ties wellbeing to living in harmony with something larger: nature and the "
            "Way for the Tao Te Ching and Yojokun, reason and virtue for Aristotle.",
        },
        {
            "role": "user",
            "content": "How do the tao te ching, Yojokun, and Nicomachean ethics overlap with Shakespear",
        },
        {
            "role": "assistant",
            "content": "Shakespeare shows the cost of missing the balance they teach. Macbeth and Lear are undone by "
            "unchecked ambition and pride. Hamlet's praise of Horatio, a man who is \"not passion's slave\", echoes "
            "Aristotle's self-mastery and the calm of the Tao Te Ching. The plays dramatize what the books advise.",
        },
    ],
}


def _step(position, title, body, avatar, target=None, **extra):
    return {"position": position, "title": title, "body": body, "avatar_slug": avatar, "target": target, **extra}


_OPEN = ".modal-actions button[type=submit]"

REPLAY_COMPARE_MODELS = {
    "slug": SLUG,
    "page": "replay",
    "title": "Replay a chat and compare two models",
    "summary": "Open a chat in Replay, set up two models, play it all, then read the differences in the Diff tab.",
    "sort_order": 2,
    "version": 1,
    "sample_conversation": SAMPLE_CONVERSATION,
    "steps": [
        _step(
            0,
            "Welcome to Replay!",
            "Replay runs the prompts of a chat again on two models at once, so you can see how they differ. I put a "
            "sample chat called **Lesson: Happiness books** in your chat history, with five prompts. We'll replay it. "
            "You can skip any time and come back from the **File** menu.",
            "guide",
        ),
        _step(
            1,
            "Open a chat",
            "A replay always starts from a chat. Open **File**, then choose **Open**. Press Next and I'll do it for you.",
            "points-up-left",
            "#file-open",
            action="open-menu",
            on_next="click",
            placement="right",
        ),
        _step(
            2,
            "Choose the sample chat",
            "Your chats are listed here, newest first. I've picked **Lesson: Happiness books** for you. "
            "Any chat of yours works the same way.",
            "giant-cassette",
            ".chat-options",
            action="check-radio",
            action_arg="input[value^='lesson-replay-compare-models-']",
            placement="top",
        ),
        _step(
            3,
            "Select it",
            "Press **Select** to go to the settings for this replay. Press Next and I'll press it for you.",
            "thumbs-up-gives",
            _OPEN,
            on_next="click",
            placement="top",
        ),
        _step(
            4,
            "AI agent",
            "The agent decides how the assistant behaves and which knowledge base it can use. The replay starts from "
            "the chat's own setting, shown in green beside the label.",
            "floating-robot",
            "#replay-agent",
            action="open-select",
            placement="top",
        ),
        _step(
            5,
            "Model A",
            "Replay A is your baseline. The list reads **provider · model**, so the same model on two providers stays "
            "two choices. Choose **OpenAI · gpt-5.5**.",
            "tesseract",
            "#model-a",
            action="open-select",
            placement="top",
        ),
        _step(
            6,
            "Model B",
            "Replay B is the challenger. Pick a **different** model from A so there is something to compare, "
            "for example **OpenAI · gpt-5.4**. (The same model on different hardware works too.)",
            "glowing-tesseracts",
            "#model-b",
            action="open-select",
            placement="top",
        ),
        _step(
            7,
            "Reasoning level",
            "How much the models think before answering. Both replays use the same level so the comparison is fair. "
            "Choose **None**. A reasoning model only accepts a temperature when reasoning is None, and the next step "
            "needs that.",
            "thoughtful",
            "#replay-reasoning",
            action="open-select",
            placement="top",
        ),
        _step(
            8,
            "Temperature: choose 0",
            "Temperature is how much randomness a model adds. Reasoning is None, so the models accept one. Choose **0**: "
            "the same prompt then gives (almost) the same answer, so any difference you see comes from the models, "
            "not from chance.",
            "rubiks-cube",
            "#replay-temperature",
            action="focus",
            placement="top",
        ),
        _step(
            9,
            "KB summary tool",
            "**Off**: the whole knowledge base file the agent picks is sent to the model. **On**: a model writes a "
            "short summary first and that is sent instead. Leave it off unless your files are long.",
            "summary-clipboard",
            "#replay-kb-summary",
            placement="top",
        ),
        _step(
            10,
            "Brief replies: turn this on",
            'Switch it **on**. It adds "Respond in 100 words or less." to every request, so both models answer '
            "briefly and the replay is quick and cheap.",
            "thumbs-up",
            "#replay-brief",
            placement="top",
        ),
        _step(
            11,
            "Log probs (optional)",
            "Ask the models for token log probabilities. The Diff then marks where the two answers diverge and where "
            'a model was unsure (a "cliff"). It\'s optional, and fine to leave off for now.',
            "yellow-glasses",
            "#replay-logprobs",
            placement="top",
        ),
        _step(
            12,
            "Open the replay",
            "Click **Open** to load the chat into a new replay. Press Next and I'll click it for you.",
            "double-thumbs-up",
            _OPEN,
            on_next="click",
            on_target_gone="next",
            placement="top",
        ),
        _step(
            13,
            "The chat you opened",
            "This is the **History** tab: the chat as it was, and the replays of it so far. Nothing has been sent to a "
            "model yet.",
            "lab-coat-guide",
            "#workspace-content",
            placement="bottom",
        ),
        _step(
            14,
            "Go to the Replay tab",
            "Replays are played from the **Replay** tab. Press Next and I'll take you there.",
            "curious-points-up",
            "#tab-replay",
            on_next="click",
            placement="bottom",
        ),
        _step(
            15,
            "Your prompts",
            "These are the five prompts from the chat, just your side. Both models will answer each one, in order.",
            "summary-sign",
            "#prompts-panel",
            placement="right",
        ),
        _step(
            16,
            "Play all",
            "**Step through** sends one prompt at a time. **Play all** runs every prompt on both models. "
            "Press Next and I'll start it.",
            "cassette-player",
            "#play-replay",
            on_next="click",
            placement="bottom",
        ),
        _step(
            17,
            "Replaying...",
            "Both models are answering your five prompts. This takes a moment. I'll carry on when they're done.",
            "checks-clock",
            "#play-all-popup .play-modal",
            advance_on="#play-all-popup .play-check",
            placement="bottom",
        ),
        _step(
            18,
            "Replay complete",
            "Both models answered every prompt, and the results are saved. Press **Next** and I'll open **Diff Chat**.",
            "thumbs-up",
            "#view-diff-chat",
            on_next="click",
            placement="top",
        ),
        _step(
            19,
            "Chat diff",
            "The Diff tab puts Replay A (left) and Replay B (right) side by side. This is the **Chat** view: the answers "
            "line by line. Red marks words only A had, green marks words only B had, and lines without a mark are the same.",
            "skeptical-points-left",
            ".diff-turn .diff-lines",  # the line-by-line comparison; the card sits over it at its right end (the B side)
            placement="top-end",
        ),
        _step(
            20,
            "API logs diff",
            "The answers are only half of it. Press Next and I'll switch to **API logs**.",
            "winking-points-left",
            "#diff-view-api",
            on_next="click",
            placement="bottom",
        ),
        _step(
            21,
            "What was really sent",
            "These are the raw requests behind each answer, call by call: the exact text sent to each model and what "
            "came back. Use it to check that both replays received the same input.",
            "dodecahedron",
            ".api-diff-turn",
            placement="top",
        ),
        _step(
            22,
            "Model Diff",
            "**Model Diff** lists every setting that differs between A and B, such as the model, the provider or the "
            "reasoning level. If they differ, that is the likely reason the answers do.",
            "golden-ai-orb",
            "#model-diff",
            action="open-details",
            placement="bottom",
        ),
        _step(
            23,
            "You did it!",
            "That's the whole loop: open a chat, set up two models, play it all, and read the differences. "
            "Repeat this lesson any time from the **File** menu.",
            "amazed",
        ),
    ],
}
