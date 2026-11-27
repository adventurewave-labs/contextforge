# ISP-001 compatibility-first Chat Completions proxy

## Acceptance criteria

- `POST /v1/chat/completions` is opt-in. The deployment supplies one complete HTTPS upstream URL, one upstream bearer credential and one distinct client bearer credential. Requests require the client credential and forward only to the configured endpoint. The upstream gets the deployment's upstream credential through a fixed request header set. Client keys are checked in constant time. Upstream redirects are relayed as status responses without a redirect target. Missing configuration keeps the route unavailable. Invalid attempts fail before any upstream request.
- Work with the stock Python and Node OpenAI SDKs against a controlled HTTPS upstream. Preserve original request bytes, including messages, money values, tool schemas, model selection, and streaming options. Relay upstream JSON and usage, HTTP status, and applicable response headers.
- Stream upstream SSE bytes without waiting for the full response. Preserve normal and tool-call deltas, usage events, and termination. Exercise a split stream, early client cancellation, upstream 429 and 5xx, and both pre-header and midstream timeouts. Close the upstream connection on client disconnect or timeout.
- Bound request size and reuse the server's rate limiter, with a separate bucket for unauthorized attempts. Forward an explicit response header allowlist for wire metadata and avoid storing request or response bodies and credentials. Record the upstream request ID alongside existing access metadata after validating its characters and length.
- Keep the existing compression and verification endpoints usable. Test raw forwarding, rejection before dispatch, timeout and cancellation, and verify a proxy log capture excludes both fixture credentials and the fixture message body.

## Scope

A single configured upstream serves the compatibility-first research decision. ContextForge forwards the original JSON and stream. Compression, verifier integration and cost accounting are separate future slices. The implementation uses Node core HTTP and TLS APIs and the existing service. The feature is disabled unless operators configure it.

Use disposable credentials and a local TLS upstream for the VPS acceptance suite. Stage real-provider latency measurements separately with an authorized upstream. Measure direct and proxied time to first token and completion latency on matched workloads before deciding the rollout budget. The existing compression benchmark has its own workload.

[OpenAI Chat Completions API](https://developers.openai.com/api/reference/typescript/resources/chat/subresources/completions/methods/create)
