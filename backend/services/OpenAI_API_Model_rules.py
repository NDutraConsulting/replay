"""What each OpenAI model accepts in a Chat Completions request, as plain dictionaries.

Every model call goes through `resolve_params` (see `llm_service.complete`) so the request has the structure the model
expects BEFORE it is sent, instead of being sent and refused. It answers two questions for a model:

  * Which `reasoning_effort` may be sent? (A level the model does not support is refused up front, with a clear message.)
  * May `temperature` be sent with this reasoning effort? (A reasoning model takes it only when the effort is "none".)
  * May `logprobs` be requested? (Same rule as the temperature.)

A setting that cannot go out is left out and the reason is returned in `adjustments`, which the API log shows next to
the request. Nothing is dropped silently.

HOW TO CHANGE IT: edit `MODEL_RULES` (one entry per exact model id), `FAMILY_RULES` (a model id prefix, first match
wins) or `UNKNOWN_MODEL_RULE` (anything else: a compatible API, a new model). Each rule has these keys:

  reasoning_model          True for a model that reasons (it takes `reasoning_effort`)
  reasoning_efforts        the `reasoning_effort` values it accepts. () for a model that takes none
  strict_efforts           True: a level outside `reasoning_efforts` is refused before the call.
                           False: it is sent and the provider decides (used where the docs do not list the levels)
  default_effort           the effort the model runs at when none is sent (None when it has no reasoning)
  temperature              "always" | "only_with_effort_none" | "never"
  temperature_range        (lowest, highest) temperature accepted
  logprobs                 (optional) same three values, for `logprobs`. Without it, logprobs follows `temperature`:
                           the GPT-6 guide removes both (and top_p, top_logprobs) unless the effort is none
  status                   "active" | "deprecated" | "assumed" (not stated by the docs for this exact model)
  source                   where the rule comes from

The rules come from OpenAI's documentation as of November 2026 (see each `source`). The docs name models differently on
different pages, so check a model against the live `GET /v1/models` before relying on an entry, and correct it here.
"""

from dataclasses import dataclass, field

from errors import AppError

# Every value the Chat Completions reference lists for `reasoning_effort` (not every model takes every one).
ALL_EFFORTS = ("none", "minimal", "low", "medium", "high", "xhigh", "max")

_GPT6_GUIDE = "OpenAI 'Using GPT-6' guide + models page: levels per model; temperature removed unless effort is none"
_REASONING_NO_TEMPERATURE = "only_with_effort_none"
_TEMPERATURE_RANGE = (0.0, 2.0)  # Chat Completions reference: temperature is between 0 and 2

# ---- one entry per exact model id --------------------------------------------------------------------------------------
MODEL_RULES: dict[str, dict] = {
    # GPT-6: Astra and 6.1 Sol do not accept "none" (the guide says it returns HTTP 400); Terra and Luna do.
    "gpt-6-astra": {
        "reasoning_model": True,
        "reasoning_efforts": ("low", "medium", "high", "xhigh", "max"),
        "strict_efforts": True,
        "default_effort": "medium",
        "temperature": _REASONING_NO_TEMPERATURE,
        "temperature_range": _TEMPERATURE_RANGE,
        "status": "active",
        "source": _GPT6_GUIDE,
    },
    "gpt-6.1-sol": {
        "reasoning_model": True,
        "reasoning_efforts": ("low", "medium", "high", "xhigh", "max"),
        "strict_efforts": True,
        "default_effort": "medium",
        "temperature": _REASONING_NO_TEMPERATURE,
        "temperature_range": _TEMPERATURE_RANGE,
        "status": "active",
        "source": _GPT6_GUIDE,
    },
    "gpt-6.1-terra": {
        "reasoning_model": True,
        "reasoning_efforts": ("none", "low", "medium", "high", "xhigh", "max"),
        "strict_efforts": True,
        "default_effort": "medium",
        "temperature": _REASONING_NO_TEMPERATURE,
        "temperature_range": _TEMPERATURE_RANGE,
        "status": "active",
        "source": _GPT6_GUIDE,
    },
    "gpt-6-luna": {
        "reasoning_model": True,
        "reasoning_efforts": ("none", "low", "medium", "high", "xhigh", "max"),
        "strict_efforts": True,
        "default_effort": "medium",
        "temperature": _REASONING_NO_TEMPERATURE,
        "temperature_range": _TEMPERATURE_RANGE,
        "status": "active",
        "source": _GPT6_GUIDE,
    },
    # GPT-6 Sol: the guide says it accepts "none"; the other levels are not listed for it, so they are not enforced.
    "gpt-6-sol": {
        "reasoning_model": True,
        "reasoning_efforts": ("none", "low", "medium", "high", "xhigh", "max"),
        "strict_efforts": False,
        "default_effort": "medium",
        "temperature": _REASONING_NO_TEMPERATURE,
        "temperature_range": _TEMPERATURE_RANGE,
        "status": "assumed",
        "source": "'Using GPT-6' guide lists none as supported; other levels not stated",
    },
    # GPT-5.6: one OpenAI guide lists none, low, medium, high, xhigh and max (no minimal).
    "gpt-5.6-sol": {
        "reasoning_model": True,
        "reasoning_efforts": ("none", "low", "medium", "high", "xhigh", "max"),
        "strict_efforts": True,
        "default_effort": "medium",
        "temperature": _REASONING_NO_TEMPERATURE,
        "temperature_range": _TEMPERATURE_RANGE,
        "status": "assumed",
        "source": "OpenAI GPT-5.6 guide (levels); temperature rule taken from the GPT-6 guidance",
    },
    "gpt-5.6-terra": {
        "reasoning_model": True,
        "reasoning_efforts": ("none", "low", "medium", "high", "xhigh", "max"),
        "strict_efforts": True,
        "default_effort": "medium",
        "temperature": _REASONING_NO_TEMPERATURE,
        "temperature_range": _TEMPERATURE_RANGE,
        "status": "assumed",
        "source": "OpenAI GPT-5.6 guide (levels); temperature rule taken from the GPT-6 guidance",
    },
    "gpt-5.6-luna": {
        "reasoning_model": True,
        "reasoning_efforts": ("none", "low", "medium", "high", "xhigh", "max"),
        "strict_efforts": True,
        "default_effort": "medium",
        "temperature": _REASONING_NO_TEMPERATURE,
        "temperature_range": _TEMPERATURE_RANGE,
        "status": "assumed",
        "source": "OpenAI GPT-5.6 guide (levels); temperature rule taken from the GPT-6 guidance",
    },
}

# ---- by model id prefix (first match wins) -------------------------------------------------------------------------------
FAMILY_RULES: list[tuple[str, dict]] = [
    # Older GPT-5 models (5.5, 5.4, 5.4-mini, 5.2, ...): reasoning models. The docs do not list their levels one by one,
    # so any documented level is sent and the provider decides; temperature follows the same rule as GPT-6.
    (
        "gpt-5",
        {
            "reasoning_model": True,
            "reasoning_efforts": ALL_EFFORTS,
            "strict_efforts": False,
            "default_effort": "medium",
            "temperature": _REASONING_NO_TEMPERATURE,
            "temperature_range": _TEMPERATURE_RANGE,
            "status": "assumed",
            "source": "Chat Completions reference (levels); temperature rule taken from the GPT-6 guidance",
        },
    ),
    # Models that do not reason (GPT-4o, GPT-4.1, ...; the models page marks gpt-4o and gpt-4o-mini deprecated).
    # `reasoning_effort` does not apply to them; temperature always does.
    (
        "gpt-4",
        {
            "reasoning_model": False,
            "reasoning_efforts": (),
            "strict_efforts": True,
            "default_effort": None,
            "temperature": "always",
            "temperature_range": _TEMPERATURE_RANGE,
            "status": "deprecated",
            "source": "Chat Completions reference: temperature 0 to 2; not a reasoning model",
        },
    ),
]

# ---- anything else: a compatible API (Ollama, a proxy, ...) or a model not listed above ---------------------------------
UNKNOWN_MODEL_RULE: dict = {
    "reasoning_model": False,
    "reasoning_efforts": ALL_EFFORTS,
    "strict_efforts": False,  # send what the user chose; the provider decides
    "default_effort": None,
    "temperature": "always",
    "temperature_range": _TEMPERATURE_RANGE,
    "status": "assumed",
    "source": "no rule for this model: the settings are sent as chosen",
}


class UnsupportedSetting(AppError):
    """A setting the model is documented NOT to accept (refused before any request is sent)."""


@dataclass
class ResolvedParams:
    reasoning_effort: str | None
    """The `reasoning_effort` to send (None: leave the field out)."""
    temperature: float | None
    """The `temperature` to send (None: leave the field out)."""
    rule: str
    """Which rule applied: an exact model id, a family prefix, or "unknown"."""
    temperature_note: str | None = None
    """Why a temperature that was asked for is not sent."""
    logprobs: bool = False
    """Whether to send `logprobs: true`."""
    logprobs_note: str | None = None
    """Why log probabilities that were asked for are not requested."""
    adjustments: list[str] = field(default_factory=list)
    """Everything the rules changed, in words, for the API log."""


def rule_for(model: str) -> tuple[str, dict]:
    """The rule for a model: an exact entry, else the first family prefix that matches, else the unknown-model rule."""
    if model in MODEL_RULES:
        return model, MODEL_RULES[model]
    for prefix, rule in FAMILY_RULES:
        if model.startswith(prefix):
            return f"{prefix}*", rule
    return "unknown", UNKNOWN_MODEL_RULE


def _words(efforts: tuple[str, ...]) -> str:
    return ", ".join(efforts)


def resolve_params(
    model: str, reasoning_effort: str | None, temperature: float | None, logprobs: bool = False
) -> ResolvedParams:
    """Turn what the user set into what this model accepts.

    `reasoning_effort` None means "Default (model decides)": the field is left out and the model runs at its own default.
    Raises `UnsupportedSetting` for a reasoning level the model is documented not to accept."""
    name, rule = rule_for(model)
    adjustments: list[str] = []
    effort = reasoning_effort

    if effort is not None:
        if not rule["reasoning_model"] and not rule["reasoning_efforts"]:
            adjustments.append(f"Reasoning effort {effort} was not sent: {model} is not a reasoning model.")
            effort = None
        elif rule["strict_efforts"] and effort not in rule["reasoning_efforts"]:
            raise UnsupportedSetting(
                400,
                "llm_unsupported_setting",
                f"{model} does not support the reasoning level {effort}. It supports: {_words(rule['reasoning_efforts'])}. "
                "Start a conversation with one of those, or Default.",
            )

    effective = effort if effort is not None else rule["default_effort"]

    send_temperature: float | None = None
    note: str | None = None
    if temperature is not None:
        mode = rule["temperature"]
        low, high = rule["temperature_range"]
        if mode == "always":
            send_temperature = min(max(temperature, low), high)
            if send_temperature != temperature:
                adjustments.append(
                    f"Temperature {temperature:g} was changed to {send_temperature:g} (range {low:g} to {high:g})."
                )
        elif mode == "only_with_effort_none" and effective == "none":
            send_temperature = min(max(temperature, low), high)
        elif mode == "only_with_effort_none":
            ran_at = effective if effective else "its own default"
            note = (
                f"{model} accepts a temperature only when the reasoning level is None. This call runs at {ran_at}, "
                "so the temperature was not sent."
            )
        else:
            note = f"{model} does not accept a temperature, so it was not sent."
        if note:
            adjustments.append(note)

    send_logprobs = False
    logprobs_note: str | None = None
    if logprobs:
        mode = rule.get("logprobs", rule["temperature"])
        if mode == "always" or (mode == "only_with_effort_none" and effective == "none"):
            send_logprobs = True
        elif mode == "only_with_effort_none":
            ran_at = effective if effective else "its own default"
            logprobs_note = (
                f"{model} accepts log probabilities only when the reasoning level is None. This call runs at {ran_at}, "
                "so logprobs was not requested."
            )
        else:
            logprobs_note = f"{model} does not return log probabilities, so logprobs was not requested."
        if logprobs_note:
            adjustments.append(logprobs_note)

    return ResolvedParams(
        reasoning_effort=effort,
        temperature=send_temperature,
        rule=name,
        temperature_note=note,
        logprobs=send_logprobs,
        logprobs_note=logprobs_note,
        adjustments=adjustments,
    )
