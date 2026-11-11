"""The model rules (services/OpenAI_API_Model_rules.py): scenario by scenario, then through the real request."""

import json

import httpx
import pytest

from services import OpenAI_API_Model_rules as rules
from services import llm_service

real_complete = llm_service.complete  # before the autouse stub replaces it
REAL_ASYNC_CLIENT = httpx.AsyncClient


# (model, reasoning_effort asked for, temperature asked for) -> (effort sent, temperature sent)
SCENARIOS = [
    # GPT-6 Terra and Luna accept "none", and then take a temperature
    ("gpt-6.1-terra", "none", 0, ("none", 0)),
    ("gpt-6-luna", "none", 0.7, ("none", 0.7)),
    # any other level (or Default) runs the model as a reasoning model: the temperature is left out
    ("gpt-6.1-terra", "high", 0, ("high", None)),
    ("gpt-6-luna", None, 0, (None, None)),  # Default: the model runs at its own default (medium), so no temperature
    ("gpt-6-luna", "max", 1, ("max", None)),
    # no temperature asked for: nothing to send
    ("gpt-6.1-terra", "none", None, ("none", None)),
    ("gpt-6.1-terra", None, None, (None, None)),
    # Astra and 6.1 Sol do not take "none", so they never take a temperature; their levels pass through
    ("gpt-6.1-sol", "low", 0, ("low", None)),
    ("gpt-6.1-sol", None, 0, (None, None)),
    ("gpt-6-astra", "xhigh", 0.5, ("xhigh", None)),
    # GPT-5.6 and the older GPT-5 models follow the same temperature rule
    ("gpt-5.6-luna", "none", 0, ("none", 0)),
    ("gpt-5.6-luna", None, 0, (None, None)),
    ("gpt-5.4-mini", "none", 0, ("none", 0)),
    ("gpt-5.5", "medium", 0, ("medium", None)),
    # models that do not reason: temperature always; a reasoning level does not apply
    ("gpt-4o", None, 0, (None, 0)),
    ("gpt-4o-mini", None, 1.3, (None, 1.3)),
    ("gpt-4o", "high", 0, (None, 0)),
    ("gpt-4.1", None, 0, (None, 0)),
    # anything else (a compatible API, a model with no rule): sent as chosen, the provider decides
    ("llama3", None, 0, (None, 0)),
    ("llama3", "high", 0.2, ("high", 0.2)),
    ("m1", "none", 0, ("none", 0)),
]


@pytest.mark.parametrize(("model", "effort", "temperature", "expected"), SCENARIOS)
def test_each_scenario_gives_the_request_the_model_expects(model, effort, temperature, expected):
    got = rules.resolve_params(model, effort, temperature)
    assert (got.reasoning_effort, got.temperature) == expected


@pytest.mark.parametrize(
    ("model", "effort"),
    [
        ("gpt-6.1-sol", "none"),
        ("gpt-6-astra", "none"),
        ("gpt-6.1-sol", "minimal"),
        ("gpt-6.1-terra", "minimal"),
        ("gpt-6-luna", "minimal"),
        ("gpt-5.6-terra", "minimal"),
    ],
)
def test_a_level_the_model_is_documented_not_to_accept_is_refused_before_any_request(model, effort):
    with pytest.raises(rules.UnsupportedSetting) as caught:
        rules.resolve_params(model, effort, 0)
    assert caught.value.status_code == 400 and caught.value.code == "llm_unsupported_setting"
    assert f"{model} does not support the reasoning level {effort}" in caught.value.message
    assert "It supports:" in caught.value.message


def test_levels_the_docs_do_not_list_for_a_model_are_not_enforced():
    for model in ("gpt-6-sol", "gpt-5.5", "gpt-5.4", "llama3"):
        for effort in rules.ALL_EFFORTS:
            assert rules.resolve_params(model, effort, None).reasoning_effort == effort  # the provider decides


def test_a_dropped_temperature_comes_with_the_reason():
    got = rules.resolve_params("gpt-6.1-terra", "high", 0)
    assert got.temperature is None
    assert "accepts a temperature only when the reasoning level is None" in got.temperature_note
    assert "runs at high" in got.temperature_note
    assert got.adjustments == [got.temperature_note]
    default = rules.resolve_params("gpt-6.1-terra", None, 0)
    assert "runs at medium" in default.temperature_note  # Default means the model's own default effort
    assert rules.resolve_params("gpt-6.1-terra", "none", 0).adjustments == []  # nothing changed, nothing to say


def test_a_reasoning_level_that_does_not_apply_is_dropped_with_the_reason():
    got = rules.resolve_params("gpt-4o", "high", 0)
    assert got.reasoning_effort is None
    assert got.adjustments == ["Reasoning effort high was not sent: gpt-4o is not a reasoning model."]


def test_the_temperature_is_kept_inside_the_range_the_model_accepts():
    got = rules.resolve_params("gpt-4o", None, 5)
    assert got.temperature == 2.0 and "changed to 2" in got.adjustments[0]
    assert rules.resolve_params("gpt-4o", None, 0).temperature == 0  # zero is a value, not "unset"


def test_which_rule_applied_is_reported():
    assert rules.resolve_params("gpt-6-luna", None, None).rule == "gpt-6-luna"  # an exact entry
    assert rules.resolve_params("gpt-5.4", None, None).rule == "gpt-5*"  # a family prefix
    assert rules.resolve_params("gpt-4o-mini", None, None).rule == "gpt-4*"
    assert rules.resolve_params("llama3", None, None).rule == "unknown"


def test_exact_entries_beat_a_family_prefix():
    assert rules.rule_for("gpt-5.6-luna")[0] == "gpt-5.6-luna"  # not gpt-5*
    assert rules.rule_for("gpt-5.6-luna")[1]["strict_efforts"] is True


def test_every_rule_has_every_key_and_a_valid_temperature_mode():
    keys = {
        "reasoning_model",
        "reasoning_efforts",
        "strict_efforts",
        "default_effort",
        "temperature",
        "temperature_range",
        "status",
        "source",
    }
    everything = [*rules.MODEL_RULES.values(), *(r for _, r in rules.FAMILY_RULES), rules.UNKNOWN_MODEL_RULE]
    for rule in everything:
        assert set(rule) == keys
        assert rule["temperature"] in ("always", "only_with_effort_none", "never")
        assert all(effort in rules.ALL_EFFORTS for effort in rule["reasoning_efforts"])
        low, high = rule["temperature_range"]
        assert low == 0.0 and high == 2.0
        assert rule["status"] in ("active", "deprecated", "assumed") and rule["source"]


def test_the_models_in_the_env_example_each_have_a_rule():
    from pathlib import Path

    line = next(
        x
        for x in (Path(__file__).parent.parent / ".env.example").read_text().splitlines()
        if x.startswith("OPENAI_MODELS=")
    )
    for model in line.split("=", 1)[1].split(","):
        assert rules.rule_for(model.strip())[0] != "unknown", f"{model} has no rule in OpenAI_API_Model_rules.py"


# ---- through the real request ---------------------------------------------------------------------------------------
def with_transport(monkeypatch, handler):
    monkeypatch.setattr(
        "services.llm_service.httpx.AsyncClient",
        lambda *args, **kwargs: REAL_ASYNC_CLIENT(*args, transport=httpx.MockTransport(handler), **kwargs),
    )


async def send(model, effort=None, temperature=None):
    return await real_complete(
        base_url="https://api.openai.com/v1", api_key="sk-secret", model=model, system="s",
        messages=[{"role": "user", "content": "hi"}], timeout=5, reasoning_effort=effort, temperature=temperature,
    )  # fmt: skip


@pytest.fixture(autouse=True)
def forget():
    llm_service._NO_TEMPERATURE.clear()
    yield
    llm_service._NO_TEMPERATURE.clear()


async def test_the_request_body_follows_the_rules_with_one_call_and_no_retry(monkeypatch):
    bodies = []

    def handler(request):
        bodies.append(json.loads(request.content))
        return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})

    with_transport(monkeypatch, handler)
    with llm_service.collect_calls() as calls:
        await send("gpt-6.1-terra", None, 0)  # Default effort + temperature: temperature must not go out
        await send("gpt-6.1-terra", "none", 0)  # effort none: temperature goes out
        await send("gpt-4o", None, 0)
    assert len(bodies) == 3  # no refused attempt, no retry
    assert "temperature" not in bodies[0] and "reasoning_effort" not in bodies[0]
    assert bodies[1]["temperature"] == 0 and bodies[1]["reasoning_effort"] == "none"
    assert bodies[2]["temperature"] == 0 and "reasoning_effort" not in bodies[2]
    dropped, kept, plain = (c["settings"] for c in calls)
    assert (
        dropped["temperature"] == 0
        and dropped["temperature_sent"] is False
        and "only when the reasoning level is None" in dropped["temperature_note"]
    )
    assert dropped["rule"] == "gpt-6.1-terra" and dropped["adjustments"] == [dropped["temperature_note"]]
    assert kept["temperature_sent"] is True and kept["adjustments"] == []
    assert plain["rule"] == "gpt-4*"


async def test_a_refused_level_never_reaches_the_network(monkeypatch):
    def handler(request):
        raise AssertionError("no request should be sent")

    with_transport(monkeypatch, handler)
    with pytest.raises(rules.UnsupportedSetting, match="gpt-6.1-sol does not support the reasoning level none"):
        await send("gpt-6.1-sol", "none", 0)


async def test_the_refusal_retry_is_still_the_safety_net_for_a_model_the_rules_do_not_know(monkeypatch):
    def handler(request):
        body = json.loads(request.content)
        if "temperature" in body:
            return httpx.Response(
                400, json={"error": {"message": "Unsupported value: 'temperature' is not supported."}}
            )
        return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})

    with_transport(monkeypatch, handler)
    with llm_service.collect_calls() as calls:
        assert await send("brand-new-model", None, 0) == "ok"
    assert [c["response"]["status"] for c in calls] == [400, 200]
    assert calls[1]["settings"]["rule"] == "unknown"
    assert any("refused the temperature" in a for a in calls[1]["settings"]["adjustments"])


# ---- log probabilities follow the temperature rule
@pytest.mark.parametrize(
    ("model", "effort", "sent"),
    [
        ("gpt-6.1-terra", "none", True),  # the one case a reasoning model takes them
        ("gpt-6-luna", "none", True),
        ("gpt-6.1-terra", "high", False),
        ("gpt-6.1-terra", None, False),  # Default runs at medium
        ("gpt-6.1-sol", None, False),  # Sol never takes none, so never log probabilities
        ("gpt-5.6-luna", None, False),
        ("gpt-5.4-mini", "none", True),
        ("gpt-4o", None, True),
        ("gpt-4o-mini", "high", True),
        ("llama3", None, True),
    ],
)
def test_logprobs_are_requested_only_where_the_model_takes_them(model, effort, sent):
    got = rules.resolve_params(model, effort, None, True)
    assert got.logprobs is sent
    assert (got.logprobs_note is None) is sent
    assert [x for x in got.adjustments if "log probabilities" in x] == ([] if sent else [got.logprobs_note])
    if not sent:
        assert "accepts log probabilities only when the reasoning level is None" in got.logprobs_note


def test_logprobs_are_off_unless_asked_for():
    got = rules.resolve_params("gpt-4o", None, None)
    assert got.logprobs is False and got.logprobs_note is None and got.adjustments == []
    assert rules.resolve_params("gpt-6.1-terra", "high", None, False).logprobs_note is None  # nothing to explain


def test_a_rule_can_set_its_own_logprobs_mode(monkeypatch):
    monkeypatch.setitem(rules.MODEL_RULES, "gpt-6-luna", {**rules.MODEL_RULES["gpt-6-luna"], "logprobs": "never"})
    got = rules.resolve_params("gpt-6-luna", "none", None, True)
    assert got.logprobs is False and "does not return log probabilities" in got.logprobs_note
    assert rules.resolve_params("gpt-6-luna", "none", 0).temperature == 0  # the temperature rule is untouched


async def test_the_request_carries_logprobs_true_only_when_the_rules_allow(monkeypatch):
    bodies = []

    def handler(request):
        bodies.append(json.loads(request.content))
        return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})

    with_transport(monkeypatch, handler)
    with llm_service.collect_calls() as calls:
        await real_complete(
            base_url="https://api.openai.com/v1",
            api_key="k",
            model="gpt-4o",
            system="s",
            messages=[],
            timeout=5,
            logprobs=True,
        )
        await real_complete(
            base_url="https://api.openai.com/v1",
            api_key="k",
            model="gpt-6.1-terra",
            system="s",
            messages=[],
            timeout=5,
            logprobs=True,
        )
        await real_complete(
            base_url="https://api.openai.com/v1",
            api_key="k",
            model="gpt-6.1-terra",
            system="s",
            messages=[],
            timeout=5,
            reasoning_effort="none",
            logprobs=True,
        )
        await real_complete(
            base_url="https://api.openai.com/v1", api_key="k", model="gpt-4o", system="s", messages=[], timeout=5
        )
    assert [b.get("logprobs") for b in bodies] == [True, None, True, None]
    gpt4, blocked, allowed, off = (c["settings"] for c in calls)
    assert gpt4["logprobs"] is True and gpt4["logprobs_sent"] is True and gpt4["logprobs_note"] is None
    assert blocked["logprobs"] is True and blocked["logprobs_sent"] is False
    assert "only when the reasoning level is None" in blocked["logprobs_note"]
    assert allowed["logprobs_sent"] is True and off["logprobs"] is False and off["logprobs_sent"] is False


async def test_a_refusal_of_logprobs_is_retried_without_them_and_remembered(monkeypatch):
    def handler(request):
        body = json.loads(request.content)
        if "logprobs" in body:
            return httpx.Response(400, json={"error": {"message": "logprobs is not supported with this model."}})
        return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})

    with_transport(monkeypatch, handler)
    llm_service._NO_LOGPROBS.clear()
    try:
        with llm_service.collect_calls() as first:
            await real_complete(
                base_url="https://x.test/v1",
                api_key="k",
                model="brand-new",
                system="s",
                messages=[],
                timeout=5,
                logprobs=True,
            )
        assert [c["response"]["status"] for c in first] == [400, 200]
        assert first[0]["settings"]["logprobs_sent"] is True and first[1]["settings"]["logprobs_sent"] is False
        assert "refused log probabilities (HTTP 400)" in first[1]["settings"]["logprobs_note"]
        with llm_service.collect_calls() as later:
            await real_complete(
                base_url="https://x.test/v1",
                api_key="k",
                model="brand-new",
                system="s",
                messages=[],
                timeout=5,
                logprobs=True,
            )
        assert len(later) == 1 and "refused log probabilities earlier" in later[0]["settings"]["logprobs_note"]
    finally:
        llm_service._NO_LOGPROBS.clear()


async def test_a_refusal_naming_both_drops_both(monkeypatch):
    def handler(request):
        body = json.loads(request.content)
        if "logprobs" in body or "temperature" in body:
            return httpx.Response(400, json={"error": {"message": "temperature and logprobs are not supported."}})
        return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})

    with_transport(monkeypatch, handler)
    llm_service._NO_LOGPROBS.clear()
    try:
        with llm_service.collect_calls() as calls:
            await real_complete(
                base_url="https://y.test/v1",
                api_key="k",
                model="odd",
                system="s",
                messages=[],
                timeout=5,
                temperature=0,
                logprobs=True,
            )
        assert [c["response"]["status"] for c in calls] == [400, 200]
        assert "temperature" not in calls[1]["request"]["body"] and "logprobs" not in calls[1]["request"]["body"]
    finally:
        llm_service._NO_LOGPROBS.clear()
