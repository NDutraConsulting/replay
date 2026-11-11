"""Helpers for the knowledge-base routing tests: a scripted model that plays the router, and a small knowledge base."""

import json
import re

from services.llm_service import LLMError

ROUTER_PREFIX = "You are the retrieval step"
SUMMARY_PREFIX = "You are the summarizing step"


def is_router(call: dict) -> bool:
    return call["system"].startswith(ROUTER_PREFIX)


def level_of(call: dict) -> str:
    return re.search(r"^Level: (\w+)", call["messages"][0]["content"], re.M).group(1)


def options_of(call: dict) -> list[str]:
    """The option names a router call was shown, in order."""
    return re.findall(r"^\d+: (.*)$", call["messages"][0]["content"], re.M)


def is_summary(call: dict) -> bool:
    """A KB-summary-tool call or a Compact call."""
    return call["system"].startswith(SUMMARY_PREFIX)


def router_calls(stub) -> list[dict]:
    return [c for c in stub.calls if is_router(c)]


def summary_calls(stub) -> list[dict]:
    return [c for c in stub.calls if is_summary(c)]


def answer_calls(stub) -> list[dict]:
    return [c for c in stub.calls if not is_router(c) and not is_summary(c)]


class ScriptedModel:
    """Install as llm_stub.reply. Router calls get the scripted choice for their level; everything else is the answer.

    choices:      {level: 2 | None | "raw text" | [first, second, ...] | callable(call) -> str}   (default: option 1)
                  a list is consumed one entry per call (the last entry repeats), e.g. ["not json", 1] to test the retry
    by_model:     {model: choices} to make different models choose differently
    answer_error: {model: exception} raised for a model's ANSWER call (not its router calls)
    summary:      the reply to a summarizing call (KB-summary-tool or Compact); default "summary by <model>"
    """

    def __init__(self, stub, choices=None, by_model=None, answer="the answer", answer_error=None, summary=None):
        self.choices = {k: list(v) if isinstance(v, list) else v for k, v in (choices or {}).items()}
        self.by_model = by_model or {}
        self.answer = answer
        self.answer_error = answer_error or {}
        self.summary = summary  # str, or callable(call) -> str; default: "summary by <model>"
        stub.reply = self

    def __call__(self, call: dict) -> str:
        if is_summary(call):
            if callable(self.summary):
                return self.summary(call)
            return self.summary if self.summary is not None else f"summary by {call['model']}"
        if not is_router(call):
            if call["model"] in self.answer_error:
                raise self.answer_error[call["model"]]
            return self.answer
        script = self.by_model.get(call["model"], self.choices)
        choice = script.get(level_of(call), 1)
        if isinstance(choice, list):
            choice = choice.pop(0) if len(choice) > 1 else choice[0]
        if callable(choice):
            return choice(call)
        if isinstance(choice, str):
            return choice
        return json.dumps({"choice": choice, "reason": f"{call['model']} picked {choice}"})


def provider_error() -> LLMError:
    return LLMError(502, "llm_http_error", "API returned HTTP 500. Check your key, model ID, and endpoint in Account.")


def connect(client, models=("m1", "m2")):
    """Add (or, when it exists, change) the API labelled "Default"."""
    body = {"label": "Default", "url": "https://api.example.com/v1", "api_key": "sk-secret", "models": list(models)}
    response = client.post("/api/connections", json=body)
    if response.status_code == 422:  # already there: change its models
        existing = next(c for c in client.get("/api/connections").json() if c["label"] == "Default")
        response = client.put(f"/api/connections/{existing['connection_id']}", json={"models": body["models"]})
        assert response.status_code == 200, response.text
        return
    assert response.status_code == 201, response.text


def _ok(response):
    assert response.status_code < 300, response.text
    return response.json()


def build_kb(client, agent="assistant"):
    """A small knowledge base for `agent` (default: the assistant, whose seeded knowledge base is empty):

    Networks > Segmentation > net.txt (current), old.txt (archived), pending.txt (pending-review),
                              bad.txt (malicious-active), q.txt (quarantined)
    Cloud    > IAM          > iam.txt (current)
    Hidden   > Only bad     > x.txt (quarantined)         <- nothing usable, so never offered
    """

    def category(name):
        return _ok(client.post(f"/api/agents/{agent}/categories", json={"name": name}))["category_id"]

    def sub(category_id, name):
        return _ok(client.post(f"/api/categories/{category_id}/subcategories", json={"name": name}))["subcategory_id"]

    def doc(sub_id, title, content, status):
        return _ok(
            client.post(
                f"/api/subcategories/{sub_id}/documents", json={"title": title, "content": content, "status": status}
            )
        )

    networks, cloud, hidden = category("Networks"), category("Cloud"), category("Hidden")
    segmentation, iam, only_bad = sub(networks, "Segmentation"), sub(cloud, "IAM"), sub(hidden, "Only bad")
    doc(segmentation, "net.txt", "Segment the network by trust level.", "current")
    doc(segmentation, "old.txt", "OLD CONTENT", "archived")
    doc(segmentation, "pending.txt", "PENDING CONTENT", "pending-review")
    doc(segmentation, "bad.txt", "MALICIOUS CONTENT", "malicious-active")
    doc(segmentation, "q.txt", "QUARANTINED CONTENT", "quarantined")
    doc(iam, "iam.txt", "Use least privilege.", "current")
    doc(only_bad, "x.txt", "NEVER OFFER THIS", "quarantined")
    return {"networks": networks, "cloud": cloud, "hidden": hidden, "segmentation": segmentation, "iam": iam}


async def connect_async(client, models=("m1", "m2")):
    response = await client.post(
        "/api/connections",
        json={"label": "Default", "url": "https://api.example.com/v1", "api_key": "sk-secret", "models": list(models)},
    )
    assert response.status_code == 201, response.text


async def build_kb_async(client, agent="assistant"):
    """The same small knowledge base as build_kb, for the async client."""

    async def post(url, body):
        response = await client.post(url, json=body)
        assert response.status_code < 300, response.text
        return response.json()

    networks = (await post(f"/api/agents/{agent}/categories", {"name": "Networks"}))["category_id"]
    cloud = (await post(f"/api/agents/{agent}/categories", {"name": "Cloud"}))["category_id"]
    segmentation = (await post(f"/api/categories/{networks}/subcategories", {"name": "Segmentation"}))["subcategory_id"]
    iam = (await post(f"/api/categories/{cloud}/subcategories", {"name": "IAM"}))["subcategory_id"]
    await post(
        f"/api/subcategories/{segmentation}/documents",
        {"title": "net.txt", "content": "Segment it.", "status": "current"},
    )
    await post(
        f"/api/subcategories/{iam}/documents", {"title": "iam.txt", "content": "Least privilege.", "status": "current"}
    )
