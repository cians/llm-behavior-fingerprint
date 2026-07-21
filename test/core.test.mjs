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
import { buildChatCompletionsUrl, buildModelsUrl, buildProbeRequestBody } from "../server.mjs";

test("normalizes common OpenAI-compatible endpoint forms", () => {
  assert.equal(buildChatCompletionsUrl("https://api.example.com").href, "https://api.example.com/v1/chat/completions");
  assert.equal(buildChatCompletionsUrl("https://api.example.com/v1/").href, "https://api.example.com/v1/chat/completions");
  assert.equal(
    buildChatCompletionsUrl("https://openrouter.example/api/v1/chat/completions").href,
    "https://openrouter.example/api/v1/chat/completions"
  );
  assert.equal(buildModelsUrl("https://api.example.com/v1").href, "https://api.example.com/v1/models");
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
  const body = buildProbeRequestBody({ model: "example-model" }, getProbe("number"));
  assert.deepEqual(body.messages, [
    { role: "user", content: "Choose one random integer from 1 to 100. Return only the integer." }
  ]);
  assert.equal(body.messages.some((message) => message.role === "system"), false);
  assert.doesNotMatch(JSON.stringify(body), /test|fingerprint|behavioral/i);
});

test("every sample builds a fresh stateless chat request", () => {
  const endpoint = { model: "example-model" };
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
