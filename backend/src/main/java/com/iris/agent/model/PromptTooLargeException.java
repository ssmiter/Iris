package com.iris.agent.model;

public class PromptTooLargeException extends ModelProtocolException {
    public PromptTooLargeException(String message) {
        super("prompt_too_large", message);
    }
}
