# ADR-0001: Consolidate Stream Parsing into a Deep Parser Module

## Status
Accepted

## Context
Previously, network monkey-patching (`fetch` and `XHR`), SSE buffer management, JSON delta extraction, and prompt parsing were tightly coupled inside `src/interceptor.ts`. Testing protocol parsing required simulating entire DOM / browser network environments, and any state machine bugs in chunk buffering leaked across transport wrappers.

## Decision
1. Extract a single deep **Stream Parser** module (`src/parser/stream-parser.ts`) with a minimal `feed(chunk)` / `flush()` interface.
2. Demote `hookFetch` and `hookXHR` in `src/interceptor.ts` into thin **Transport Adapters** whose only role is tapping browser network calls and feeding raw text into the Stream Parser.
3. All `HookEvent` generation (start, chunks, completion, errors) is owned and emitted by the Stream Parser.

## Consequences
- **Positive**: Stream and protocol parsing can be tested in standard Node/Vitest environments without DOM/network mocking.
- **Positive**: Adding support for new AI platform formats is localized to `src/parser/stream-parser.ts` without touching transport hooks.
- **Trade-off**: The Stream Parser manages an internal stateful SSE buffer per active HTTP transaction.
