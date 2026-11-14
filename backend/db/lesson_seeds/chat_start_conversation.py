"""Lesson 1: start a conversation on the Chat page (File > New, then each field of the New conversation popup).

`target` selectors are the ids in `openNewConversationModal` (replay-chat-vite/src/features/chat/chat-ui.js) and the File menu;
a frontend test checks that every one still exists. Body text is plain; **double stars** make bold.
`action` runs when the step appears; `on_next: click` means Next clicks the target for the user (and so does the user's own
click); `on_target_gone: next` means the step is done when its target disappears (the popup closed because Start was clicked). With both
`on_next: click` and `on_target_gone: next`, Next clicks the target and the step waits for it to go (the replay lesson's Open).
"""

_FIELD = "#new-chat-"


def _step(position, title, body, avatar, target=None, **extra):
    return {"position": position, "title": title, "body": body, "avatar_slug": avatar, "target": target, **extra}


CHAT_START_CONVERSATION = {
    "slug": "chat-start-conversation",
    "page": "chat",
    "title": "Start a conversation",
    "summary": "Open the New conversation popup and learn what every setting does.",
    "sort_order": 1,
    "version": 1,
    "steps": [
        _step(
            0,
            "Welcome!",
            "Hi, I'm Rex. In about two minutes I'll show you how to start a conversation and what each setting is for. "
            "You can skip any time, and you can come back to this lesson from the **File** menu.",
            "guide",
        ),
        _step(
            1,
            "Open the File menu and choose New",
            "Every conversation starts here. Open **File**, then choose **New**. Press Next and I'll do it for you.",
            "points-up-left",
            "#file-new",
            action="open-menu",
            on_next="click",
            placement="right",
        ),
        _step(
            2,
            "Name your conversation",
            "Type a name so you can find it later. It is only a label and it can repeat. "
            "Try something like **My first conversation**.",
            "points-down-right",
            _FIELD + "name",
            action="fill",
            action_arg="My first conversation",
            placement="top",
        ),
        _step(
            3,
            "Pick an AI agent",
            "The agent decides how the assistant behaves and which knowledge base it can use. "
            "Open the list and choose one. **General assistant** is a good start.",
            "floating-robot",
            _FIELD + "agent",
            action="open-select",
            placement="top",
        ),
        _step(
            4,
            "Pick an API provider",
            "The provider is the service that runs the model. You add providers on your Account page. "
            "Choose **OpenAI**, and the model list below follows it.",
            "golden-ai-orb",
            _FIELD + "provider",
            action="open-select",
            placement="top",
        ),
        _step(
            5,
            "Pick a model",
            "The model is the AI that writes the answers. The list shows only the models of the provider you chose. "
            "Choose **gpt-5.5**.",
            "tesseract",
            _FIELD + "model",
            action="open-select",
            placement="top",
        ),
        _step(
            6,
            "Pick a reasoning level",
            "Reasoning is how much the model thinks before it answers. More thinking can mean better answers, but "
            "slower and more expensive ones. Choose **None**. A reasoning model only accepts a temperature when "
            "reasoning is None, and the next step needs that.",
            "thoughtful",
            _FIELD + "reasoning",
            action="open-select",
            placement="top",
        ),
        _step(
            7,
            "Temperature: choose 0",
            "Temperature is how much randomness the model adds when it picks each next word. High values give varied, "
            "creative answers, and the same prompt can come back different every time. Reasoning is None, so the model "
            "accepts a temperature. Choose **0** so the same prompt gives (almost) the same answer. That is what you need to compare conversations and replays fairly.",
            "rubiks-cube",
            _FIELD + "temperature",
            action="focus",
            placement="top",
        ),
        _step(
            8,
            "KB summary tool",
            "Your agent has a knowledge base. **Off**: the whole file the agent picks is sent to the model. "
            "**On**: a model first writes a short summary of the file and that is sent instead. "
            "Leave it off unless your files are very long.",
            "summary-clipboard",
            _FIELD + "kbsummary",
            placement="top",
        ),
        _step(
            9,
            "Brief replies: turn this on",
            'Switch **Brief replies** on. It adds "Respond in 100 words or less." to every request, so answers stay '
            "short, cheap and easy to compare.",
            "thumbs-up",
            _FIELD + "brief",
            placement="top",
        ),
        _step(
            10,
            "Start the conversation",
            "All set! Click **Start conversation** when you're ready. These settings are fixed once it starts, so "
            "check them first. I won't click it for you.",
            "double-thumbs-up",
            ".modal-actions button[type=submit]",
            on_target_gone="next",
            placement="top",
        ),
        _step(
            11,
            "You did it!",
            "That's how a conversation starts. Type your first prompt and press **Send message**. "
            "You can repeat this lesson any time from the **File** menu.",
            "amazed",
        ),
    ],
}
