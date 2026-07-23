import http from "node:http";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PROBES, SAMPLE_LIMITS, TOTAL_PROBE_SLOTS, createCustomProbe, getProbe, parseProbeAnswer } from "./public/core.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, "public");
const PORT = Number(process.env.PORT) || 4173;
const HOST = process.env.HOST || "127.0.0.1";
const MAX_BODY_BYTES = 80 * 1024;
const MAX_REQUESTS = 1_000;
const PROTOCOLS = new Set(["openai", "anthropic"]);
export const CONCURRENCY_LIMITS = Object.freeze({ min: 1, max: 10, default: 4 });
export const PROBE_SYSTEM_PROMPT = "Answer the user's request directly. Do not use, call, or attempt to use any tools, functions, code execution, web browsing, or external resources. Return only the requested answer.";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function applySecurityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
  );
  response.setHeader("Cache-Control", "no-store");
}

function sendJson(response, status, payload) {
  applySecurityHeaders(response);
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function allowedOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname) && Number(parsed.port || 80) === PORT;
  } catch {
    return false;
  }
}

async function readJsonBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "请求内容过大");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "请求 JSON 格式无效");
  }
}

class HttpError extends Error {
  constructor(status, message, details = "") {
    super(message);
    this.status = status;
    this.details = details;
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

function parseEndpoint(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl ?? "").trim());
  } catch {
    throw new HttpError(400, "请输入有效的模型 URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new HttpError(400, "模型 URL 仅支持 http 或 https");
  }
  return parsed;
}

export function normalizeProtocol(value) {
  const protocol = String(value ?? "openai").trim().toLowerCase();
  if (!PROTOCOLS.has(protocol)) throw new HttpError(400, "协议仅支持 OpenAI 或 Anthropic");
  return protocol;
}

export function normalizeConcurrency(value) {
  const concurrency = value == null ? CONCURRENCY_LIMITS.default : Number(value);
  if (!Number.isInteger(concurrency) || concurrency < CONCURRENCY_LIMITS.min || concurrency > CONCURRENCY_LIMITS.max) {
    throw new HttpError(400, `并发请求数需在 ${CONCURRENCY_LIMITS.min} 到 ${CONCURRENCY_LIMITS.max} 之间`);
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

async function fetchUpstream(url, options, timeoutMs = 120_000) {
  const controller = new AbortController();
  const externalSignal = options.signal;
  const abortFromExternal = () => controller.abort();
  if (externalSignal?.aborted) controller.abort();
  else externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text.slice(0, 500) };
    }
    if (!response.ok) {
      throw new HttpError(response.status, formatUpstreamError(data, response.status));
    }
    return data;
  } catch (error) {
    if (error.name === "AbortError") {
      if (externalSignal?.aborted) throw new HttpError(499, "模型请求已取消");
      throw new HttpError(504, "模型请求超时");
    }
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, `无法连接模型端点：${error.message}`);
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", abortFromExternal);
  }
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
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === "string" ? part : part?.text ?? "")).join("");
  }
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

export function buildProbeRequestBody(endpoint, probe) {
  const protocol = normalizeProtocol(endpoint.protocol);
  const userMessage = { role: "user", content: probe.prompt };
  const body = {
    stream: false,
    max_tokens: 256
  };
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

async function requestProbe({ endpoint, probe, signal }) {
  const protocol = normalizeProtocol(endpoint.protocol);
  const url = protocol === "anthropic" ? buildAnthropicMessagesUrl(endpoint.url) : buildChatCompletionsUrl(endpoint.url);
  const baseBody = buildProbeRequestBody(endpoint, probe);

  let data;
  try {
    data = await fetchUpstream(url, {
      method: "POST",
      headers: upstreamHeaders(endpoint.key, protocol),
      signal,
      body: JSON.stringify(baseBody)
    });
  } catch (error) {
    if (protocol === "anthropic" || !unsupportedSamplingParameter(error)) throw error;
    const { max_tokens, ...fallbackBody } = baseBody;
    data = await fetchUpstream(url, {
      method: "POST",
      headers: upstreamHeaders(endpoint.key, protocol),
      signal,
      body: JSON.stringify(fallbackBody)
    });
  }

  const raw = extractAssistantText(data, protocol).trim();
  if (!raw) throw new HttpError(502, "模型返回了空内容");
  return { raw, value: parseProbeAnswer(probe, raw) };
}

function shuffle(items) {
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

async function handleModels(request, response) {
  const body = await readJsonBody(request);
  const protocol = normalizeProtocol(body.protocol);
  const url = buildModelsUrl(body.url, protocol);
  const data = await fetchUpstream(url, { method: "GET", headers: upstreamHeaders(body.key, protocol) }, 20_000);
  const rawModels = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
  const models = rawModels
    .map((model) => (typeof model === "string" ? model : model?.id ?? model?.name))
    .filter(Boolean)
    .slice(0, 500);
  sendJson(response, 200, { models });
}

async function handleRun(request, response) {
  const body = await readJsonBody(request);
  const endpoint = body.endpoint ?? {};
  parseEndpoint(endpoint.url);
  const protocol = normalizeProtocol(endpoint.protocol);
  endpoint.protocol = protocol;
  if (protocol === "anthropic" && !String(endpoint.model ?? "").trim()) {
    throw new HttpError(400, "Anthropic Messages 协议必须填写模型 ID");
  }

  const samplesPerProbe = Number(body.samplesPerProbe);
  if (!Number.isInteger(samplesPerProbe) || samplesPerProbe < SAMPLE_LIMITS.min || samplesPerProbe > SAMPLE_LIMITS.max) {
    throw new HttpError(400, `每个问题的采样次数需在 ${SAMPLE_LIMITS.min} 到 ${SAMPLE_LIMITS.max} 之间`);
  }
  const concurrency = normalizeConcurrency(body.concurrency);

  const uniqueIds = [...new Set(Array.isArray(body.probeIds) ? body.probeIds : [])];
  let customProbe = null;
  if (body.customProbe) {
    try {
      customProbe = createCustomProbe(body.customProbe);
    } catch (error) {
      throw new HttpError(400, error.message);
    }
  }
  const probes = uniqueIds
    .map((probeId) => getProbe(probeId) ?? (customProbe?.id === probeId ? customProbe : null))
    .filter(Boolean);
  if (!probes.length) throw new HttpError(400, "未选择有效的指纹问题");
  const total = probes.length * samplesPerProbe;
  if (total > MAX_REQUESTS) throw new HttpError(400, `单次最多允许 ${MAX_REQUESTS} 个模型请求`);

  applySecurityHeaders(response);
  response.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Transfer-Encoding": "chunked",
    Connection: "keep-alive"
  });

  const write = (payload) => {
    if (!response.destroyed) response.write(`${JSON.stringify(payload)}\n`);
  };
  const schedule = shuffle(
    probes.flatMap((probe) => Array.from({ length: samplesPerProbe }, (_, sampleIndex) => ({ probe, sampleIndex })))
  );
  let completed = 0;
  let consecutiveErrors = 0;
  let consecutiveRateLimits = 0;
  let fatalError = null;
  const batchController = new AbortController();
  request.once("aborted", () => batchController.abort());
  response.once("close", () => {
    if (!response.writableEnded) batchController.abort();
  });

  write({ type: "start", total, concurrency, probeIds: probes.map((probe) => probe.id) });

  await runWithConcurrency(schedule, concurrency, async (item) => {
    if (response.destroyed || fatalError) return;
    const startedAt = Date.now();
    try {
      const result = await requestProbe({ endpoint, probe: item.probe, signal: batchController.signal });
      completed += 1;
      consecutiveErrors = 0;
      consecutiveRateLimits = 0;
      write({
        type: "sample",
        completed,
        total,
        probeId: item.probe.id,
        sampleIndex: item.sampleIndex,
        raw: result.raw.slice(0, 200),
        value: result.value,
        valid: Boolean(result.value),
        latencyMs: Date.now() - startedAt
      });
    } catch (error) {
      if (response.destroyed || (fatalError && error.status === 499)) return;
      completed += 1;
      if (error.status === 429) {
        consecutiveRateLimits += 1;
        consecutiveErrors = 0;
      } else {
        consecutiveErrors += 1;
        consecutiveRateLimits = 0;
      }
      const shouldAbort = shouldAbortSampling({
        status: error.status,
        consecutiveErrors,
        consecutiveRateLimits,
        concurrency
      });
      write({
        type: "sample_error",
        completed,
        total,
        probeId: item.probe.id,
        sampleIndex: item.sampleIndex,
        status: error.status || 500,
        message: error.message,
        continuing: !shouldAbort,
        latencyMs: Date.now() - startedAt
      });

      if (shouldAbort && !fatalError) {
        fatalError = { status: error.status || 500, message: error.message };
        batchController.abort();
      }
    }
  });

  if (response.destroyed) return;
  if (fatalError) {
    write({ type: "fatal", ...fatalError });
    response.end();
    return;
  }

  write({ type: "done", completed, total });
  response.end();
}

async function serveStatic(request, response) {
  const requested = new URL(request.url, `http://${request.headers.host}`).pathname;
  const relative = requested === "/" ? "index.html" : decodeURIComponent(requested.slice(1));
  const filePath = path.resolve(PUBLIC_DIR, relative);
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`) && filePath !== path.join(PUBLIC_DIR, "index.html")) {
    sendJson(response, 403, { error: "禁止访问" });
    return;
  }

  try {
    const content = await readFile(filePath);
    applySecurityHeaders(response);
    response.writeHead(200, { "Content-Type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream" });
    response.end(content);
  } catch (error) {
    if (error.code === "ENOENT") {
      sendJson(response, 404, { error: "页面不存在" });
      return;
    }
    throw error;
  }
}

export const server = http.createServer(async (request, response) => {
  try {
    if (!allowedOrigin(request)) {
      sendJson(response, 403, { error: "来源不被允许" });
      return;
    }

    const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
    if (pathname === "/api/health" && request.method === "GET") {
      sendJson(response, 200, { ok: true, fixedProbeCount: PROBES.length, probeSlots: TOTAL_PROBE_SLOTS });
      return;
    }
    if (pathname === "/api/models" && request.method === "POST") {
      await handleModels(request, response);
      return;
    }
    if (pathname === "/api/run" && request.method === "POST") {
      await handleRun(request, response);
      return;
    }
    if (pathname.startsWith("/api/")) {
      sendJson(response, 404, { error: "接口不存在" });
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      sendJson(response, 405, { error: "请求方法不支持" });
      return;
    }
    await serveStatic(request, response);
  } catch (error) {
    if (response.headersSent) {
      if (!response.destroyed) response.end(`${JSON.stringify({ type: "fatal", message: error.message })}\n`);
      return;
    }
    sendJson(response, error.status || 500, {
      error: error.message || "服务器内部错误",
      details: error.details || undefined
    });
  }
});

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  server.listen(PORT, HOST, () => {
    console.log(`Model Fingerprint Lab running at http://${HOST}:${PORT}`);
  });
}
