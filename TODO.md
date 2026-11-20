# Backlog

- [ ] Add online request and response rewrite/block rules with Trace auditing. The [Phase 1 design for review (中文)](docs/online-rules-and-trace.zh-CN.md) covers execution order, streaming and Magpie route capabilities.
- [ ] Add request rewrite rules and response-triggered retries to D-message. The design below is pending implementation.

## Retry with modified request

Use one rule editor and one JSON patch engine for both actions. Preview matches and request diffs against saved traces. A request rule can run on a compatible Magpie request hook. A response-triggered retry requires an opt-in forwarding route that owns the client's open response stream. The page service can reuse its listener if the client is routed through it.

- Snapshot the incoming request and the effective first request. Pin the rule revision per call and apply the retry patch to the effective request. Keep both attempts under one Trace and mark which response was delivered.
- Pass through traffic outside the retry scope. For eligible requests, buffer the first response, including native SSE events and tool calls, until the rule can decide. Return the original response on a miss. On a match, retry once and deliver one response on the original stream. Preserve the selected response's IDs, event order and terminal status so the agent can continue.
- Proposed defaults are 60 seconds to inspect the first response and 120 seconds of total buffering across both attempts. At the first limit, release the buffered prefix and continue streaming the first attempt. At the total limit, return the retained first response if the rule permits, otherwise return a protocol error. Propagate client cancellation. Skip automatic retries when upstream actions may already have had non-repeatable effects.
- Enforce the deadline in the forwarding handler. In local HTTP/1.1 tests with Magpie's Bun 1.4.4 and the page service's 30-second idle timeout, a POST buffered silently for 50 seconds completed. Sending an SSE comment first caused the silent stream to close around 32 seconds. Client, proxy and upstream deadlines still apply.
