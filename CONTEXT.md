# Domain Context: AI Chatbox Hook

This document defines the canonical ubiquitous language for the project's domain model.

## Glossary

### Stream Parser
The deep module responsible for protocol detection, SSE buffer line framing, JSON payload extraction, and mapping raw HTTP request/response streams into domain-level `HookEvent` sequences.

### Transport Adapter
The thin network interception adapters (`FetchAdapter`, `XHRAdapter`) running in the target web page's MAIN World. Their sole responsibility is monkey-patching browser network primitives, cloning streams (`ReadableStream.tee()`), and feeding raw text/chunks into the Stream Parser.

### Hook Event
The canonical stream lifecycle and payload event (`AI_HOOK_START`, `AI_HOOK_CHUNK`, `AI_HOOK_END`, `AI_HOOK_ERROR`) emitted by the Stream Parser across the DOM event bridge to the extension's isolated content script.

### Session
A stateful record representing a complete AI interaction, including the originating URL, timestamp, extracted prompt messages, model name, streaming response plaintext, duration, and status.

### Prompt Message
A structured representation of an input message extracted from the AI request payload, consisting of a `role` ('user', 'assistant', 'system') and plaintext `content`.

### Provider Rule
A configured mapping associating an AI platform identifier (e.g., 'OpenAI', 'Claude', 'DeepSeek') with an API endpoint URL pattern (supporting wildcards `*` or regular expressions).

### Endpoint Matcher
A pure matching engine that evaluates candidate request URLs against configured Provider Rules to determine whether interception should occur and which provider name to assign.

### Filter Config
The user-defined filtering policy specifying whether the interceptor operates in `whitelist` mode (only capturing matched Provider endpoints) or `all` mode (capturing all requests).
