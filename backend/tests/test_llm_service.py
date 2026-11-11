import json

import httpx
import pytest

from services import llm_service

real_complete = llm_service.complete  # captured at import, before the autouse stub replaces it
REAL_ASYNC_CLIENT = httpx.AsyncClient


def with_transport(monkeypatch, handler):
    monkeypatch.setattr(
        "services.llm_service.httpx.AsyncClient",
        lambda *args, **kwargs: REAL_ASYNC_CLIENT(*args, transport=httpx.MockTransport(handler), **kwargs),
    )


async def call(**overrides):
    kwargs = {
        "base_url": "https://api.example.com/v1",
        "api_key": "sk-secret",
        "model": "m1",
        "system": "be nice",
        "messages": [{"role": "user", "content": "hi", "extra": "dropped"}],
        "timeout": 5,
    }
    return await real_complete(**{**kwargs, **overrides})


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("https://api.example.com/v1", "https://api.example.com/v1/chat/completions"),
        ("https://api.example.com/v1/", "https://api.example.com/v1/chat/completions"),
        ("https://api.example.com/v1/chat/completions#x", "https://api.example.com/v1/chat/completions"),
        ("http://localhost:11434", "http://localhost:11434/chat/completions"),
    ],
)
def test_normalize_url(raw, expected):
    assert llm_service.normalize_url(raw) == expected


@pytest.mark.parametrize("raw", ["ftp://x.test", "nonsense", "https://"])
def test_normalize_url_rejects_bad_urls(raw):
    with pytest.raises(llm_service.LLMError):
        llm_service.normalize_url(raw)


async def test_posts_an_openai_compatible_request(monkeypatch):
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        seen["auth"] = request.headers["authorization"]
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"choices": [{"message": {"content": "hello"}}]})

    with_transport(monkeypatch, handler)
    assert await call() == "hello"
    assert seen["url"] == "https://api.example.com/v1/chat/completions"
    assert seen["auth"] == "Bearer sk-secret"
    assert seen["body"] == {
        "model": "m1",
        "messages": [{"role": "system", "content": "be nice"}, {"role": "user", "content": "hi"}],
        "stream": False,
    }


@pytest.mark.parametrize(
    ("response", "code", "text"),
    [
        (httpx.Response(401), "llm_http_error", "API returned HTTP 401"),
        (httpx.Response(200, content=b"not json"), "llm_invalid_response", "invalid JSON"),
        (httpx.Response(200, json={"choices": []}), "llm_empty_response", "No assistant response"),
        (httpx.Response(200, json={"choices": [{"message": {"content": "  "}}]}), "llm_empty_response", "No assistant"),
    ],
)
async def test_error_mapping(monkeypatch, response, code, text):
    with_transport(monkeypatch, lambda request: response)
    with pytest.raises(llm_service.LLMError) as caught:
        await call()
    assert caught.value.code == code and text in caught.value.message and caught.value.status_code == 502


async def test_connection_and_timeout_errors(monkeypatch):
    def refuse(request):
        raise httpx.ConnectError("boom")

    with_transport(monkeypatch, refuse)
    with pytest.raises(llm_service.LLMError) as caught:
        await call()
    assert caught.value.code == "llm_unreachable"

    def slow(request):
        raise httpx.ReadTimeout("slow")

    with_transport(monkeypatch, slow)
    with pytest.raises(llm_service.LLMError) as caught:
        await call()
    assert caught.value.code == "llm_timeout" and caught.value.status_code == 504


async def test_the_key_never_appears_in_error_messages(monkeypatch):
    with_transport(monkeypatch, lambda request: httpx.Response(500, text="sk-secret leaked by provider"))
    with pytest.raises(llm_service.LLMError) as caught:
        await call()
    assert "sk-secret" not in caught.value.message


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1:8000/v1",
        "http://localhost/v1",
        "http://10.0.0.5/v1",
        "http://169.254.169.254/latest",
        "http://[::1]/v1",
    ],
)
def test_ssrf_guard_blocks_private_and_local_addresses(url):
    with pytest.raises(llm_service.LLMError) as caught:
        llm_service.check_host_allowed(url)
    assert caught.value.code == "api_url_not_allowed"


def test_ssrf_guard_allows_public_addresses():
    llm_service.check_host_allowed("https://8.8.8.8/v1")


async def test_block_private_is_enforced_on_calls(monkeypatch):
    with_transport(monkeypatch, lambda request: httpx.Response(200, json={}))
    with pytest.raises(llm_service.LLMError) as caught:
        await call(base_url="http://127.0.0.1:9/v1", block_private=True)
    assert caught.value.code == "api_url_not_allowed"


def test_settings_save_enforces_the_ssrf_guard_when_enabled(logged_in_client, test_settings, monkeypatch):
    monkeypatch.setattr(test_settings, "BLOCK_PRIVATE_LLM_URLS", True)
    response = logged_in_client.post(
        "/api/connections", json={"label": "Local", "url": "http://127.0.0.1:9/v1", "api_key": "k", "models": ["m"]}
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "api_url_not_allowed"


async def test_reasoning_effort_is_sent_only_when_asked_for(monkeypatch):
    bodies = []

    def handler(request):
        bodies.append(json.loads(request.content))
        return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})

    with_transport(monkeypatch, handler)
    await call(reasoning_effort="xhigh")
    await call(reasoning_effort="none")
    await call()
    await call(reasoning_effort=None)
    assert [b.get("reasoning_effort") for b in bodies] == ["xhigh", "none", None, None]
    assert "reasoning_effort" not in bodies[2]


async def test_a_400_shows_the_providers_own_reason_and_is_never_retried_without_the_field(monkeypatch):
    requests = []

    def handler(request):
        requests.append(json.loads(request.content))
        message = "Unsupported value: 'xhigh' is not supported with this model.\n  Supported values are: 'low', 'high'."
        return httpx.Response(400, json={"error": {"message": message, "type": "invalid_request_error"}})

    with_transport(monkeypatch, handler)
    with pytest.raises(llm_service.LLMError) as caught:
        await call(reasoning_effort="xhigh")
    assert caught.value.code == "llm_http_error"
    assert (
        "HTTP 400: Unsupported value: 'xhigh' is not supported with this model. Supported values are"
        in caught.value.message
    )
    assert len(requests) == 1  # the setting is never silently dropped


async def test_a_400_without_a_readable_reason_keeps_the_generic_message(monkeypatch):
    with_transport(monkeypatch, lambda request: httpx.Response(400, text="<html>bad request</html>"))
    with pytest.raises(llm_service.LLMError) as caught:
        await call()
    assert caught.value.message.startswith("API returned HTTP 400. Check your key")


# ---- temperature
@pytest.fixture(autouse=True)
def forget_temperature_refusals():
    llm_service._NO_TEMPERATURE.clear()
    yield
    llm_service._NO_TEMPERATURE.clear()


def ok():
    return httpx.Response(200, json={"choices": [{"message": {"content": "hello"}}]})


def temperature_refusal():
    return httpx.Response(
        400, json={"error": {"message": "Unsupported value: 'temperature' does not support 0 with this model."}}
    )


async def test_temperature_is_sent_when_given_including_zero(monkeypatch):
    bodies = []

    def handler(request):
        bodies.append(json.loads(request.content))
        return ok()

    with_transport(monkeypatch, handler)
    await call(temperature=0)
    await call(temperature=1.5)
    await call(temperature=None)
    assert [b.get("temperature") for b in bodies] == [0, 1.5, None]
    assert "temperature" not in bodies[2]


async def test_a_model_that_refuses_temperature_is_asked_again_without_it_and_remembered(monkeypatch):
    bodies = []

    def handler(request):
        body = json.loads(request.content)
        bodies.append(body)
        return temperature_refusal() if "temperature" in body else ok()

    with_transport(monkeypatch, handler)
    assert await call(temperature=0) == "hello"
    assert ["temperature" in b for b in bodies] == [True, False]  # tried, refused, repeated without it
    assert await call(temperature=0) == "hello"
    assert ["temperature" in b for b in bodies] == [True, False, False]  # remembered: no failed attempt this time
    await call(model="another-model", temperature=0)
    assert "temperature" in bodies[3]  # only that model is remembered


async def test_other_400s_are_not_swallowed_by_the_temperature_retry(monkeypatch):
    calls = []

    def handler(request):
        calls.append(1)
        return httpx.Response(400, json={"error": {"message": "Unknown model: m1."}})

    with_transport(monkeypatch, handler)
    with pytest.raises(llm_service.LLMError, match="Unknown model: m1"):
        await call(temperature=0)
    assert len(calls) == 1 and not llm_service._NO_TEMPERATURE


async def test_a_second_refusal_is_reported(monkeypatch):
    with_transport(monkeypatch, lambda request: httpx.Response(400, json={"error": {"message": "temperature is bad"}}))
    with pytest.raises(llm_service.LLMError, match="temperature is bad"):
        await call()  # no temperature sent: nothing to retry without


# ---- the raw REST call log
async def test_a_collect_block_keeps_each_call_with_url_request_and_response_but_never_the_key(monkeypatch):
    with_transport(monkeypatch, lambda request: ok())
    with llm_service.collect_calls() as calls:
        await call(temperature=0, reasoning_effort="low", purpose="kb_route:category")
    assert len(calls) == 1
    entry = calls[0]
    assert entry["method"] == "POST" and entry["url"] == "https://api.example.com/v1/chat/completions"
    assert entry["purpose"] == "kb_route:category"
    assert entry["request"]["body"]["temperature"] == 0 and entry["request"]["body"]["reasoning_effort"] == "low"
    assert entry["request"]["headers"]["Authorization"] == "Bearer <redacted>"
    assert "sk-secret" not in json.dumps(entry)
    assert (
        entry["response"]["status"] == 200
        and "hello" in entry["response"]["body"]
        and entry["response"]["truncated"] is False
    )
    assert isinstance(entry["duration_ms"], int) and entry["error"] is None


async def test_nothing_is_kept_outside_a_collect_block(monkeypatch):
    with_transport(monkeypatch, lambda request: ok())
    await call()
    with llm_service.collect_calls() as calls:
        pass
    assert calls == []


async def test_the_temperature_retry_shows_both_calls(monkeypatch):
    def handler(request):
        return temperature_refusal() if "temperature" in json.loads(request.content) else ok()

    with_transport(monkeypatch, handler)
    with llm_service.collect_calls() as calls:
        await call(temperature=0)
    assert [c["response"]["status"] for c in calls] == [400, 200]
    assert "temperature" in calls[0]["request"]["body"] and "temperature" not in calls[1]["request"]["body"]


async def test_a_failed_call_is_kept_with_its_error_or_status(monkeypatch):
    def refuse(request):
        return httpx.Response(401, json={"error": {"message": "bad key"}})

    with_transport(monkeypatch, refuse)
    with llm_service.collect_calls() as calls:
        with pytest.raises(llm_service.LLMError):
            await call()
    assert calls[0]["response"]["status"] == 401 and calls[0]["error"] is None

    def time_out(request):
        raise httpx.ReadTimeout("slow", request=request)

    with_transport(monkeypatch, time_out)
    with llm_service.collect_calls() as calls:
        with pytest.raises(llm_service.LLMError):
            await call()
    assert calls[0]["response"] is None and calls[0]["error"] == "The API did not respond in time."


async def test_a_very_long_response_is_cut_in_the_log_and_flagged(monkeypatch):
    big = "x" * (llm_service.MAX_LOGGED_BODY + 10)
    with_transport(monkeypatch, lambda request: httpx.Response(200, json={"choices": [{"message": {"content": big}}]}))
    with llm_service.collect_calls() as calls:
        assert await call() == big  # the answer itself is whole
    assert (
        calls[0]["response"]["truncated"] is True and len(calls[0]["response"]["body"]) == llm_service.MAX_LOGGED_BODY
    )


# ---- the log says what was set and what was sent
async def test_each_logged_call_says_what_temperature_and_reasoning_it_carried(monkeypatch):
    with_transport(monkeypatch, lambda request: ok())
    with llm_service.collect_calls() as calls:
        await call(temperature=0, reasoning_effort="high")
        await call()  # no settings given: a call that uses neither
    sent, bare = (c["settings"] for c in calls)
    base = {  # "m1" has no model rule: sent as chosen
        "temperature_note": None, "rule": "unknown", "adjustments": [],
        "logprobs": False, "logprobs_sent": False, "logprobs_note": None,
    }  # fmt: skip
    assert sent == {"temperature": 0, "temperature_sent": True, "reasoning_effort": "high", **base}
    assert bare == {"temperature": None, "temperature_sent": False, "reasoning_effort": None, **base}


async def test_a_refused_temperature_is_explained_on_the_retry_and_on_later_calls(monkeypatch):
    def handler(request):
        return temperature_refusal() if "temperature" in json.loads(request.content) else ok()

    with_transport(monkeypatch, handler)
    with llm_service.collect_calls() as first:
        await call(temperature=0)
    asked, repeated = (c["settings"] for c in first)
    assert asked["temperature"] == 0 and asked["temperature_sent"] is True
    assert repeated["temperature"] == 0 and repeated["temperature_sent"] is False
    assert "refused the temperature (HTTP 400)" in repeated["temperature_note"]
    with llm_service.collect_calls() as later:
        await call(temperature=0)
    (only,) = (c["settings"] for c in later)
    assert only["temperature"] == 0 and only["temperature_sent"] is False
    assert "refused a temperature earlier" in only["temperature_note"]


# ---- token log probabilities, kept compactly
def lp_body(tokens, **extra):
    return json.dumps(
        {
            "choices": [
                {
                    "message": {"content": "".join(t[0] for t in tokens)},
                    "logprobs": {
                        "content": [{"token": t[0], "logprob": t[1], "bytes": [1], "top_logprobs": []} for t in tokens]
                    },
                }
            ],
            **extra,
        }
    )


def test_token_logprobs_keeps_each_token_and_its_log_probability_only():
    got = llm_service.token_logprobs(lp_body([("Hel", -0.1), ("lo", -2.5)]))
    assert got == [{"token": "Hel", "logprob": -0.1}, {"token": "lo", "logprob": -2.5}]


@pytest.mark.parametrize(
    "body",
    ["not json", "{}", '{"choices": []}', '{"choices": [{"logprobs": null}]}', '{"choices": [{"logprobs": {"content": "x"}}]}',
     '{"choices": [{"logprobs": {"content": []}}]}', '{"choices": [{"logprobs": {"content": [{"token": 1, "logprob": 2}]}}]}'],
)  # fmt: skip
def test_token_logprobs_is_none_when_the_response_has_none(body):
    assert llm_service.token_logprobs(body) is None


def test_token_logprobs_skips_malformed_entries_and_caps_the_count(monkeypatch):
    body = json.dumps(
        {
            "choices": [
                {
                    "logprobs": {
                        "content": [{"token": "a", "logprob": -1}, {"token": "b"}, "junk", {"token": "c", "logprob": 0}]
                    }
                }
            ]
        }
    )
    assert llm_service.token_logprobs(body) == [{"token": "a", "logprob": -1}, {"token": "c", "logprob": 0}]
    monkeypatch.setattr(llm_service, "MAX_LOGGED_TOKENS", 2)
    assert len(llm_service.token_logprobs(lp_body([("a", -1), ("b", -1), ("c", -1)]))) == 2


async def test_a_call_that_asked_for_logprobs_keeps_the_tokens_even_when_the_log_cuts_the_body(monkeypatch):
    tokens = [("w", -0.5)] * 3000
    with_transport(monkeypatch, lambda request: httpx.Response(200, text=lp_body(tokens)))
    monkeypatch.setattr(llm_service, "MAX_LOGGED_BODY", 100)
    with llm_service.collect_calls() as calls:
        await call(model="gpt-4o", logprobs=True)
    entry = calls[0]
    assert entry["response"]["truncated"] is True  # the raw body was cut...
    assert len(entry["logprobs"]) == 3000  # ...but the tokens come from the whole body


async def test_a_call_that_did_not_ask_keeps_no_tokens(monkeypatch):
    with_transport(monkeypatch, lambda request: httpx.Response(200, text=lp_body([("a", -1)])))
    with llm_service.collect_calls() as calls:
        await call(model="gpt-4o")
    assert "logprobs" not in calls[0]


# ---- an API with no key (a local one)
def test_is_local_url_reads_the_address_without_a_lookup():
    for url in (
        "http://localhost:11434/v1",
        "http://127.0.0.1/v1",
        "http://[::1]/v1",
        "http://192.168.0.2/v1",
        "http://box.local/v1",
        "http://a.localhost/v1",
    ):
        assert llm_service.is_local_url(url), url
    for url in (
        "https://api.openai.com/v1",
        "https://8.8.8.8/v1",
        "http://localhost.example.com/v1",
        "http://myserver/v1",
        "nonsense",
        "",
    ):
        assert not llm_service.is_local_url(url), url


async def test_no_authorization_header_is_sent_without_a_key_and_the_log_says_so(monkeypatch):
    seen = {}

    def handler(request):
        seen["headers"] = dict(request.headers)
        return ok()

    with_transport(monkeypatch, handler)
    with llm_service.collect_calls() as calls:
        await call(api_key="", base_url="http://localhost:11434/v1")
    assert "authorization" not in seen["headers"] and seen["headers"]["content-type"] == "application/json"
    assert calls[0]["request"]["headers"] == {"Content-Type": "application/json"}


async def test_a_key_is_still_sent_as_a_bearer_token_and_logged_as_a_placeholder(monkeypatch):
    seen = {}

    def handler(request):
        seen["auth"] = request.headers["authorization"]
        return ok()

    with_transport(monkeypatch, handler)
    with llm_service.collect_calls() as calls:
        await call(api_key="sk-real")
    assert seen["auth"] == "Bearer sk-real"
    assert calls[0]["request"]["headers"]["Authorization"] == "Bearer <redacted>" and "sk-real" not in json.dumps(
        calls[0]
    )
