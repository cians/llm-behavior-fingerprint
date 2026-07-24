import { parseProbeAnswer } from "./core.js";

const PROTOCOLS = new Set(["openai", "anthropic"]);

export const CONCURRENCY_LIMITS = Object.freeze({ min: 1, max: 10, default: 4 });
export const REQUEST_TIMEOUT_MS = 120_000;
export const MODELS_TIMEOUT_MS = 20_000;
export const PROBE_SYSTEM_PROMPT = "Answer the user's request directly. Do not use, call, or attempt to use any tools, functions, code execution, web browsing, or external resources. Return only the requested answer.";

export class DirectRequestError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "DirectRequestError";
    this.status = status;
  }
}

function cleanErrorText(value) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, 300);
}

function errorMessageFromPayload(payload) {
  if (typeof payload === "string") return cleanErrorText(payload);
  if (!payload || typeof payload !== "object") return "";
  if (typeof payload.error === "string") return cleanErrorText(payload.error);
  return cleanErrorText(payload.error?.message)
    || cleanErrorText(payload.message)
    || cleanErrorText(payload.detail);
}

function parseNestedError(raw) {
  if (raw && typeof raw === "object") return raw;
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "string" ? JSON.parse(parsed) : parsed;
  } catch {
    return null;
  }
}

export function formatUpstreamError(data, httpStatus) {
  const error = data?.error && typeof data.error === "object" ? data.error : null;
  const metadata = error?.metadata && typeof error.metadata === "object" ? error.metadata : null;
  const raw = metadata?.raw;
  const nested = parseNestedError(raw);
  const parts = [
    `HTTP ${httpStatus}`,
    errorMessageFromPayload(data),
    cleanErrorText(metadata?.provider_name || metadata?.provider),
    errorMessageFromPayload(nested) || (!nested ? cleanErrorText(raw) : ""),
    cleanErrorText(data?.raw)
  ].filter(Boolean);
  const unique = parts.filter((part, index) => parts.findIndex((candidate) => candidate.toLowerCase() === part.toLowerCase()) === index);
  return unique.join(" · ").slice(0, 500) || `HTTP ${httpStatus} · 上游请求失败`;
}

export function formatBrowserFetchError(error) {
  const browserMessage = cleanErrorText(error?.message) || "浏览器未提供详细原因";
  return `浏览器未收到可读取的上游响应，无法显示原始上游错误（浏览器错误：${browserMessage}）。可能原因包括 CORS 预检、网络或 DNS、TLS 证书、混合内容及浏览器扩展拦截。`;
}

function parseEndpoint(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl ?? "").trim());
  } catch {
    throw new DirectRequestError(400, "请输入有效的模型 URL");
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new DirectRequestError(400, "模型 URL 仅支持 http 或 https");
  }
  return parsed;
}

export function normalizeProtocol(value) {
  const protocol = String(value ?? "openai").trim().toLowerCase();
  if (!PROTOCOLS.has(protocol)) throw new DirectRequestError(400, "协议仅支持 OpenAI 或 Anthropic");
  return protocol;
}

export function normalizeConcurrency(value) {
  const concurrency = value == null ? CONCURRENCY_LIMITS.default : Number(value);
  if (!Number.isInteger(concurrency) || concurrency < CONCURRENCY_LIMITS.min || concurrency > CONCURRENCY_LIMITS.max) {
    throw new DirectRequestError(400, `并发请求数需在 ${CONCURRENCY_LIMITS.min} 到 ${CONCURRENCY_LIMITS.max} 之间`);
  }
  return concurrency;
}

export async function runWithConcurrency(items, concurrency, task) {
  const workerCount = Math.min(normalizeConcurrency(concurrency), items.length);
  let nextIndex = 0;
  let firstError = null;

  const worker = async () => {
    while (!firstError && nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        await task(items[index], index);
      } catch (error) {
        firstError ??= error;
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (firstError) throw firstError;
}

export function buildChatCompletionsUrl(rawUrl) {
  const parsed = parseEndpoint(rawUrl);
  const pathname = parsed.pathname.replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(pathname)) {
    parsed.pathname = pathname;
  } else if (/\/v1$/i.test(pathname)) {
    parsed.pathname = `${pathname}/chat/completions`;
  } else {
    parsed.pathname = `${pathname}/v1/chat/completions`.replace(/\/+/g, "/");
  }
  return parsed;
}

export function buildAnthropicMessagesUrl(rawUrl) {
  const parsed = parseEndpoint(rawUrl);
  const pathname = parsed.pathname.replace(/\/+$/, "");
  if (/\/messages$/i.test(pathname)) {
    parsed.pathname = pathname;
  } else if (/\/v1$/i.test(pathname)) {
    parsed.pathname = `${pathname}/messages`;
  } else {
    parsed.pathname = `${pathname}/v1/messages`.replace(/\/+/g, "/");
  }
  return parsed;
}

export function buildModelsUrl(rawUrl, protocol = "openai") {
  const normalized = normalizeProtocol(protocol);
  const parsed = normalized === "anthropic" ? buildAnthropicMessagesUrl(rawUrl) : buildChatCompletionsUrl(rawUrl);
  parsed.pathname = normalized === "anthropic"
    ? parsed.pathname.replace(/\/messages$/i, "/models")
    : parsed.pathname.replace(/\/chat\/completions$/i, "/models");
  parsed.search = "";
  parsed.hash = "";
  return parsed;
}

export function upstreamHeaders(key, protocol = "openai") {
  const normalized = normalizeProtocol(protocol);
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (normalized === "anthropic") {
    headers["anthropic-version"] = "2023-06-01";
    if (String(key ?? "").trim()) headers["x-api-key"] = String(key).trim();
  } else if (String(key ?? "").trim()) {
    headers.Authorization = `Bearer ${String(key).trim()}`;
  }
  return headers;
}

export function buildProbeRequestBody(endpoint, probe) {
  const protocol = normalizeProtocol(endpoint.protocol);
  const userMessage = { role: "user", content: probe.prompt };
  const body = { stream: false, max_tokens: 256 };
  if (protocol === "anthropic") {
    body.system = PROBE_SYSTEM_PROMPT;
    body.messages = [userMessage];
  } else {
    body.messages = [
      { role: "system", content: PROBE_SYSTEM_PROMPT },
      userMessage
    ];
  }
  if (String(endpoint.model ?? "").trim()) body.model = String(endpoint.model).trim();
  return body;
}

export function extractAssistantText(data, protocol = "openai") {
  if (normalizeProtocol(protocol) === "anthropic") {
    if (!Array.isArray(data?.content)) return "";
    return data.content
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("");
  }
  const content = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? data?.output_text;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part === "string" ? part : part?.text ?? "")).join("");
  if (Array.isArray(data?.output)) {
    return data.output
      .flatMap((item) => item?.content ?? [])
      .map((part) => part?.text ?? part?.output_text ?? "")
      .join("");
  }
  return "";
}

function unsupportedSamplingParameter(error) {
  return error.status === 400 && /(max_tokens|max completion|unsupported parameter|not support)/i.test(error.message);
}

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const externalSignal = options.signal;
  let timedOut = false;
  const abortFromExternal = () => controller.abort();
  if (externalSignal?.aborted) controller.abort();
  else externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer"
    });
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text.slice(0, 500) };
    }
    if (!response.ok) throw new DirectRequestError(response.status, formatUpstreamError(data, response.status));
    return data;
  } catch (error) {
    if (error instanceof DirectRequestError) throw error;
    if (error.name === "AbortError") {
      if (externalSignal?.aborted) throw new DirectRequestError(499, "模型请求已取消");
      if (timedOut) throw new DirectRequestError(504, `模型请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
    }
    if (error instanceof TypeError) throw new DirectRequestError(0, formatBrowserFetchError(error));
    throw new DirectRequestError(502, `无法连接模型端点：${error.message}`);
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", abortFromExternal);
  }
}

export async function requestProbe({ endpoint, probe, signal }) {
  const protocol = normalizeProtocol(endpoint.protocol);
  const url = protocol === "anthropic" ? buildAnthropicMessagesUrl(endpoint.url) : buildChatCompletionsUrl(endpoint.url);
  const baseBody = buildProbeRequestBody(endpoint, probe);
  let data;

  try {
    data = await fetchJson(url, {
      method: "POST",
      headers: upstreamHeaders(endpoint.key, protocol),
      signal,
      body: JSON.stringify(baseBody)
    }, REQUEST_TIMEOUT_MS);
  } catch (error) {
    if (protocol === "anthropic" || !unsupportedSamplingParameter(error)) throw error;
    const { max_tokens, ...fallbackBody } = baseBody;
    data = await fetchJson(url, {
      method: "POST",
      headers: upstreamHeaders(endpoint.key, protocol),
      signal,
      body: JSON.stringify(fallbackBody)
    }, REQUEST_TIMEOUT_MS);
  }

  const raw = extractAssistantText(data, protocol).trim();
  if (!raw) throw new DirectRequestError(502, "模型返回了空内容");
  return { raw, value: parseProbeAnswer(probe, raw) };
}

export async function requestModelList({ endpoint, signal }) {
  const protocol = normalizeProtocol(endpoint.protocol);
  const data = await fetchJson(buildModelsUrl(endpoint.url, protocol), {
    method: "GET",
    headers: upstreamHeaders(endpoint.key, protocol),
    signal
  }, MODELS_TIMEOUT_MS);
  const rawModels = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
  return rawModels
    .map((model) => (typeof model === "string" ? model : model?.id ?? model?.name))
    .filter(Boolean)
    .slice(0, 500);
}

export function shuffle(items) {
  const output = [...items];
  for (let index = output.length - 1; index > 0; index -= 1) {
    const target = Math.floor(Math.random() * (index + 1));
    [output[index], output[target]] = [output[target], output[index]];
  }
  return output;
}

export function shouldAbortSampling({ status, consecutiveErrors, consecutiveRateLimits, concurrency }) {
  if ([400, 401, 403, 404].includes(status)) return true;
  if (status === 429) return consecutiveRateLimits >= Math.max(3, normalizeConcurrency(concurrency));
  return consecutiveErrors >= 3;
}

export async function sampleProbes({ endpoint, probes, samplesPerProbe, concurrency, signal, onSample, onError }) {
  const normalizedConcurrency = normalizeConcurrency(concurrency);
  const schedule = shuffle(
    probes.flatMap((probe) => Array.from({ length: samplesPerProbe }, (_, sampleIndex) => ({ probe, sampleIndex })))
  );
  const batchController = new AbortController();
  const abortFromParent = () => batchController.abort();
  if (signal?.aborted) batchController.abort();
  else signal?.addEventListener("abort", abortFromParent, { once: true });

  let completed = 0;
  let consecutiveErrors = 0;
  let consecutiveRateLimits = 0;
  let fatalError = null;

  try {
    await runWithConcurrency(schedule, normalizedConcurrency, async (item) => {
      if (batchController.signal.aborted) return;
      const startedAt = Date.now();
      try {
        const result = await requestProbe({ endpoint, probe: item.probe, signal: batchController.signal });
        if (batchController.signal.aborted) return;
        completed += 1;
        consecutiveErrors = 0;
        consecutiveRateLimits = 0;
        onSample?.({
          ...item,
          completed,
          total: schedule.length,
          result,
          latencyMs: Date.now() - startedAt
        });
      } catch (error) {
        if (batchController.signal.aborted) return;
        completed += 1;
        const status = error.status || 500;
        if (status === 429) {
          consecutiveRateLimits += 1;
          consecutiveErrors = 0;
        } else {
          consecutiveErrors += 1;
          consecutiveRateLimits = 0;
        }
        const continuing = !shouldAbortSampling({ status, consecutiveErrors, consecutiveRateLimits, concurrency: normalizedConcurrency });
        onError?.({
          ...item,
          completed,
          total: schedule.length,
          status,
          message: error.message || "模型请求失败",
          continuing,
          latencyMs: Date.now() - startedAt
        });
        if (!continuing && !fatalError) {
          fatalError = error;
          batchController.abort();
        }
      }
    });
  } finally {
    signal?.removeEventListener("abort", abortFromParent);
  }

  if (signal?.aborted) throw new DOMException("实验已终止", "AbortError");
  if (fatalError) throw fatalError;
  return { completed, total: schedule.length };
}
