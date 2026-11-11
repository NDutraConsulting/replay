"""Canned replies used when no API is configured (demo mode). Text matches the old browser demo."""


def demo_response(history: list[dict], target: str, agent: str, models: list[str], source: str | None = None) -> str:
    """The canned reply, plus (when the knowledge base was routed) a line naming the file it reached."""
    text = _demo_text(history, target, agent, models)
    return f"{text}\n\nKnowledge base: {source}" if source else text


def _demo_text(history: list[dict], target: str, agent: str, models: list[str]) -> str:
    prompt = next((m["content"] for m in reversed(history) if m["role"] == "user"), "")
    excerpt = prompt[:150] + "…" if len(prompt) > 150 else prompt
    index = models.index(target) if target in models else -1

    if agent == "code":
        return (
            f"Demo · {target}\n\nFor “{excerpt}”, I’d start with a small, reviewable implementation:\n\n"
            "1. Define the inputs and expected behavior.\n2. Build the smallest working version.\n"
            "3. Verify the main path and one meaningful failure case.\n\n"
            "Connect an API in Account for a real model-generated implementation."
        )
    if agent == "research":
        return (
            f"Demo · {target}\n\nResearch plan for “{excerpt}”:\n\n1. Clarify the question and scope.\n"
            "2. Gather primary sources.\n3. Compare evidence and identify uncertainties.\n\n"
            "This is an illustrative response. No research has been performed. "
            "Connect your API for live model responses."
        )
    if index == 1:
        return (
            f"Demo · {target}\n\nHere’s a concise direction for “{excerpt}”:\n\n"
            "Choose one clear goal, make the next action obvious, and test the idea with a small team. "
            "Build from what you learn.\n\nConnect your API in Account to get a real response."
        )
    if index == 2:
        return (
            f"Demo · {target}\n\nLet’s explore “{excerpt}” in more detail.\n\n"
            "Start with the people using it: what are they trying to accomplish, and what gets in their way? "
            "Turn that into a short brief with a goal, core actions, and a way to measure success.\n\n"
            "Then make a small prototype, walk through it together, and revise the confusing parts.\n\n"
            "This is an illustrative demo. Connect your API for live responses."
        )
    return (
        f"Demo · {target}\n\nA useful starting point for “{excerpt}”:\n\n1. Keep the purpose clear.\n"
        "2. Focus on the most important next step.\n3. Leave room to try a different approach.\n\n"
        "You can rewind this turn to edit your prompt, or open Replay to compare another model’s output. "
        "Connect an API in Account for real AI responses."
    )
