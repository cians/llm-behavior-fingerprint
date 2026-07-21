# Changelog

## 0.1.0 - 2026-07-21

### Features

- Generate behavioral fingerprints for OpenAI-compatible LLM endpoints.
- Compare two live endpoints or a live endpoint with a local historical baseline.
- Include nine built-in random-choice probes and one user-defined probe slot.
- Store sanitized fingerprint history locally and export results as JSON.
- Calculate entropy, preference distributions, and Jensen-Shannon distance.

### Security

- Keep API keys out of browser storage, history records, exports, and logs.
- Bind the local server to `127.0.0.1` by default.
- Send keys only from the local proxy to the API endpoint entered by the user.
