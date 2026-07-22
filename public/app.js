import {
  PRESETS,
  PROBES,
  SAMPLE_LIMITS,
  TOTAL_PROBE_SLOTS,
  buildFingerprint,
  compareFingerprints,
  createCustomProbe,
  formatPercent,
  getProbe
} from "./core.js";

const STORAGE_KEY = "model-trace-history-v1";
const MAX_HISTORY = 30;
const CONCURRENCY_LIMITS = { min: 1, max: 10, default: 4 };
const BASE_TITLE = document.title;
const TAB_FRAMES = ["◐", "◓", "◑", "◒"];
const REDUCED_MOTION = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");
const PROTOCOL_LABELS = { openai: "OpenAI", anthropic: "Anthropic" };
const PROTOCOL_UI = {
  openai: {
    urlHint: "Base URL、/v1 或 /chat/completions",
    urlPlaceholder: "https://api.example.com/v1",
    keyHint: "通过 Authorization: Bearer 发送",
    keyPlaceholder: "sk-••••••••••••",
    modelPlaceholder: "例如：gpt-4o-mini"
  },
  anthropic: {
    urlHint: "Base URL、/v1 或 /v1/messages",
    urlPlaceholder: "https://api.anthropic.com",
    keyHint: "通过 x-api-key 发送",
    keyPlaceholder: "sk-ant-••••••••••",
    modelPlaceholder: "例如：claude-sonnet-4-5"
  }
};

const state = {
  mode: "single",
  preset: "standard",
  probeIds: new Set(PRESETS.standard.probeIds),
  samplesPerProbe: PRESETS.standard.samplesPerProbe,
  concurrency: CONCURRENCY_LIMITS.default,
  histories: loadHistories(),
  abortController: null,
  latestResult: null,
  running: false,
  customProbe: null,
  tabAnimationTimer: null,
  tabAnimationFrame: 0,
  runProgress: { completed: 0, total: 0, tag: "A" }
};

const elements = {
  form: document.querySelector("#experimentForm"),
  endpointGrid: document.querySelector("#endpointGrid"),
  endpointBCard: document.querySelector("#endpointBCard"),
  historyPicker: document.querySelector("#historyPicker"),
  historySelect: document.querySelector("#historySelect"),
  historyPreview: document.querySelector("#historyPreview"),
  probeGrid: document.querySelector("#probeGrid"),
  requestCount: document.querySelector("#requestCount"),
  probeCount: document.querySelector("#probeCount"),
  runLabel: document.querySelector("#runLabel"),
  runSubLabel: document.querySelector("#runSubLabel"),
  formError: document.querySelector("#formError"),
  runButton: document.querySelector("#runExperiment"),
  tabRunProgress: document.querySelector("#tabRunProgress"),
  runConsole: document.querySelector("#runConsole"),
  consoleTitle: document.querySelector("#consoleTitle"),
  progressBar: document.querySelector("#progressBar"),
  progressText: document.querySelector("#progressText"),
  validText: document.querySelector("#validText"),
  activeEndpoint: document.querySelector("#activeEndpoint"),
  livePeak: document.querySelector("#livePeak"),
  liveGrid: document.querySelector("#liveGrid"),
  eventLog: document.querySelector("#eventLog"),
  results: document.querySelector("#results"),
  resultTitle: document.querySelector("#resultTitle"),
  resultContent: document.querySelector("#resultContent"),
  historyList: document.querySelector("#historyList"),
  historyCount: document.querySelector("#historyCount"),
  clearHistory: document.querySelector("#clearHistory"),
  methodDialog: document.querySelector("#methodDialog"),
  enableCustomProbe: document.querySelector("#enableCustomProbe"),
  customProbeFields: document.querySelector("#customProbeFields"),
  customProbeLabel: document.querySelector("#customProbeLabel"),
  customProbePrompt: document.querySelector("#customProbePrompt"),
  customProbeOptions: document.querySelector("#customProbeOptions"),
  customProbeError: document.querySelector("#customProbeError")
};
elements.samplesPerProbe = document.querySelector("#samplesPerProbe");
elements.requestConcurrency = document.querySelector("#requestConcurrency");

const favicon = document.querySelector('link[rel~="icon"]') ?? document.createElement("link");
favicon.rel = "icon";
if (!favicon.parentNode) document.head.append(favicon);

function renderFavicon({ running = false, progress = 0, frame = 0 } = {}) {
  const heights = running
    ? [10, 17, 25, 32, 25, 17, 10].map((height, index) => height + ((index + frame) % 3 === 0 ? 5 : 0))
    : [10, 17, 25, 32, 25, 17, 10];
  const bars = heights.map((height, index) => `<rect x="${17 + index * 4.5}" y="${48 - height}" width="2.6" height="${height}" rx="1.3"/>`).join("");
  const ringProgress = running ? Math.max(1, Math.min(100, progress)) : 100;
  const accent = running ? "#65f7d4" : "#d8ff4f";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#07100d"/><circle cx="32" cy="32" r="27" fill="none" stroke="#244037" stroke-width="3"/><circle cx="32" cy="32" r="27" fill="none" stroke="${accent}" stroke-width="3" stroke-linecap="round" pathLength="100" stroke-dasharray="${ringProgress} 100" transform="rotate(-90 32 32)"/><g fill="#d8ff4f">${bars}</g></svg>`;
  favicon.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function renderTabProgress() {
  const { completed, total, tag } = state.runProgress;
  const percent = total ? Math.min(100, Math.round((completed / total) * 100)) : 0;
  const frame = state.tabAnimationFrame % TAB_FRAMES.length;
  const glyph = REDUCED_MOTION?.matches ? "●" : TAB_FRAMES[frame];
  document.title = `${glyph} ${percent}% · 端点 ${tag} · ${BASE_TITLE}`;
  elements.tabRunProgress.textContent = `${percent}%`;
  renderFavicon({ running: true, progress: percent, frame });
}

function startExperimentVisuals(total) {
  state.runProgress = { completed: 0, total, tag: "A" };
  state.tabAnimationFrame = 0;
  document.body.classList.add("experiment-running");
  renderTabProgress();
  clearInterval(state.tabAnimationTimer);
  if (!REDUCED_MOTION?.matches) {
    state.tabAnimationTimer = setInterval(() => {
      state.tabAnimationFrame += 1;
      renderTabProgress();
    }, 520);
  }
}

function updateExperimentVisuals(completed, total, tag) {
  state.runProgress = { completed, total, tag };
  renderTabProgress();
}

function stopExperimentVisuals() {
  clearInterval(state.tabAnimationTimer);
  state.tabAnimationTimer = null;
  document.body.classList.remove("experiment-running");
  elements.tabRunProgress.textContent = "0%";
  document.title = BASE_TITLE;
  renderFavicon();
}

function loadHistories() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.map((history) => ({ ...history, protocol: history.protocol === "anthropic" ? "anthropic" : "openai" })) : [];
  } catch {
    return [];
  }
}

function persistHistories() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.histories.slice(0, MAX_HISTORY)));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function sanitizeUrl(raw) {
  try {
    const url = new URL(raw);
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return String(raw ?? "");
  }
}

function uid() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function activeProbe(probeId) {
  return getProbe(probeId) ?? (state.customProbe?.id === probeId ? state.customProbe : null);
}

function customProbeInput() {
  return {
    label: elements.customProbeLabel.value,
    prompt: elements.customProbePrompt.value,
    options: elements.customProbeOptions.value
  };
}

function updateCustomProbe({ showError = false } = {}) {
  if (state.customProbe) state.probeIds.delete(state.customProbe.id);
  state.customProbe = null;
  elements.customProbeError.textContent = "";

  if (!elements.enableCustomProbe.checked) {
    elements.customProbeFields.classList.add("hidden");
    updateEstimate();
    return null;
  }

  elements.customProbeFields.classList.remove("hidden");
  try {
    state.customProbe = createCustomProbe(customProbeInput());
    state.probeIds.add(state.customProbe.id);
  } catch (error) {
    if (showError) elements.customProbeError.textContent = error.message;
  }
  updateEstimate();
  return state.customProbe;
}

function renderProbes() {
  elements.probeGrid.innerHTML = PROBES.map((probe) => `
    <label class="probe-chip" title="${escapeHtml(probe.prompt)}">
      <input type="checkbox" value="${probe.id}" ${state.probeIds.has(probe.id) ? "checked" : ""} />
      <span><i>${escapeHtml(probe.glyph)}</i><b>${escapeHtml(probe.shortLabel)}</b></span>
    </label>
  `).join("");
}

function updateEstimate() {
  const perEndpoint = state.probeIds.size * state.samplesPerProbe;
  const total = perEndpoint * (state.mode === "dual" ? 2 : 1);
  elements.requestCount.textContent = String(perEndpoint);
  elements.probeCount.textContent = `${state.probeIds.size} / ${TOTAL_PROBE_SLOTS}`;
  const labels = {
    single: ["生成行为指纹", `预计 ${total} 次请求 · ${state.concurrency} 路并发`],
    dual: ["扫描并对比", `预计共 ${total} 次请求 · ${state.concurrency} 路并发`],
    history: ["与历史指纹对比", `预计 ${total} 次请求 · ${state.concurrency} 路并发`]
  };
  [elements.runLabel.textContent, elements.runSubLabel.textContent] = labels[state.mode];
}

function switchMode(mode) {
  if (state.running) return;
  state.mode = mode;
  document.querySelectorAll(".mode-tab").forEach((tab) => {
    const active = tab.dataset.mode === mode;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  const dual = mode === "dual";
  const history = mode === "history";
  elements.endpointGrid.classList.toggle("dual", dual || history);
  elements.endpointBCard.classList.toggle("hidden", !dual);
  elements.historyPicker.classList.toggle("hidden", !history);
  elements.form.elements.urlB.required = dual;
  document.querySelector("#endpointATitle").textContent = history ? "新采样端点" : "待测端点";
  updateEstimate();
}

function applyPreset(presetId) {
  const preset = PRESETS[presetId];
  if (!preset) return;
  state.preset = presetId;
  state.samplesPerProbe = preset.samplesPerProbe;
  elements.samplesPerProbe.value = String(preset.samplesPerProbe);
  state.probeIds = new Set(preset.probeIds);
  state.customProbe = null;
  elements.enableCustomProbe.checked = false;
  elements.customProbeFields.classList.add("hidden");
  elements.customProbeError.textContent = "";
  document.querySelectorAll(".preset-card").forEach((label) => {
    label.classList.toggle("selected", label.querySelector("input").value === presetId);
  });
  renderProbes();
  updateEstimate();
}

function renderHistorySelect() {
  const current = elements.historySelect.value;
  elements.historySelect.innerHTML = `<option value="">请选择一条历史记录</option>${state.histories
    .map((history) => `<option value="${escapeHtml(history.id)}">${escapeHtml(history.label)} · ${escapeHtml(history.fingerprint.signature)}</option>`)
    .join("")}`;
  if (state.histories.some((history) => history.id === current)) elements.historySelect.value = current;
  renderHistoryPreview();
}

function renderHistoryPreview() {
  const history = state.histories.find((item) => item.id === elements.historySelect.value);
  if (!history) {
    elements.historyPreview.innerHTML = `<div class="empty-orbit"><span>H</span></div><p>选择一条历史结果后，这里会显示它的采样规模与指纹摘要。</p>`;
    return;
  }
  elements.historyPreview.innerHTML = `
    <span class="identity-label">REFERENCE SIGNATURE</span>
    <strong>${escapeHtml(history.fingerprint.signature)}</strong>
    <div class="preview-meta"><span class="protocol-badge ${history.protocol}">${PROTOCOL_LABELS[history.protocol]}</span>${escapeHtml(history.label)} · ${history.fingerprint.dimensions.length} 维 · ${history.fingerprint.valid} 个有效样本 · ${history.concurrency || CONCURRENCY_LIMITS.default} 路</div>
    <p>${escapeHtml(history.model || "未指定模型 ID")}<br>${escapeHtml(history.url || "未记录端点")}${history.customProbe ? `<br>自定义探针：${escapeHtml(history.customProbe.label)}` : ""}</p>
  `;
}

function syncExperimentToHistory(history) {
  if (!history) return;
  state.preset = "custom";
  document.querySelectorAll(".preset-card").forEach((label) => label.classList.remove("selected"));
  state.probeIds = new Set((history.probeIds ?? []).filter((probeId) => getProbe(probeId)));
  if (Number.isInteger(history.samplesPerProbe)) {
    state.samplesPerProbe = Math.max(SAMPLE_LIMITS.min, Math.min(SAMPLE_LIMITS.max, history.samplesPerProbe));
    elements.samplesPerProbe.value = String(state.samplesPerProbe);
  }
  const historyConcurrency = Number.isInteger(history.concurrency) ? history.concurrency : CONCURRENCY_LIMITS.default;
  state.concurrency = Math.max(CONCURRENCY_LIMITS.min, Math.min(CONCURRENCY_LIMITS.max, historyConcurrency));
  elements.requestConcurrency.value = String(state.concurrency);
  renderProbes();

  if (!history.customProbe) {
    elements.enableCustomProbe.checked = false;
    updateCustomProbe();
    return;
  }
  elements.customProbeLabel.value = history.customProbe.label;
  elements.customProbePrompt.value = history.customProbe.prompt;
  elements.customProbeOptions.value = history.customProbe.options.join("\n");
  elements.enableCustomProbe.checked = true;
  updateCustomProbe({ showError: true });
}

function formatDate(timestamp) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(timestamp));
}

function renderHistory() {
  elements.historyCount.textContent = `${state.histories.length} 条记录`;
  elements.clearHistory.disabled = state.histories.length === 0;
  if (!state.histories.length) {
    elements.historyList.innerHTML = document.querySelector("#emptyHistoryTemplate").innerHTML;
    renderHistorySelect();
    return;
  }
  elements.historyList.innerHTML = state.histories.map((history) => `
    <article class="history-card" data-id="${escapeHtml(history.id)}">
      <header><span class="history-type">BEHAVIOR PRINT · ${PROTOCOL_LABELS[history.protocol]}</span><time>${formatDate(history.createdAt)}</time></header>
      <h3>${escapeHtml(history.label)}</h3>
      <div class="history-endpoint">${escapeHtml(history.model || "未指定模型 ID")} · ${history.concurrency || CONCURRENCY_LIMITS.default} 路并发<br>${escapeHtml(history.url || "未记录端点")}</div>
      <div class="history-hash">${escapeHtml(history.fingerprint.signature)}</div>
      <div class="history-meta">
        <div><span>维度</span><b>${history.fingerprint.dimensions.length}</b></div>
        <div><span>有效率</span><b>${formatPercent(history.fingerprint.validRate)}</b></div>
        <div><span>偏置</span><b>${formatPercent(history.fingerprint.biasStrength)}</b></div>
      </div>
      <footer>
        <button type="button" data-action="compare">作为基线</button>
        <button type="button" data-action="view">查看</button>
        <button type="button" class="delete-history" data-action="delete">删除</button>
      </footer>
    </article>
  `).join("");
  renderHistorySelect();
}

function getEndpoint(suffix) {
  const form = elements.form.elements;
  return {
    label: form[`label${suffix}`].value.trim() || `端点 ${suffix}`,
    protocol: form[`protocol${suffix}`].value,
    url: form[`url${suffix}`].value.trim(),
    key: form[`key${suffix}`].value.trim(),
    model: form[`model${suffix}`].value.trim()
  };
}

function updateProtocolUi(suffix) {
  const form = elements.form.elements;
  const protocol = form[`protocol${suffix}`].value;
  const copy = PROTOCOL_UI[protocol];
  document.querySelector(`#urlHint${suffix}`).textContent = copy.urlHint;
  document.querySelector(`#keyHint${suffix}`).textContent = copy.keyHint;
  form[`url${suffix}`].placeholder = copy.urlPlaceholder;
  form[`key${suffix}`].placeholder = copy.keyPlaceholder;
  form[`model${suffix}`].placeholder = copy.modelPlaceholder;
  const status = document.querySelector(`#endpoint${suffix}Status`);
  status.textContent = protocol === "anthropic"
    ? "使用 Messages 格式与 x-api-key；模型 ID 必填，Key 不会持久化。"
    : "使用 Chat Completions 格式与 Bearer Key；Key 不会持久化。";
  status.className = "field-note";
}

function validateExperiment() {
  elements.formError.textContent = "";
  if (elements.enableCustomProbe.checked && !updateCustomProbe({ showError: true })) {
    return "请完善自定义随机 Prompt。";
  }
  if (!state.probeIds.size) return "请至少选择一个指纹探针。";
  if (!Number.isInteger(state.samplesPerProbe) || state.samplesPerProbe < SAMPLE_LIMITS.min || state.samplesPerProbe > SAMPLE_LIMITS.max) {
    return `每个探针的采样次数需在 ${SAMPLE_LIMITS.min} 到 ${SAMPLE_LIMITS.max} 之间。`;
  }
  if (!Number.isInteger(state.concurrency) || state.concurrency < CONCURRENCY_LIMITS.min || state.concurrency > CONCURRENCY_LIMITS.max) {
    return `异步并发请求数需在 ${CONCURRENCY_LIMITS.min} 到 ${CONCURRENCY_LIMITS.max} 之间。`;
  }
  const endpointA = getEndpoint("A");
  try { new URL(endpointA.url); } catch { return "请输入有效的端点 A 模型 URL。"; }
  if (endpointA.protocol === "anthropic" && !endpointA.model) return "Anthropic 端点 A 必须填写模型 ID。";
  if (state.mode === "dual") {
    const endpointB = getEndpoint("B");
    try { new URL(endpointB.url); } catch { return "请输入有效的端点 B 模型 URL。"; }
    if (endpointB.protocol === "anthropic" && !endpointB.model) return "Anthropic 端点 B 必须填写模型 ID。";
  }
  if (state.mode === "history" && !state.histories.some((history) => history.id === elements.historySelect.value)) {
    return "请选择一条历史指纹作为对比基线。";
  }
  return "";
}

function resetConsole() {
  elements.progressBar.style.width = "0%";
  elements.progressText.textContent = "0 / 0";
  elements.validText.textContent = "0";
  elements.livePeak.textContent = "—";
  elements.eventLog.innerHTML = "";
  elements.liveGrid.innerHTML = [...state.probeIds].map((probeId) => {
    const probe = activeProbe(probeId);
    return `<article class="live-probe" data-probe="${probeId}"><header><span>${escapeHtml(probe.shortLabel)}</span><span>0</span></header><b>—</b></article>`;
  }).join("");
}

function logEvent(message, isError = false) {
  const row = document.createElement("p");
  row.className = isError ? "log-error" : "";
  row.textContent = `[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] ${message}`;
  elements.eventLog.prepend(row);
  while (elements.eventLog.children.length > 12) elements.eventLog.lastElementChild.remove();
}

function liveDimension(samples, probeId) {
  const fingerprint = buildFingerprint({ probeIds: [probeId], samples, probes: state.customProbe ? [state.customProbe] : [] });
  return fingerprint.dimensions[0];
}

function updateLiveConsole(event, samples, totalOffset, grandTotal) {
  const completed = totalOffset + event.completed;
  updateExperimentVisuals(completed, grandTotal, elements.activeEndpoint.textContent);
  elements.progressText.textContent = `${completed} / ${grandTotal}`;
  elements.progressBar.style.width = `${(completed / grandTotal) * 100}%`;
  const valid = Object.values(samples).flat().filter((sample) => sample.value).length;
  elements.validText.textContent = String(valid);
  document.querySelectorAll(".live-probe").forEach((card) => card.classList.remove("active"));
  const card = elements.liveGrid.querySelector(`[data-probe="${event.probeId}"]`);
  if (card) {
    card.classList.add("active");
    const dimension = liveDimension(samples, event.probeId);
    card.querySelector("header span:last-child").textContent = String(dimension.total);
    card.querySelector("b").textContent = dimension.dominant;
  }
  const fingerprint = buildFingerprint({ probeIds: [...state.probeIds], samples, probes: state.customProbe ? [state.customProbe] : [] });
  elements.livePeak.textContent = fingerprint.peak.share ? `${fingerprint.peak.value} · ${formatPercent(fingerprint.peak.share)}` : "—";
}

async function readNdjson(response, onEvent) {
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `请求失败：HTTP ${response.status}`);
  }
  if (!response.body) throw new Error("浏览器不支持流式响应");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (line.trim()) onEvent(JSON.parse(line));
    }
    if (done) break;
  }
  if (buffer.trim()) onEvent(JSON.parse(buffer));
}

async function sampleEndpoint(endpoint, tag, totalOffset, grandTotal, concurrency) {
  const probeIds = [...state.probeIds];
  const samples = Object.fromEntries(probeIds.map((probeId) => [probeId, []]));
  const errors = [];
  elements.activeEndpoint.textContent = `${tag} · ${concurrency} 路`;
  elements.consoleTitle.textContent = `正在采集端点 ${tag} 的行为信号`;
  updateExperimentVisuals(totalOffset, grandTotal, tag);
  logEvent(`端点 ${tag} 开始采样：${endpoint.label}`);

  const response = await fetch("/api/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      endpoint,
      probeIds,
      samplesPerProbe: state.samplesPerProbe,
      concurrency,
      customProbe: state.customProbe
    }),
    signal: state.abortController.signal
  });

  let fatalMessage = "";
  await readNdjson(response, (event) => {
    if (event.type === "sample") {
      samples[event.probeId].push({ value: event.value, raw: event.raw, latencyMs: event.latencyMs });
      updateLiveConsole(event, samples, totalOffset, grandTotal);
      logEvent(`${activeProbe(event.probeId).shortLabel} → ${event.value || `未解析：${event.raw}`}`);
    } else if (event.type === "sample_error") {
      samples[event.probeId].push({ value: null, error: event.message, latencyMs: event.latencyMs });
      errors.push(event.message);
      updateLiveConsole(event, samples, totalOffset, grandTotal);
      logEvent(`${activeProbe(event.probeId).shortLabel} 请求失败：${event.message}`, true);
    } else if (event.type === "fatal") {
      fatalMessage = event.message;
    }
  });
  if (fatalMessage) throw new Error(fatalMessage);
  const fingerprint = buildFingerprint({ probeIds, samples, probes: state.customProbe ? [state.customProbe] : [] });
  if (!fingerprint.valid) throw new Error(errors[0] || "没有得到可解析的模型回答");
  logEvent(`端点 ${tag} 完成，指纹 ${fingerprint.signature}`);
  return { endpoint, samples, fingerprint, errors, concurrency };
}

function makeHistoryRecord(run) {
  return {
    id: uid(),
    createdAt: Date.now(),
    label: run.endpoint.label,
    protocol: run.endpoint.protocol,
    url: sanitizeUrl(run.endpoint.url),
    model: run.endpoint.model,
    preset: state.preset,
    samplesPerProbe: state.samplesPerProbe,
    concurrency: run.concurrency,
    probeIds: [...state.probeIds],
    customProbe: state.customProbe,
    fingerprint: run.fingerprint
  };
}

function saveRunHistory(run) {
  const record = makeHistoryRecord(run);
  state.histories.unshift(record);
  state.histories = state.histories.slice(0, MAX_HISTORY);
  persistHistories();
  renderHistory();
  return record;
}

function summaryStats(fingerprint) {
  return `
    <div class="summary-stats">
      <div class="summary-stat"><span>有效样本</span><strong>${fingerprint.valid}</strong><small>总请求 ${fingerprint.total}</small></div>
      <div class="summary-stat"><span>有效解析率</span><strong>${formatPercent(fingerprint.validRate)}</strong><small>格式遵循程度</small></div>
      <div class="summary-stat"><span>平均偏置强度</span><strong>${formatPercent(fingerprint.biasStrength)}</strong><small>1 − 归一化熵</small></div>
      <div class="summary-stat"><span>最强偏好</span><strong>${escapeHtml(fingerprint.peak.value)}</strong><small>${escapeHtml(fingerprint.peak.label)} · ${formatPercent(fingerprint.peak.share)}</small></div>
    </div>`;
}

function dimensionBars(fingerprint) {
  return `<div class="dimension-bars">${fingerprint.dimensions.map((dimension) => `
    <div class="dimension-bar">
      <span>${escapeHtml(dimension.shortLabel)}</span>
      <div class="bar"><i style="width:${dimension.biasIndex * 100}%"></i></div>
      <b title="${escapeHtml(dimension.dominant)}">${escapeHtml(dimension.dominant)} · ${formatPercent(dimension.dominance)}</b>
    </div>`).join("")}</div>`;
}

function dimensionCards(fingerprint) {
  return `<div class="dimension-details">${fingerprint.dimensions.map((dimension) => `
    <article class="dimension-card">
      <header><div><span>${escapeHtml(dimension.glyph)} / DIMENSION</span><h4>${escapeHtml(dimension.label)}</h4></div><b>${escapeHtml(dimension.dominant)}</b></header>
      <div class="distribution-list">
        ${dimension.ranked.slice(0, 5).map((item) => `
          <div class="distribution-row"><span title="${escapeHtml(item.value)}">${escapeHtml(item.value)}</span><i style="--width:${item.share * 100}%"></i><b>${item.count} · ${formatPercent(item.share)}</b></div>
        `).join("") || `<span class="field-note">没有有效样本</span>`}
      </div>
      <div class="dimension-foot"><span>熵 ${dimension.entropy.toFixed(2)} bit</span><span>有效 ${dimension.valid}/${dimension.total}</span></div>
    </article>`).join("")}</div>`;
}

function renderSingleResult(run, record = null) {
  const fingerprint = run.fingerprint;
  elements.resultTitle.textContent = "行为指纹已生成";
  elements.resultContent.innerHTML = `
    <div class="fingerprint-summary">
      <aside class="fingerprint-identity">
        <span class="identity-label">MODEL BEHAVIOR ID · ${PROTOCOL_LABELS[run.endpoint.protocol] || "OpenAI"}</span>
        <h3>${escapeHtml(run.endpoint.label)}</h3>
        <p><span class="protocol-badge ${run.endpoint.protocol || "openai"}">${PROTOCOL_LABELS[run.endpoint.protocol] || "OpenAI"}</span>${escapeHtml(run.endpoint.model || "未指定模型 ID")}<br>${escapeHtml(sanitizeUrl(run.endpoint.url))}</p>
        <div class="hash-plate"><small>SIGNATURE HASH</small><strong>${escapeHtml(fingerprint.signature)}</strong></div>
        <div class="identity-meta">
          <div><span>采样规格</span><b>${state.samplesPerProbe} × ${fingerprint.dimensions.length} · ${run.concurrency || CONCURRENCY_LIMITS.default} 路</b></div>
          <div><span>生成时间</span><b>${formatDate(Date.now())}</b></div>
          <div><span>历史留存</span><b>${record ? "已保存" : "未保存"}</b></div>
        </div>
      </aside>
      <div class="summary-main">${summaryStats(fingerprint)}${dimensionBars(fingerprint)}</div>
    </div>
    ${dimensionCards(fingerprint)}
  `;
}

function runConcurrency(run) {
  return run.concurrency || CONCURRENCY_LIMITS.default;
}

function renderComparisonResult(left, right, comparison, sourceLabel = "实时端点") {
  elements.resultTitle.textContent = "行为指纹对比完成";
  elements.resultContent.innerHTML = `
    <div class="comparison-hero">
      <article class="compare-model">
        <div class="model-letter">A</div>
        <h3>${escapeHtml(left.endpoint.label)}</h3>
        <p><span class="protocol-badge ${left.endpoint.protocol || "openai"}">${PROTOCOL_LABELS[left.endpoint.protocol] || "OpenAI"}</span>${escapeHtml(left.endpoint.model || "未指定模型 ID")} · ${runConcurrency(left)} 路并发<br>${escapeHtml(sanitizeUrl(left.endpoint.url))}</p>
        <div class="compare-hash">${escapeHtml(left.fingerprint.signature)}</div>
      </article>
      <div class="comparison-score ${comparison.tone}">
        <div class="score-ring" style="--score:${comparison.similarity * 100}"><div><strong>${formatPercent(comparison.similarity)}</strong><span>SIMILARITY</span></div></div>
        <h3>${escapeHtml(comparison.verdict)}</h3>
        <p>距离 ${comparison.distance.toFixed(3)} · 采样置信度 ${formatPercent(comparison.confidence)}</p>
      </div>
      <article class="compare-model right">
        <div class="model-letter">${sourceLabel === "历史基线" ? "H" : "B"}</div>
        <h3>${escapeHtml(right.endpoint.label)}</h3>
        <p><span class="protocol-badge ${right.endpoint.protocol || "openai"}">${PROTOCOL_LABELS[right.endpoint.protocol] || "OpenAI"}</span>${escapeHtml(right.endpoint.model || "未指定模型 ID")} · ${runConcurrency(right)} 路并发<br>${escapeHtml(sanitizeUrl(right.endpoint.url))}</p>
        <div class="compare-hash">${escapeHtml(right.fingerprint.signature)}</div>
      </article>
    </div>
    <div class="compare-table">
      ${comparison.dimensions.map((dimension) => `
        <div class="compare-row">
          <span>${escapeHtml(dimension.label)}</span>
          <div class="choice">${escapeHtml(dimension.dominantA)} · ${formatPercent(dimension.dominanceA)}</div>
          <div class="distance">${dimension.distance.toFixed(3)}</div>
          <div class="choice right">${escapeHtml(dimension.dominantB)} · ${formatPercent(dimension.dominanceB)}</div>
        </div>`).join("")}
    </div>
  `;
}

function historyAsRun(history) {
  return {
    endpoint: { label: history.label, protocol: history.protocol || "openai", url: history.url, model: history.model },
    concurrency: history.concurrency || CONCURRENCY_LIMITS.default,
    fingerprint: history.fingerprint,
    samples: {}
  };
}

async function runExperiment(event) {
  event.preventDefault();
  const validationError = validateExperiment();
  if (validationError) {
    elements.formError.textContent = validationError;
    return;
  }

  state.running = true;
  state.abortController = new AbortController();
  elements.runButton.disabled = true;
  elements.formError.textContent = "";
  elements.results.classList.add("hidden");
  elements.runConsole.classList.remove("hidden");
  resetConsole();

  const perEndpoint = state.probeIds.size * state.samplesPerProbe;
  const grandTotal = perEndpoint * (state.mode === "dual" ? 2 : 1);
  const experimentConcurrency = state.concurrency;
  startExperimentVisuals(grandTotal);
  elements.runConsole.scrollIntoView({ behavior: "smooth", block: "start" });
  try {
    const runA = await sampleEndpoint(getEndpoint("A"), "A", 0, grandTotal, experimentConcurrency);
    let savedA = null;
    if (document.querySelector("#saveHistory").checked) savedA = saveRunHistory(runA);

    if (state.mode === "single") {
      state.latestResult = { type: "single", run: runA, historyId: savedA?.id };
      renderSingleResult(runA, savedA);
    } else if (state.mode === "dual") {
      const runB = await sampleEndpoint(getEndpoint("B"), "B", perEndpoint, grandTotal, experimentConcurrency);
      let savedB = null;
      if (document.querySelector("#saveHistory").checked) savedB = saveRunHistory(runB);
      const comparison = compareFingerprints(runA.fingerprint, runB.fingerprint);
      state.latestResult = { type: "comparison", left: runA, right: runB, comparison, historyIds: [savedA?.id, savedB?.id] };
      renderComparisonResult(runA, runB, comparison);
    } else {
      const history = state.histories.find((item) => item.id === elements.historySelect.value);
      const historyRun = historyAsRun(history);
      const comparison = compareFingerprints(runA.fingerprint, history.fingerprint);
      state.latestResult = { type: "comparison", left: runA, right: historyRun, comparison, historyId: history.id };
      renderComparisonResult(runA, historyRun, comparison, "历史基线");
    }

    elements.progressBar.style.width = "100%";
    updateExperimentVisuals(grandTotal, grandTotal, elements.activeEndpoint.textContent);
    elements.consoleTitle.textContent = "采样完成，统计证据已生成";
    setTimeout(() => {
      elements.runConsole.classList.add("hidden");
      elements.results.classList.remove("hidden");
      elements.results.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 500);
  } catch (error) {
    if (error.name === "AbortError") {
      elements.formError.textContent = "实验已终止。";
      logEvent("用户终止了本次实验。", true);
    } else {
      elements.formError.textContent = error.message;
      logEvent(error.message, true);
    }
  } finally {
    state.running = false;
    stopExperimentVisuals();
    elements.runButton.disabled = false;
    state.abortController = null;
  }
}

async function loadModels(suffix) {
  const normalizedSuffix = suffix.toUpperCase();
  const status = document.querySelector(`#endpoint${normalizedSuffix}Status`);
  const endpoint = getEndpoint(normalizedSuffix);
  if (!endpoint.url) {
    status.textContent = "请先填写模型 URL。";
    status.className = "field-note error";
    return;
  }
  status.textContent = "正在读取模型列表…";
  status.className = "field-note";
  try {
    const response = await fetch("/api/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: endpoint.url, key: endpoint.key, protocol: endpoint.protocol })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "读取模型列表失败");
    const datalist = document.querySelector(`#models${normalizedSuffix}`);
    datalist.innerHTML = data.models.map((model) => `<option value="${escapeHtml(model)}"></option>`).join("");
    if (data.models.length === 1 && !elements.form.elements[`model${normalizedSuffix}`].value) {
      elements.form.elements[`model${normalizedSuffix}`].value = data.models[0];
    }
    status.textContent = data.models.length ? `已读取 ${data.models.length} 个模型，可在输入框选择。` : "端点未返回可用模型，请手动输入模型 ID。";
    status.className = "field-note success";
  } catch (error) {
    status.textContent = error.message;
    status.className = "field-note error";
  }
}

function exportLatestResult() {
  if (!state.latestResult) return;
  const clean = JSON.parse(JSON.stringify(state.latestResult));
  const stripKey = (run) => { if (run?.endpoint) delete run.endpoint.key; };
  stripKey(clean.run);
  stripKey(clean.left);
  stripKey(clean.right);
  const blob = new Blob([JSON.stringify(clean, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `model-fingerprint-${Date.now()}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function showHistory(history) {
  state.latestResult = { type: "single", run: historyAsRun(history), historyId: history.id };
  renderSingleResult(historyAsRun(history), history);
  elements.results.classList.remove("hidden");
  elements.results.scrollIntoView({ behavior: "smooth", block: "start" });
}

function compareFromHistory(history) {
  switchMode("history");
  elements.historySelect.value = history.id;
  syncExperimentToHistory(history);
  renderHistoryPreview();
  document.querySelector("#workspace").scrollIntoView({ behavior: "smooth", block: "start" });
}

document.querySelectorAll(".mode-tab").forEach((tab) => tab.addEventListener("click", () => switchMode(tab.dataset.mode)));
document.querySelectorAll('input[name="preset"]').forEach((input) => input.addEventListener("change", () => applyPreset(input.value)));
elements.samplesPerProbe.addEventListener("change", () => {
  const requested = Number(elements.samplesPerProbe.value);
  const normalized = Number.isFinite(requested)
    ? Math.max(SAMPLE_LIMITS.min, Math.min(SAMPLE_LIMITS.max, Math.round(requested)))
    : PRESETS.standard.samplesPerProbe;
  state.samplesPerProbe = normalized;
  elements.samplesPerProbe.value = String(normalized);
  state.preset = "custom";
  document.querySelectorAll(".preset-card").forEach((label) => label.classList.remove("selected"));
  updateEstimate();
});
elements.requestConcurrency.addEventListener("input", () => {
  const requested = Number(elements.requestConcurrency.value);
  if (Number.isInteger(requested) && requested >= CONCURRENCY_LIMITS.min && requested <= CONCURRENCY_LIMITS.max) {
    state.concurrency = requested;
    updateEstimate();
  }
});
elements.requestConcurrency.addEventListener("change", () => {
  const requested = Number(elements.requestConcurrency.value);
  const normalized = Number.isFinite(requested)
    ? Math.max(CONCURRENCY_LIMITS.min, Math.min(CONCURRENCY_LIMITS.max, Math.round(requested)))
    : CONCURRENCY_LIMITS.default;
  state.concurrency = normalized;
  elements.requestConcurrency.value = String(normalized);
  updateEstimate();
});
elements.enableCustomProbe.addEventListener("change", () => {
  state.preset = "custom";
  document.querySelectorAll(".preset-card").forEach((label) => label.classList.remove("selected"));
  updateCustomProbe({ showError: elements.enableCustomProbe.checked });
});
[elements.customProbeLabel, elements.customProbePrompt, elements.customProbeOptions].forEach((input) => {
  input.addEventListener("input", () => updateCustomProbe());
  input.addEventListener("change", () => updateCustomProbe({ showError: true }));
});
elements.probeGrid.addEventListener("change", (event) => {
  if (!event.target.matches('input[type="checkbox"]')) return;
  if (event.target.checked) state.probeIds.add(event.target.value);
  else state.probeIds.delete(event.target.value);
  state.preset = "custom";
  document.querySelectorAll(".preset-card").forEach((label) => label.classList.remove("selected"));
  updateEstimate();
});
document.querySelectorAll(".reveal-secret").forEach((button) => button.addEventListener("click", () => {
  const input = elements.form.elements[button.dataset.for];
  input.type = input.type === "password" ? "text" : "password";
  button.textContent = input.type === "password" ? "显示" : "隐藏";
}));
document.querySelectorAll(".load-models").forEach((button) => button.addEventListener("click", () => loadModels(button.dataset.endpoint)));
document.querySelectorAll('input[name^="protocol"]').forEach((input) => input.addEventListener("change", () => updateProtocolUi(input.name.at(-1))));
elements.historySelect.addEventListener("change", () => {
  const history = state.histories.find((item) => item.id === elements.historySelect.value);
  if (state.mode === "history") syncExperimentToHistory(history);
  renderHistoryPreview();
});
elements.form.addEventListener("submit", runExperiment);
document.querySelector("#cancelRun").addEventListener("click", () => state.abortController?.abort());
document.querySelector("#exportResult").addEventListener("click", exportLatestResult);
document.querySelector("#newExperiment").addEventListener("click", () => {
  elements.results.classList.add("hidden");
  document.querySelector("#workspace").scrollIntoView({ behavior: "smooth", block: "start" });
});
document.querySelector("#jumpHistory").addEventListener("click", () => document.querySelector("#history").scrollIntoView({ behavior: "smooth" }));
elements.clearHistory.addEventListener("click", () => {
  if (!state.histories.length || !confirm("确定删除全部本地历史指纹吗？此操作不可撤销。")) return;
  state.histories = [];
  persistHistories();
  renderHistory();
});
elements.historyList.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const card = button.closest("[data-id]");
  const history = state.histories.find((item) => item.id === card.dataset.id);
  if (!history) return;
  if (button.dataset.action === "view") showHistory(history);
  if (button.dataset.action === "compare") compareFromHistory(history);
  if (button.dataset.action === "delete") {
    state.histories = state.histories.filter((item) => item.id !== history.id);
    persistHistories();
    renderHistory();
  }
});

document.querySelectorAll("#openMethod, #openHelp").forEach((button) => button.addEventListener("click", () => elements.methodDialog.showModal()));
document.querySelector(".dialog-close").addEventListener("click", () => elements.methodDialog.close());
elements.methodDialog.addEventListener("click", (event) => {
  const rect = elements.methodDialog.getBoundingClientRect();
  const outside = event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
  if (outside) elements.methodDialog.close();
});

const observer = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (entry.isIntersecting) {
      entry.target.classList.add("visible");
      observer.unobserve(entry.target);
    }
  });
}, { threshold: 0.08 });
document.querySelectorAll(".reveal").forEach((element) => observer.observe(element));

renderProbes();
renderHistory();
updateProtocolUi("A");
updateProtocolUi("B");
renderFavicon();
updateEstimate();
