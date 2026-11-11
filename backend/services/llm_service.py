"""Calls an OpenAI-compatible /chat/completions endpoint with plain httpx (no agent framework).

`complete` is the single seam the rest of the app (and the tests) use. Call it as
`llm_service.complete(...)`, never `from ... import complete`, so tests can stub it.
"""

import ipaddress
import json
import socket
import time
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import UTC, datetime
from urllib.parse import urlsplit, urlunsplit

import httpx

from errors import AppError
from services.OpenAI_API_Model_rules import ResolvedParams, resolve_params


class LLMError(AppError):
    """A failure talking to the model provider. User-facing messages mirror the old browser client."""


def normalize_url(raw_url: str) -> str:
    """Accept a base URL (ending /v1) or a full /chat/completions URL; return the full endpoint."""
    try:
        parts = urlsplit(raw_url.strip())
    except ValueError as exc:
        raise LLMError(422, "invalid_api_url", "Add a valid API URL in Account.") from exc
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise LLMError(422, "invalid_api_url", "Use an HTTP or HTTPS API URL.")
    path = parts.path.rstrip("/")
    if not path.endswith("/chat/completions"):
        path += "/chat/completions"
    return urlunsplit((parts.scheme, parts.netloc, path, parts.query, ""))


def check_host_allowed(url: str) -> None:
    """SSRF guard (enabled by BLOCK_PRIVATE_LLM_URLS): refuse hosts that resolve to non-public addresses."""
    host = urlsplit(url).hostname or ""
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as exc:
        raise LLMError(
            502, "llm_unreachable", "Could not reach your API. Check the URL and that the server is running."
        ) from exc
    for info in infos:
        address = ipaddress.ip_address(info[4][0].split("%")[0])
        if not address.is_global:
            raise LLMError(
                422,
                "api_url_not_allowed",
                "That API URL points to a private or local address, which this server does not allow.",
            )


def is_local_url(url: str) -> bool:
    """Whether a URL names a machine of the user's own: localhost, a *.local name, or a private/loopback/link-local IP
    address written out in it (no DNS lookup). An API there is usually run by the user (Ollama, LM Studio, vLLM) and needs
    no key; a hosted API always does."""
    host = (urlsplit(url).hostname or "").lower()
    if host == "localhost" or host.endswith((".localhost", ".local")):
        return True
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return False
    return not address.is_global


def _provider_reason(response: httpx.Response) -> str | None:
    """The provider's own explanation of a 400 (OpenAI-style {"error": {"message": ...}}), shortened."""
    try:
        message = response.json()["error"]["message"]
    except ValueError, KeyError, TypeError:
        return None
    return " ".join(message.split())[:300] if isinstance(message, str) and message.strip() else None


MAX_LOGGED_TOKENS = 20_000
"""Token log probabilities kept per call (a very long answer keeps its first tokens)."""
MAX_LOGGED_BODY = 200_000
"""A response body longer than this is cut when it is kept in an API log (and flagged as cut)."""
_CALLS: ContextVar[list | None] = ContextVar("llm_calls", default=None)


@contextmanager
def collect_calls():
    """Everything sent to the provider inside this block is kept, in order, as raw REST calls (see `record_call`). The
    list is filled while the block runs. Each asyncio task has its own, so two slots running together stay apart."""
    calls: list[dict] = []
    token = _CALLS.set(calls)
    try:
        yield calls
    finally:
        _CALLS.reset(token)


def record_call(entry: dict) -> None:
    """Keep one REST call, if a `collect_calls` block is open. The API key must never be in `entry`."""
    calls = _CALLS.get()
    if calls is not None:
        calls.append(entry)


def _logged_headers(has_key: bool = True) -> dict[str, str]:
    """The headers as they are kept in an API log: the key is a placeholder, and absent when the API has none."""
    headers = {"Authorization": "Bearer <redacted>"} if has_key else {}
    return {**headers, "Content-Type": "application/json"}


def token_logprobs(body: str) -> list[dict] | None:
    """The chosen token and its log probability for each token of the answer, from a chat completion's
    `choices[0].logprobs.content`; None when the response has none (not asked for, or not JSON)."""
    try:
        content = json.loads(body)["choices"][0]["logprobs"]["content"]
    except KeyError, IndexError, TypeError, ValueError:
        return None
    if not isinstance(content, list):
        return None
    tokens = [
        {"token": t["token"], "logprob": t["logprob"]}
        for t in content
        if isinstance(t, dict) and isinstance(t.get("token"), str) and isinstance(t.get("logprob"), int | float)
    ]
    return tokens[:MAX_LOGGED_TOKENS] or None


_NO_TEMPERATURE: set[tuple[str, str]] = set()
_NO_LOGPROBS: set[tuple[str, str]] = set()
"""(endpoint, model) pairs that answered 400 about `temperature`: later calls leave it out instead of failing first."""


async def _post(
    url: str,
    payload: dict,
    api_key: str,
    timeout: float,
    purpose: str = "answer",
    temperature: float | None = None,
    temperature_note: str | None = None,
    resolved: ResolvedParams | None = None,
    logprobs: bool = False,
    logprobs_note: str | None = None,
) -> httpx.Response:
    entry = {
        "at": datetime.now(UTC).isoformat(),
        "purpose": purpose,
        "method": "POST",
        "url": url,
        "request": {"headers": _logged_headers(bool(api_key)), "body": json.loads(json.dumps(payload))},
        "settings": {
            # what the user set, and whether this request carried it (the body above is exactly what was sent)
            "temperature": temperature,
            "temperature_sent": "temperature" in payload,
            "temperature_note": temperature_note,
            "logprobs": logprobs,  # log probabilities asked for
            "logprobs_sent": "logprobs" in payload,
            "logprobs_note": logprobs_note,
            "reasoning_effort": payload.get("reasoning_effort"),
            "rule": resolved.rule if resolved else None,  # which model rule shaped the request
            "adjustments": list(resolved.adjustments) if resolved else [],
        },
        "response": None,
        "error": None,
        "duration_ms": 0,
    }
    started = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
            response = await client.post(
                url,
                json=payload,
                headers={
                    **({"Authorization": f"Bearer {api_key}"} if api_key else {}),
                    "Content-Type": "application/json",
                },
            )
    except httpx.TimeoutException as exc:
        entry["error"] = "The API did not respond in time."
        raise LLMError(504, "llm_timeout", "Your API did not respond in time.") from exc
    except httpx.HTTPError as exc:
        entry["error"] = "Could not reach the API."
        raise LLMError(
            502, "llm_unreachable", "Could not reach your API. Check the URL and that the server is running."
        ) from exc
    else:
        body = response.text
        entry["response"] = {
            "status": response.status_code,
            "body": body[:MAX_LOGGED_BODY],
            "truncated": len(body) > MAX_LOGGED_BODY,
        }
        if payload.get("logprobs") and response.status_code == 200:
            entry["logprobs"] = token_logprobs(body)  # from the whole body, before the log cuts it
        return response
    finally:
        entry["duration_ms"] = round((time.monotonic() - started) * 1000)
        record_call(entry)


async def complete(
    *,
    base_url: str,
    api_key: str,
    model: str,
    system: str,
    messages: list[dict],
    timeout: float,
    block_private: bool = False,
    reasoning_effort: str | None = None,
    temperature: float | None = None,
    logprobs: bool = False,
    purpose: str = "answer",
) -> str:
    """Return the assistant's text for `messages` (list of {role, content}) preceded by `system`.

    `reasoning_effort` is OpenAI's field of that name (none, minimal, low, medium, high, xhigh). None leaves it out, so
    the model's own default applies. It is never dropped silently: a model that rejects the value answers 400, and the
    provider's reason is shown to the user.

    `temperature` (0 to 2) is sent when given. OpenAI removes it for a reasoning model unless reasoning effort is none, and
    answers 400 naming the parameter; the call is then repeated once without it, and that model is remembered so later
    calls do not repeat the failed attempt. Any other 400 is reported as usual.

    `logprobs` asks for log probabilities in the response (`logprobs: true`). It is subject to the same rule and the same
    refusal handling as the temperature; the probabilities come back in the raw response, which an API log keeps.

    `purpose` only labels the call in an API log (answer, kb_summary, compact_summary, kb_route:category, ...)."""
    url = normalize_url(base_url)
    if block_private:
        check_host_allowed(url)
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            *({"role": m["role"], "content": m["content"]} for m in messages),
        ],
        "stream": False,
    }
    resolved = resolve_params(model, reasoning_effort, temperature, logprobs)  # what this model accepts
    if resolved.reasoning_effort:
        payload["reasoning_effort"] = resolved.reasoning_effort
    key = (url, model)
    note = resolved.temperature_note
    if resolved.temperature is not None and key not in _NO_TEMPERATURE:
        payload["temperature"] = resolved.temperature
    elif resolved.temperature is not None:
        note = "This model refused a temperature earlier, so it is left out."
        resolved.adjustments.append(note)
    lp_note = resolved.logprobs_note
    if resolved.logprobs and key not in _NO_LOGPROBS:
        payload["logprobs"] = True
    elif resolved.logprobs:
        lp_note = "This model refused log probabilities earlier, so they are left out."
        resolved.adjustments.append(lp_note)

    def post() -> object:
        return _post(url, payload, api_key, timeout, purpose, temperature, note, resolved, logprobs, lp_note)

    response = await post()
    reason = (_provider_reason(response) or "").lower() if response.status_code == 400 else ""
    refused = [name for name in ("temperature", "logprobs") if name in payload and name in reason]
    if refused:  # this model does not take it: ask again without it, and remember
        for name in refused:
            (_NO_TEMPERATURE if name == "temperature" else _NO_LOGPROBS).add(key)
            del payload[name]
        if "temperature" in refused:
            note = "The model refused the temperature (HTTP 400), so this call repeats the request without it."
            resolved.adjustments.append(note)
        if "logprobs" in refused:
            lp_note = "The model refused log probabilities (HTTP 400), so this call repeats the request without them."
            resolved.adjustments.append(lp_note)
        response = await post()
    if response.status_code >= 400:
        reason = _provider_reason(response) if response.status_code == 400 else None
        raise LLMError(
            502,
            "llm_http_error",
            f"API returned HTTP {response.status_code}"
            + (f": {reason}" if reason else ". Check your key, model ID, and endpoint in Account."),
        )
    try:
        data = response.json()
    except ValueError as exc:
        raise LLMError(502, "llm_invalid_response", "The API returned an invalid JSON response.") from exc
    try:
        content = data["choices"][0]["message"]["content"]
    except KeyError, IndexError, TypeError:
        content = None
    if not isinstance(content, str) or not content.strip():
        raise LLMError(
            502,
            "llm_empty_response",
            "No assistant response found. Use an OpenAI-compatible chat completions endpoint.",
        )
    return content
