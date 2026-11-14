"""What a conversation repository reports when a write is refused. The service turns these into the API's errors."""


class ConversationLocked(Exception):
    """The conversation is locked: it takes no more prompts."""


class PromptInProgress(Exception):
    """A prompt of the conversation is still waiting for its reply, so it cannot be locked or forked yet."""
