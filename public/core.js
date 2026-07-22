export const PROBES = [
  {
    id: "number",
    label: "随机整数",
    shortLabel: "数字",
    glyph: "01",
    prompt: "Choose one random integer from 1 to 100. Return only the integer.",
    options: Array.from({ length: 100 }, (_, index) => String(index + 1)),
    parser: "integer"
  },
  {
    id: "color",
    label: "随机颜色",
    shortLabel: "颜色",
    glyph: "CL",
    prompt: "Choose one random color from this list: red, orange, yellow, green, blue, purple, pink, black, white, brown. Return only one listed word.",
    options: ["red", "orange", "yellow", "green", "blue", "purple", "pink", "black", "white", "brown"]
  },
  {
    id: "animal",
    label: "随机动物",
    shortLabel: "动物",
    glyph: "AN",
    prompt: "Choose one random animal from this list: cat, dog, lion, tiger, elephant, dolphin, owl, fox, panda, horse. Return only one listed word.",
    options: ["cat", "dog", "lion", "tiger", "elephant", "dolphin", "owl", "fox", "panda", "horse"]
  },
  {
    id: "city",
    label: "随机城市",
    shortLabel: "城市",
    glyph: "CT",
    prompt: "Choose one random city from this list: Paris, London, Tokyo, New York, Rome, Beijing, Sydney, Cairo, Berlin, Rio. Return only one listed city.",
    options: ["Paris", "London", "Tokyo", "New York", "Rome", "Beijing", "Sydney", "Cairo", "Berlin", "Rio"]
  },
  {
    id: "letter",
    label: "随机字母",
    shortLabel: "字母",
    glyph: "AZ",
    prompt: "Choose one random letter from A to Z. Return only the uppercase letter.",
    options: "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""),
    parser: "letter"
  },
  {
    id: "weekday",
    label: "随机星期",
    shortLabel: "星期",
    glyph: "7D",
    prompt: "Choose one random weekday from this list: Monday, Tuesday, Wednesday, Thursday, Friday, Saturday, Sunday. Return only one listed word.",
    options: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
  },
  {
    id: "shape",
    label: "随机形状",
    shortLabel: "形状",
    glyph: "◇",
    prompt: "Choose one random shape from this list: circle, square, triangle, rectangle, star, hexagon, oval, diamond. Return only one listed word.",
    options: ["circle", "square", "triangle", "rectangle", "star", "hexagon", "oval", "diamond"]
  },
  {
    id: "fruit",
    label: "随机水果",
    shortLabel: "水果",
    glyph: "FR",
    prompt: "Choose one random fruit from this list: apple, banana, orange, strawberry, mango, grape, peach, watermelon, pear, cherry. Return only one listed word.",
    options: ["apple", "banana", "orange", "strawberry", "mango", "grape", "peach", "watermelon", "pear", "cherry"]
  },
  {
    id: "card",
    label: "随机扑克牌点数",
    shortLabel: "纸牌",
    glyph: "♠",
    prompt: "Choose one random playing-card rank from this list: A, 2, 3, 4, 5, 6, 7, 8, 9, 10, J, Q, K. Return only one listed rank.",
    options: ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"],
    parser: "card"
  }
];

export const PRESETS = {
  quick: {
    id: "quick",
    label: "快速扫描",
    description: "4 维 × 10 次",
    samplesPerProbe: 10,
    probeIds: PROBES.slice(0, 4).map((probe) => probe.id)
  },
  standard: {
    id: "standard",
    label: "标准指纹",
    description: "8 维 × 20 次",
    samplesPerProbe: 20,
    probeIds: PROBES.slice(0, 8).map((probe) => probe.id)
  },
  deep: {
    id: "deep",
    label: "深度采样",
    description: "9 固定维度 × 30 次",
    samplesPerProbe: 30,
    probeIds: PROBES.map((probe) => probe.id)
  }
};

export const SAMPLE_LIMITS = { min: 10, max: 100 };
export const CUSTOM_PROBE_LIMITS = { minOptions: 3, maxOptions: 50, maxPromptLength: 600 };
export const TOTAL_PROBE_SLOTS = PROBES.length + 1;

const PROBE_MAP = new Map(PROBES.map((probe) => [probe.id, probe]));

export function getProbe(id) {
  return PROBE_MAP.get(id);
}

export function createCustomProbe({ label, prompt, options }) {
  const normalizedLabel = String(label ?? "").trim();
  const normalizedPrompt = String(prompt ?? "").trim();
  const rawOptions = Array.isArray(options) ? options : String(options ?? "").split(/\r?\n/);
  const normalizedOptions = [];
  const seen = new Set();

  for (const rawOption of rawOptions) {
    const option = String(rawOption ?? "").normalize("NFKC").trim();
    if (!option) continue;
    if (option.length > 80) throw new TypeError("每个候选答案最多 80 个字符");
    const key = option.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalizedOptions.push(option);
  }

  if (!normalizedLabel) throw new TypeError("请填写自定义探针名称");
  if (normalizedLabel.length > 40) throw new TypeError("自定义探针名称最多 40 个字符");
  if (!normalizedPrompt) throw new TypeError("请填写自定义 Prompt");
  if (normalizedPrompt.length > CUSTOM_PROBE_LIMITS.maxPromptLength) {
    throw new TypeError(`自定义 Prompt 最多 ${CUSTOM_PROBE_LIMITS.maxPromptLength} 个字符`);
  }
  if (normalizedOptions.length < CUSTOM_PROBE_LIMITS.minOptions) {
    throw new TypeError(`请至少填写 ${CUSTOM_PROBE_LIMITS.minOptions} 个候选答案`);
  }
  if (normalizedOptions.length > CUSTOM_PROBE_LIMITS.maxOptions) {
    throw new TypeError(`候选答案最多 ${CUSTOM_PROBE_LIMITS.maxOptions} 个`);
  }

  const definition = JSON.stringify([
    normalizedPrompt,
    normalizedOptions.map((option) => option.toLocaleLowerCase())
  ]);

  return {
    id: `custom-${signatureHash(definition).toLowerCase()}`,
    label: normalizedLabel,
    shortLabel: normalizedLabel.slice(0, 6),
    glyph: "+",
    prompt: normalizedPrompt,
    options: normalizedOptions,
    custom: true
  };
}

function validImportedFingerprint(fingerprint) {
  return Boolean(
    fingerprint
    && typeof fingerprint === "object"
    && typeof fingerprint.signature === "string"
    && Array.isArray(fingerprint.dimensions)
    && fingerprint.dimensions.length
    && fingerprint.dimensions.every((dimension) => (
      typeof dimension?.id === "string"
      && Array.isArray(dimension.options)
      && dimension.options.length
      && dimension.counts
      && typeof dimension.counts === "object"
      && dimension.options.every((option) => Number.isFinite(Number(dimension.counts[option])))
    ))
  );
}

function importSources(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.histories)) return payload.histories;
  if (payload.type === "comparison") return [payload.left, payload.right];
  if (payload.type === "single" || payload.run) return [payload.run];
  return [payload];
}

export function extractImportableHistoryRecords(payload) {
  const experiment = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload.experiment ?? {}
    : {};
  const records = [];

  for (const source of importSources(payload)) {
    if (!source || typeof source !== "object" || !validImportedFingerprint(source.fingerprint)) continue;
    const endpoint = source.endpoint && typeof source.endpoint === "object" ? source.endpoint : source;
    const rawCustomProbe = source.customProbe ?? experiment.customProbe;
    let customProbe = null;
    if (rawCustomProbe) {
      try {
        customProbe = createCustomProbe(rawCustomProbe);
      } catch {
        continue;
      }
    }
    const rawProbeIds = Array.isArray(source.probeIds)
      ? source.probeIds
      : Array.isArray(experiment.probeIds)
        ? experiment.probeIds
        : source.fingerprint.dimensions.map((dimension) => dimension.id);
    const probeIds = rawProbeIds.filter((probeId) => typeof probeId === "string");
    const samplesPerProbe = Number.isInteger(source.samplesPerProbe)
      ? source.samplesPerProbe
      : Number.isInteger(experiment.samplesPerProbe)
        ? experiment.samplesPerProbe
        : null;
    records.push({
      createdAt: Number.isFinite(source.createdAt) ? source.createdAt : null,
      label: String(endpoint.label ?? "导入的行为指纹").trim() || "导入的行为指纹",
      protocol: endpoint.protocol === "anthropic" ? "anthropic" : "openai",
      url: String(endpoint.url ?? "").trim(),
      model: String(endpoint.model ?? "").trim(),
      preset: typeof source.preset === "string" ? source.preset : typeof experiment.preset === "string" ? experiment.preset : "imported",
      samplesPerProbe,
      concurrency: Number.isInteger(source.concurrency) ? source.concurrency : Number.isInteger(experiment.concurrency) ? experiment.concurrency : null,
      probeIds,
      customProbe,
      fingerprint: source.fingerprint
    });
  }

  return records;
}

function cleanAnswer(raw) {
  return String(raw ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/^[\s\"'`*_#]+|[\s\"'`*_#]+$/g, "")
    .replace(/[.!。！,，:：;；]+$/g, "")
    .trim();
}

export function parseProbeAnswer(probeOrId, raw) {
  const probe = typeof probeOrId === "string" ? getProbe(probeOrId) : probeOrId;
  if (!probe) return null;

  const cleaned = cleanAnswer(raw);
  const lower = cleaned.toLowerCase();

  if (probe.parser === "integer") {
    const match = cleaned.match(/(?:^|\D)(100|[1-9]\d?)(?:\D|$)/);
    return match && probe.options.includes(match[1]) ? match[1] : null;
  }

  if (probe.parser === "letter") {
    const exact = cleaned.match(/^[A-Za-z]$/);
    if (exact) return exact[0].toUpperCase();
    const named = cleaned.match(/(?:letter\s+)([A-Za-z])(?:\b|$)/i);
    return named ? named[1].toUpperCase() : null;
  }

  if (probe.parser === "card") {
    const exact = cleaned.toUpperCase();
    if (probe.options.includes(exact)) return exact;
    const match = cleaned.match(/(?:rank|card|choose|is)\s*[:\-]?\s*(10|[2-9AJQK])\b/i);
    return match ? match[1].toUpperCase() : null;
  }

  const exactOption = probe.options.find((option) => option.toLowerCase() === lower);
  if (exactOption) return exactOption;

  const alias = Object.entries(probe.aliases ?? {}).find(([candidate]) => candidate === lower);
  if (alias) return alias[1];

  const candidates = probe.options
    .map((option) => ({ option, index: lower.indexOf(option.toLowerCase()) }))
    .filter(({ index }) => index >= 0)
    .sort((a, b) => a.index - b.index || b.option.length - a.option.length);

  return candidates[0]?.option ?? null;
}

export function shannonEntropy(counts) {
  const values = Object.values(counts).filter((count) => count > 0);
  const total = values.reduce((sum, count) => sum + count, 0);
  if (!total) return 0;
  return values.reduce((entropy, count) => {
    const probability = count / total;
    return entropy - probability * Math.log2(probability);
  }, 0);
}

function signatureHash(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).toUpperCase().padStart(8, "0");
}

export function buildFingerprint({ probeIds, samples, probes = [] }) {
  const dynamicProbeMap = new Map(probes.map((probe) => [probe.id, probe]));
  const dimensions = probeIds
    .map((probeId) => getProbe(probeId) ?? dynamicProbeMap.get(probeId))
    .filter(Boolean)
    .map((probe) => {
      const entries = samples[probe.id] ?? [];
      const counts = Object.fromEntries(probe.options.map((option) => [option, 0]));

      for (const entry of entries) {
        const value = typeof entry === "string" ? entry : entry?.value;
        if (value && Object.hasOwn(counts, value)) counts[value] += 1;
      }

      const valid = Object.values(counts).reduce((sum, count) => sum + count, 0);
      const total = entries.length;
      const ranked = Object.entries(counts)
        .filter(([, count]) => count > 0)
        .sort((a, b) => b[1] - a[1] || probe.options.indexOf(a[0]) - probe.options.indexOf(b[0]));
      const dominant = ranked[0]?.[0] ?? "—";
      const dominantCount = ranked[0]?.[1] ?? 0;
      const entropy = shannonEntropy(counts);
      const observableSupport = Math.min(probe.options.length, valid);
      const maxEntropy = observableSupport > 1 ? Math.log2(observableSupport) : 0;
      const normalizedEntropy = maxEntropy ? entropy / maxEntropy : 0;
      const uniformShare = observableSupport ? 1 / observableSupport : 0;
      const dominance = valid ? dominantCount / valid : 0;
      const biasIndex = Math.max(0, Math.min(1, (dominance - uniformShare) / (1 - uniformShare)));

      return {
        id: probe.id,
        label: probe.label,
        shortLabel: probe.shortLabel,
        glyph: probe.glyph,
        options: probe.options,
        counts,
        total,
        valid,
        invalid: total - valid,
        validRate: total ? valid / total : 0,
        dominant,
        dominantCount,
        dominance,
        entropy,
        normalizedEntropy,
        biasIndex,
        ranked: ranked.map(([value, count]) => ({ value, count, share: valid ? count / valid : 0 }))
      };
    });

  const total = dimensions.reduce((sum, dimension) => sum + dimension.total, 0);
  const valid = dimensions.reduce((sum, dimension) => sum + dimension.valid, 0);
  const averageEntropy = dimensions.length
    ? dimensions.reduce((sum, dimension) => sum + dimension.normalizedEntropy, 0) / dimensions.length
    : 0;
  const peak = dimensions.reduce(
    (best, dimension) => (dimension.dominance > best.dominance ? dimension : best),
    { dominance: 0, dominant: "—", label: "—" }
  );
  const signatureSource = dimensions
    .map((dimension) => {
      const probabilities = dimension.options.map((option) => {
        const count = dimension.counts[option] ?? 0;
        return dimension.valid ? (count / dimension.valid).toFixed(6) : "0.000000";
      });
      return `${dimension.id}:${probabilities.join(",")}`;
    })
    .join("|");

  return {
    version: 2,
    dimensions,
    total,
    valid,
    validRate: total ? valid / total : 0,
    averageEntropy,
    biasStrength: 1 - averageEntropy,
    peak: { label: peak.label, value: peak.dominant, share: peak.dominance },
    signature: signatureHash(signatureSource)
  };
}

function distribution(dimension) {
  if (!dimension?.valid) return null;
  return dimension.options.map((option) => (dimension.counts[option] ?? 0) / dimension.valid);
}

export function jensenShannonDistance(dimensionA, dimensionB) {
  const probabilityA = distribution(dimensionA);
  const probabilityB = distribution(dimensionB);
  if (!probabilityA || !probabilityB || probabilityA.length !== probabilityB.length) return null;

  let divergence = 0;
  for (let index = 0; index < probabilityA.length; index += 1) {
    const p = probabilityA[index];
    const q = probabilityB[index];
    const midpoint = (p + q) / 2;
    if (p > 0) divergence += 0.5 * p * Math.log2(p / midpoint);
    if (q > 0) divergence += 0.5 * q * Math.log2(q / midpoint);
  }
  return Math.sqrt(Math.max(0, Math.min(1, divergence)));
}

export function compareFingerprints(fingerprintA, fingerprintB) {
  const dimensionsB = new Map(fingerprintB.dimensions.map((dimension) => [dimension.id, dimension]));
  const dimensions = fingerprintA.dimensions
    .filter((dimension) => dimensionsB.has(dimension.id))
    .map((dimensionA) => {
      const dimensionB = dimensionsB.get(dimensionA.id);
      const distance = jensenShannonDistance(dimensionA, dimensionB);
      return {
        id: dimensionA.id,
        label: dimensionA.label,
        shortLabel: dimensionA.shortLabel,
        glyph: dimensionA.glyph,
        distance,
        similarity: distance == null ? null : 1 - distance,
        dominantA: dimensionA.dominant,
        dominantB: dimensionB.dominant,
        dominanceA: dimensionA.dominance,
        dominanceB: dimensionB.dominance,
        validA: dimensionA.valid,
        validB: dimensionB.valid
      };
    });

  const comparable = dimensions.filter((dimension) => dimension.distance != null);
  const distance = comparable.length
    ? comparable.reduce((sum, dimension) => sum + dimension.distance, 0) / comparable.length
    : 1;
  const coverage = Math.min(
    1,
    comparable.length / Math.max(fingerprintA.dimensions.length, fingerprintB.dimensions.length, 1)
  );
  const meanSamples = comparable.length
    ? comparable.reduce((sum, dimension) => sum + Math.min(dimension.validA, dimension.validB), 0) / comparable.length
    : 0;
  const confidence = Math.min(1, Math.sqrt(meanSamples / 30) * coverage * Math.min(fingerprintA.validRate, fingerprintB.validRate));

  let verdict = "差异明显";
  let tone = "different";
  if (distance <= 0.25) {
    verdict = "高度一致";
    tone = "same";
  } else if (distance <= 0.42) {
    verdict = "行为相似";
    tone = "similar";
  } else if (distance <= 0.58) {
    verdict = "证据不足";
    tone = "uncertain";
  }

  return {
    distance,
    similarity: 1 - distance,
    confidence,
    coverage,
    verdict,
    tone,
    dimensions
  };
}

export function formatPercent(value, digits = 0) {
  return `${(Math.max(0, Math.min(1, Number(value) || 0)) * 100).toFixed(digits)}%`;
}
