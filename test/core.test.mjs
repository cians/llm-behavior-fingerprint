import test from "node:test";
import assert from "node:assert/strict";
import {
  PRESETS,
  PROBES,
  SAMPLE_LIMITS,
  TOTAL_PROBE_SLOTS,
  buildFingerprint,
  compareFingerprints,
  createCustomProbe,
  getProbe,
  jensenShannonDistance,
  parseProbeAnswer
} from "../public/core.js";
import {
  CONCURRENCY_LIMITS,
  buildAnthropicMessagesUrl,
  buildChatCompletionsUrl,
  buildModelsUrl,
  buildProbeRequestBody,
  extractAssistantText,
  normalizeConcurrency,
  normalizeProtocol,
  runWithConcurrency,
  upstreamHeaders
} from "../server.mjs";

test("normalizes common OpenAI-compatible endpoint forms", () => {
  assert.equal(buildChatCompletionsUrl("https://api.example.com").href, "https://api.example.com/v1/chat/completions");
  assert.equal(buildChatCompletionsUrl("https://api.example.com/v1/").href, "https://api.example.com/v1/chat/completions");
  assert.equal(
    buildChatCompletionsUrl("https://openrouter.example/api/v1/chat/completions").href,
    "https://openrouter.example/api/v1/chat/completions"
  );
  assert.equal(buildModelsUrl("https://api.example.com/v1").href, "https://api.example.com/v1/models");
});

test("normalizes common Anthropic Messages endpoint forms", () => {
  assert.equal(buildAnthropicMessagesUrl("https://api.example.com").href, "https://api.example.com/v1/messages");
  assert.equal(buildAnthropicMessagesUrl("https://api.example.com/v1/").href, "https://api.example.com/v1/messages");
  assert.equal(
    buildAnthropicMessagesUrl("https://gateway.example/anthropic/v1/messages").href,
    "https://gateway.example/anthropic/v1/messages"
  );
  assert.equal(buildModelsUrl("https://api.example.com/v1/messages", "anthropic").href, "https://api.example.com/v1/models");
});

test("normalizes protocols and defaults old callers to OpenAI", () => {
  assert.equal(normalizeProtocol(), "openai");
  assert.equal(normalizeProtocol("ANTHROPIC"), "anthropic");
  assert.throws(() => normalizeProtocol("responses"), /OpenAI 或 Anthropic/);
});

test("normalizes bounded request concurrency", () => {
  assert.equal(normalizeConcurrency(), CONCURRENCY_LIMITS.default);
  assert.equal(normalizeConcurrency(1), 1);
  assert.equal(normalizeConcurrency("10"), 10);
  assert.throws(() => normalizeConcurrency(0), /并发请求数/);
  assert.throws(() => normalizeConcurrency(11), /并发请求数/);
  assert.throws(() => normalizeConcurrency(2.5), /并发请求数/);
});

test("bounded concurrency runs tasks in parallel without reusing items", async () => {
  const items = Array.from({ length: 10 }, (_, index) => ({ index }));
  const seen = [];
  let active = 0;
  let peak = 0;

  await runWithConcurrency(items, 4, async (item) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 8));
    seen.push(item);
    active -= 1;
  });

  assert.equal(peak, 4);
  assert.equal(seen.length, items.length);
  assert.equal(new Set(seen).size, items.length);
  assert.deepEqual(seen.map((item) => item.index).sort((a, b) => a - b), items.map((item) => item.index));
});

test("bounded concurrency stops assigning new work after a worker fails", async () => {
  const started = [];
  await assert.rejects(
    runWithConcurrency(Array.from({ length: 12 }, (_, index) => index), 4, async (item) => {
      started.push(item);
      if (item === 1) throw new Error("stop");
      await new Promise((resolve) => setTimeout(resolve, 12));
    }),
    /stop/
  );
  assert.ok(started.length <= 4);
});

test("builds protocol-specific authentication headers", () => {
  assert.deepEqual(upstreamHeaders("openai-key", "openai"), {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: "Bearer openai-key"
  });
  assert.deepEqual(upstreamHeaders("anthropic-key", "anthropic"), {
    "Content-Type": "application/json",
    Accept: "application/json",
    "anthropic-version": "2023-06-01",
    "x-api-key": "anthropic-key"
  });
});

test("extracts only final Anthropic text blocks", () => {
  const response = {
    content: [
      { type: "thinking", thinking: "hidden reasoning 47" },
      { type: "redacted_thinking", data: "opaque" },
      { type: "text", text: "73" },
      { type: "tool_use", name: "irrelevant", input: {} }
    ]
  };
  assert.equal(extractAssistantText(response, "anthropic"), "73");
  assert.equal(extractAssistantText({ content: [{ type: "thinking", thinking: "47" }] }, "anthropic"), "");
});

test("parses constrained answers without accepting unrelated text", () => {
  assert.equal(parseProbeAnswer("number", "I choose 73."), "73");
  assert.equal(parseProbeAnswer("color", "Blue"), "blue");
  assert.equal(parseProbeAnswer("city", "New York."), "New York");
  assert.equal(parseProbeAnswer("letter", "Letter Q"), "Q");
  assert.equal(parseProbeAnswer("number", "zero"), null);
});

test("identical distributions have zero Jensen-Shannon distance", () => {
  const probeIds = ["color"];
  const first = buildFingerprint({ probeIds, samples: { color: ["blue", "blue", "red"] } });
  const second = buildFingerprint({ probeIds, samples: { color: ["blue", "blue", "red"] } });
  assert.equal(jensenShannonDistance(first.dimensions[0], second.dimensions[0]), 0);
  assert.equal(compareFingerprints(first, second).similarity, 1);
});

test("disjoint distributions are maximally distant", () => {
  const probeIds = ["color"];
  const first = buildFingerprint({ probeIds, samples: { color: ["blue", "blue", "blue"] } });
  const second = buildFingerprint({ probeIds, samples: { color: ["red", "red", "red"] } });
  assert.equal(jensenShannonDistance(first.dimensions[0], second.dimensions[0]), 1);
});

test("signature encodes the full probability distribution", () => {
  const first = buildFingerprint({ probeIds: ["color"], samples: { color: ["blue", "blue", "red", "green"] } });
  const second = buildFingerprint({ probeIds: ["color"], samples: { color: ["blue", "blue", "red", "yellow"] } });
  assert.equal(first.dimensions[0].dominant, second.dimensions[0].dominant);
  assert.equal(first.dimensions[0].dominance, second.dimensions[0].dominance);
  assert.notEqual(first.signature, second.signature);
  assert.equal(first.version, 2);
});

test("finite samples are not mistaken for bias only because the option space is larger", () => {
  const values = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"];
  const fingerprint = buildFingerprint({ probeIds: ["number"], samples: { number: values } });
  const dimension = fingerprint.dimensions[0];
  assert.equal(dimension.normalizedEntropy, 1);
  assert.equal(dimension.biasIndex, 0);
  assert.equal(fingerprint.biasStrength, 0);
});

test("all configured probes expose options", () => {
  assert.equal(PROBES.length, 9);
  assert.equal(TOTAL_PROBE_SLOTS, 10);
  assert.equal(PROBES.some((probe) => probe.id === "coin"), false);
  for (const probe of PROBES) {
    assert.equal(getProbe(probe.id), probe);
    assert.ok(probe.options.length >= 2);
  }
});

test("custom probes use a stable definition id and produce a distribution", () => {
  const input = {
    label: "随机饮品",
    prompt: "Choose one drink: tea, coffee, water. Return only one listed word.",
    options: ["tea", "coffee", "water"]
  };
  const first = createCustomProbe(input);
  const second = createCustomProbe({ ...input, label: "另一个显示名称" });
  assert.equal(first.id, second.id);
  assert.match(first.id, /^custom-[0-9a-f]{8}$/);
  assert.equal(parseProbeAnswer(first, "Coffee."), "coffee");

  const fingerprint = buildFingerprint({
    probeIds: [first.id],
    probes: [first],
    samples: { [first.id]: ["tea", "tea", "water"] }
  });
  assert.equal(fingerprint.dimensions[0].dominant, "tea");
  assert.equal(fingerprint.dimensions[0].dominance, 2 / 3);
});

test("different custom definitions are not treated as the same dimension", () => {
  const first = createCustomProbe({ label: "饮品", prompt: "Choose tea, coffee, or water.", options: ["tea", "coffee", "water"] });
  const second = createCustomProbe({ label: "天气", prompt: "Choose sun, rain, or snow.", options: ["sun", "rain", "snow"] });
  assert.notEqual(first.id, second.id);
});

test("sampling presets produce real distributions and allow larger custom runs", () => {
  assert.equal(SAMPLE_LIMITS.min, 10);
  assert.equal(SAMPLE_LIMITS.max, 100);
  assert.equal(PRESETS.quick.samplesPerProbe, 10);
  assert.equal(PRESETS.standard.samplesPerProbe, 20);
  assert.equal(PRESETS.deep.samplesPerProbe, 30);
});

test("probe requests do not reveal that the prompt is part of a test", () => {
  const body = buildProbeRequestBody({ protocol: "openai", model: "example-model" }, getProbe("number"));
  assert.deepEqual(body.messages, [
    { role: "user", content: "Choose one random integer from 1 to 100. Return only the integer." }
  ]);
  assert.equal(body.messages.some((message) => message.role === "system"), false);
  assert.doesNotMatch(JSON.stringify(body), /test|fingerprint|behavioral/i);
});

test("every sample builds a fresh stateless chat request", () => {
  const endpoint = { protocol: "openai", model: "example-model" };
  const probe = getProbe("number");
  const first = buildProbeRequestBody(endpoint, probe);
  const second = buildProbeRequestBody(endpoint, probe);

  assert.notEqual(first, second);
  assert.notEqual(first.messages, second.messages);
  assert.deepEqual(first.messages, [{ role: "user", content: probe.prompt }]);
  assert.deepEqual(second.messages, [{ role: "user", content: probe.prompt }]);
  for (const body of [first, second]) {
    assert.equal(body.messages.length, 1);
    assert.equal("previous_response_id" in body, false);
    assert.equal("conversation" in body, false);
    assert.equal("seed" in body, false);
  }
});

test("OpenAI and Anthropic requests are fresh, stateless, and protocol-correct", () => {
  const probe = getProbe("number");
  const endpoints = [
    { protocol: "openai", model: "openai-model" },
    { protocol: "anthropic", model: "claude-model" }
  ];

  for (const endpoint of endpoints) {
    const first = buildProbeRequestBody(endpoint, probe);
    const second = buildProbeRequestBody(endpoint, probe);
    assert.notEqual(first, second);
    assert.notEqual(first.messages, second.messages);
    assert.deepEqual(first.messages, [{ role: "user", content: probe.prompt }]);
    assert.equal(first.stream, false);
    assert.equal(first.temperature, 1);
    assert.equal(first.max_tokens, 256);
    assert.equal(first.model, endpoint.model);
    assert.equal("system" in first, false);
    assert.equal("container" in first, false);
    assert.equal("metadata" in first, false);
    assert.equal("previous_response_id" in first, false);
    assert.equal("conversation" in first, false);
    assert.equal("seed" in first, false);
  }
});

test("mock upstreams receive independent requests for both protocols", async (context) => {
  const http = await import("node:http");
  const seen = { openai: [], anthropic: [] };
  const active = { openai: 0, anthropic: 0 };
  const peak = { openai: 0, anthropic: 0 };
  const mock = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const protocol = request.url === "/v1/messages" ? "anthropic" : "openai";
    active[protocol] += 1;
    peak[protocol] = Math.max(peak[protocol], active[protocol]);
    seen[protocol].push(body);
    await new Promise((resolve) => setTimeout(resolve, 8));
    active[protocol] -= 1;
    response.setHeader("Content-Type", "application/json");
    response.end(protocol === "anthropic"
      ? JSON.stringify({ content: [{ type: "thinking", thinking: "99" }, { type: "text", text: "47" }] })
      : JSON.stringify({ choices: [{ message: { content: "47" } }] }));
  });
  await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
  context.after(() => mock.close());
  const { port } = mock.address();
  const probe = getProbe("number");

  for (const protocol of ["openai", "anthropic"]) {
    const path = protocol === "anthropic" ? "/v1/messages" : "/v1/chat/completions";
    await runWithConcurrency(Array.from({ length: 10 }), 4, async () => {
      const body = buildProbeRequestBody({ protocol, model: `${protocol}-model` }, probe);
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: upstreamHeaders(`${protocol}-key`, protocol),
        body: JSON.stringify(body)
      });
      const data = await response.json();
      assert.equal(extractAssistantText(data, protocol), "47");
    });
  }

  for (const protocol of ["openai", "anthropic"]) {
    assert.equal(peak[protocol], 4);
    assert.equal(seen[protocol].length, 10);
    assert.equal(new Set(seen[protocol]).size, 10);
    for (const body of seen[protocol]) {
      assert.deepEqual(body.messages, [{ role: "user", content: probe.prompt }]);
      assert.equal(body.messages.length, 1);
      assert.equal("system" in body, false);
      assert.equal("conversation" in body, false);
      assert.equal("container" in body, false);
      assert.equal("previous_response_id" in body, false);
    }
  }
});
