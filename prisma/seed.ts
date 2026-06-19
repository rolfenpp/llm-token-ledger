import "dotenv/config";

import { randomBytes } from "node:crypto";
import type { Prisma, SpanStatus, SpanType, TraceStatus } from "@prisma/client";

import { prisma } from "../src/lib/prisma";

const DAYS = 30;
const TARGET_TRACES = 1_500;
const SEED = 42_026;
const INSERT_BATCH_SIZE = 200;

type ModelPricingPer1K = {
  inputUsdPer1KTokens: number;
  outputUsdPer1KTokens: number;
};

type TenantConfig = {
  name: string;
  slug: string;
  project: {
    name: string;
    slug: string;
  };
  routes: string[];
  features: string[];
};

type ModelProfile = {
  modelName: string;
  inputRange: [number, number];
  outputRange: [number, number];
  baseLatencyMs: [number, number];
  weight: number;
  usage: "document" | "chat" | "balanced";
};

type GeneratedSpan = {
  spanId: string;
  traceId: string;
  parentSpanId?: string;
  spanType: SpanType;
  name: string;
  status: SpanStatus;
  modelName?: string;
  inputTokens?: number;
  outputTokens?: number;
  calculatedCost: number;
  latencyMs: number;
  startedAt: Date;
  endedAt: Date;
  metadata?: Prisma.InputJsonValue;
};

type GeneratedTrace = {
  traceId: string;
  projectId: string;
  route: string;
  status: TraceStatus;
  startedAt: Date;
  endedAt: Date;
  latencyMs: number;
  totalCostUsd: number;
  metadata: Prisma.InputJsonValue;
  spans: GeneratedSpan[];
};

type SeedStats = {
  traces: number;
  spans: number;
  errors: number;
  latencyAnomalies: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  whaleInputTokens: number;
  whaleOutputTokens: number;
};

const MODEL_PRICING_USD_PER_1K: Record<string, ModelPricingPer1K> = {
  "gpt-4o": { inputUsdPer1KTokens: 0.0025, outputUsdPer1KTokens: 0.01 },
  "gpt-4o-mini": { inputUsdPer1KTokens: 0.00015, outputUsdPer1KTokens: 0.0006 },
  "claude-3-5-sonnet": { inputUsdPer1KTokens: 0.003, outputUsdPer1KTokens: 0.015 },
  "claude-3-5-haiku": { inputUsdPer1KTokens: 0.0008, outputUsdPer1KTokens: 0.004 },
  "deepseek-chat": { inputUsdPer1KTokens: 0.00014, outputUsdPer1KTokens: 0.00028 }
};

const DEFAULT_PRICING: ModelPricingPer1K = {
  inputUsdPer1KTokens: 0.001,
  outputUsdPer1KTokens: 0.002
};

const TENANTS: TenantConfig[] = [
  {
    name: "DocuQuery Corp",
    slug: "docuquery-corp",
    project: { name: "Document Intelligence", slug: "doc-intel" },
    routes: ["/api/summarize", "/api/extract-entities", "/api/rag-query"],
    features: ["document-summarizer", "contract-parser", "knowledge-retrieval"]
  },
  {
    name: "SaaSAutomate",
    slug: "saasautomate",
    project: { name: "Workflow Copilot", slug: "workflow-copilot" },
    routes: ["/api/chat", "/api/automation-plan", "/api/ticket-classify"],
    features: ["support-chat", "workflow-builder", "intent-classifier"]
  },
  {
    name: "FintechAI",
    slug: "fintech-ai",
    project: { name: "Risk Analyzer", slug: "risk-analyzer" },
    routes: ["/api/risk-score", "/api/compliance-check", "/api/report-gen"],
    features: ["risk-scoring", "compliance-audit", "executive-report"]
  }
];

const MODEL_PROFILES: ModelProfile[] = [
  {
    modelName: "gpt-4o",
    inputRange: [8_000, 42_000],
    outputRange: [700, 2_800],
    baseLatencyMs: [900, 2_400],
    weight: 0.18,
    usage: "document"
  },
  {
    modelName: "claude-3-5-sonnet",
    inputRange: [6_500, 36_000],
    outputRange: [600, 2_200],
    baseLatencyMs: [1_000, 2_700],
    weight: 0.14,
    usage: "document"
  },
  {
    modelName: "gpt-4o-mini",
    inputRange: [120, 950],
    outputRange: [60, 480],
    baseLatencyMs: [280, 820],
    weight: 0.24,
    usage: "chat"
  },
  {
    modelName: "claude-3-5-haiku",
    inputRange: [100, 780],
    outputRange: [50, 390],
    baseLatencyMs: [240, 680],
    weight: 0.2,
    usage: "chat"
  },
  {
    modelName: "deepseek-chat",
    inputRange: [900, 5_500],
    outputRange: [180, 1_400],
    baseLatencyMs: [420, 1_150],
    weight: 0.24,
    usage: "balanced"
  }
];

const ANOMALY_DAY_OFFSETS = new Set([4, 11, 19, 27]);
const WHALE_TRACE_FRACTION = 0.1;
const WHALE_TOKEN_MULTIPLIER = 6;

function createRng(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function randomInt(rng: () => number, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function pickOne<T>(rng: () => number, items: T[]): T {
  return items[Math.floor(rng() * items.length)]!;
}

function pickWeighted<T extends { weight: number }>(rng: () => number, items: T[]): T {
  const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
  let cursor = rng() * totalWeight;

  for (const item of items) {
    cursor -= item.weight;
    if (cursor <= 0) {
      return item;
    }
  }

  return items[items.length - 1]!;
}

function addMilliseconds(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms);
}

function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function dayOffsetFromEnd(dayIndex: number, endDate: Date): number {
  const dayStart = startOfDay(new Date(endDate));
  dayStart.setDate(dayStart.getDate() - (DAYS - 1 - dayIndex));
  return dayStart.getTime();
}

function trafficMultiplier(date: Date): number {
  const day = date.getDay();
  const hour = date.getHours();
  let multiplier = 1;

  if (day === 0 || day === 6) {
    multiplier *= 0.32;
  }

  if (hour >= 9 && hour <= 17) {
    multiplier *= 1.85;
  } else if (hour >= 7 && hour <= 21) {
    multiplier *= 1.15;
  } else {
    multiplier *= 0.45;
  }

  if (hour >= 12 && hour <= 13) {
    multiplier *= 0.82;
  }

  return multiplier;
}

function resolveModelPricing(modelName: string): ModelPricingPer1K {
  const normalized = modelName.trim().toLowerCase();
  const exact = MODEL_PRICING_USD_PER_1K[normalized];

  if (exact) {
    return exact;
  }

  const fuzzy = Object.entries(MODEL_PRICING_USD_PER_1K).find(([key]) => normalized.includes(key));
  return fuzzy?.[1] ?? DEFAULT_PRICING;
}

function calculateCostUsd(modelName: string, inputTokens: number, outputTokens: number): number {
  const pricing = resolveModelPricing(modelName);
  const inputCost = (inputTokens / 1_000) * pricing.inputUsdPer1KTokens;
  const outputCost = (outputTokens / 1_000) * pricing.outputUsdPer1KTokens;
  return inputCost + outputCost;
}

function createTraceId(): string {
  return randomBytes(16).toString("hex");
}

function createSpanId(): string {
  return randomBytes(8).toString("hex");
}

function buildDayWeights(endDate: Date): number[] {
  const weights: number[] = [];

  for (let dayIndex = 0; dayIndex < DAYS; dayIndex += 1) {
    let dayWeight = 0;
    const dayStart = new Date(dayOffsetFromEnd(dayIndex, endDate));

    for (let hour = 0; hour < 24; hour += 1) {
      for (let quarter = 0; quarter < 4; quarter += 1) {
        const sample = new Date(dayStart);
        sample.setHours(hour, quarter * 15, 0, 0);
        dayWeight += trafficMultiplier(sample);
      }
    }

    weights.push(dayWeight);
  }

  return weights;
}

function allocateTraceCounts(dayWeights: number[], target: number): number[] {
  const totalWeight = dayWeights.reduce((sum, weight) => sum + weight, 0);
  const counts = dayWeights.map((weight) => Math.floor((weight / totalWeight) * target));

  let assigned = counts.reduce((sum, count) => sum + count, 0);
  let cursor = 0;

  while (assigned < target) {
    counts[cursor % counts.length]! += 1;
    assigned += 1;
    cursor += 1;
  }

  return counts;
}

function randomTimestampForDay(
  rng: () => number,
  dayIndex: number,
  endDate: Date
): { timestamp: Date; dayOffset: number } {
  const dayStart = new Date(dayOffsetFromEnd(dayIndex, endDate));
  const slots: Array<{ weight: number; hour: number; quarter: number }> = [];

  for (let hour = 0; hour < 24; hour += 1) {
    for (let quarter = 0; quarter < 4; quarter += 1) {
      const sample = new Date(dayStart);
      sample.setHours(hour, quarter * 15, 0, 0);
      slots.push({
        weight: trafficMultiplier(sample),
        hour,
        quarter
      });
    }
  }

  const chosen = pickWeighted(rng, slots);
  const timestamp = new Date(dayStart);
  timestamp.setHours(
    chosen.hour,
    chosen.quarter * 15,
    randomInt(rng, 0, 14),
    randomInt(rng, 0, 59)
  );

  const dayOffset = Math.floor((endDate.getTime() - timestamp.getTime()) / 86_400_000);
  return { timestamp, dayOffset };
}

function buildSpanBlueprint(
  rng: () => number,
  spanCount: number,
  feature: string
): Array<{ type: SpanType; name: string }> {
  const llmStep = { type: "llm" as const, name: `${feature}-inference` };

  if (spanCount === 1) {
    return [llmStep];
  }

  if (spanCount === 2) {
    return [
      { type: "db", name: "fetch-user-context" },
      llmStep
    ];
  }

  if (spanCount === 3) {
    return [
      { type: "db", name: "fetch-user-context" },
      { type: "tool", name: "assemble-prompt" },
      llmStep
    ];
  }

  const fourthStep =
    rng() > 0.5
      ? { type: "cache" as const, name: "semantic-cache-lookup" }
      : { type: "http" as const, name: "downstream-webhook" };

  return [
    { type: "db", name: "fetch-user-context" },
    { type: "tool", name: "assemble-prompt" },
    llmStep,
    fourthStep
  ];
}

function buildUserPool(rng: () => number, tenantSlug: string): { id: string; isWhale: boolean }[] {
  const users: { id: string; isWhale: boolean }[] = [];

  for (let index = 0; index < 120; index += 1) {
    users.push({
      id: `${tenantSlug}-user-${String(index + 1).padStart(3, "0")}`,
      isWhale: false
    });
  }

  const whaleCount = Math.max(4, Math.floor(users.length * 0.05));
  const shuffled = [...users].sort(() => rng() - 0.5);

  for (let index = 0; index < whaleCount; index += 1) {
    shuffled[index]!.isWhale = true;
  }

  return shuffled;
}

function chooseModelProfile(
  rng: () => number,
  tenant: TenantConfig,
  isWhale: boolean
): ModelProfile {
  if (tenant.slug === "docuquery-corp") {
    const documentModels = MODEL_PROFILES.filter((profile) => profile.usage !== "chat");
    return pickWeighted(rng, documentModels.map((profile) => ({ ...profile, weight: profile.weight * 1.6 })));
  }

  if (tenant.slug === "saasautomate") {
    const chatModels = MODEL_PROFILES.filter((profile) => profile.usage !== "document");
    return pickWeighted(rng, chatModels.map((profile) => ({ ...profile, weight: profile.weight * 1.5 })));
  }

  if (isWhale) {
    return pickWeighted(rng, MODEL_PROFILES.filter((profile) => profile.usage !== "chat"));
  }

  return pickWeighted(rng, MODEL_PROFILES);
}

function generateSpansForTrace(
  rng: () => number,
  traceId: string,
  startedAt: Date,
  tenant: TenantConfig,
  route: string,
  feature: string,
  userId: string,
  isWhale: boolean,
  forceError: boolean,
  forceLatencyAnomaly: boolean
): { spans: GeneratedSpan[]; totalCostUsd: number; latencyMs: number; status: TraceStatus } {
  const spanCount = randomInt(rng, 1, 4);
  const modelProfile = chooseModelProfile(rng, tenant, isWhale);
  const spans: GeneratedSpan[] = [];
  let cursor = new Date(startedAt);
  let totalCostUsd = 0;
  let totalLatencyMs = 0;
  let parentSpanId: string | undefined;
  let traceFailed = forceError && rng() < 0.55;

  const tokenMultiplier = isWhale ? WHALE_TOKEN_MULTIPLIER : 1;
  const selectedBlueprint = buildSpanBlueprint(rng, spanCount, feature);

  for (const [index, step] of selectedBlueprint.entries()) {
    const spanId = createSpanId();
    const isLlmSpan = step.type === "llm";
    const latencyAnomaly = isLlmSpan && (forceLatencyAnomaly || rng() < 0.04);
    let latencyMs = 0;

    if (isLlmSpan) {
      latencyMs = latencyAnomaly
        ? randomInt(rng, 6_500, 12_000)
        : randomInt(rng, modelProfile.baseLatencyMs[0], modelProfile.baseLatencyMs[1]);
    } else if (step.type === "db") {
      latencyMs = randomInt(rng, 12, 95);
    } else if (step.type === "tool") {
      latencyMs = randomInt(rng, 45, 260);
    } else if (step.type === "cache") {
      latencyMs = randomInt(rng, 3, 28);
    } else {
      latencyMs = randomInt(rng, 80, 420);
    }

    const spanStartedAt = new Date(cursor);
    const spanEndedAt = addMilliseconds(spanStartedAt, latencyMs);
    cursor = spanEndedAt;
    totalLatencyMs += latencyMs;

    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let calculatedCost = 0;
    let spanStatus: SpanStatus = "OK";

    if (isLlmSpan) {
      inputTokens = Math.round(
        randomInt(rng, modelProfile.inputRange[0], modelProfile.inputRange[1]) * tokenMultiplier
      );
      outputTokens = Math.round(
        randomInt(rng, modelProfile.outputRange[0], modelProfile.outputRange[1]) *
          (isWhale ? tokenMultiplier * 0.75 : 1)
      );
      calculatedCost = calculateCostUsd(modelProfile.modelName, inputTokens, outputTokens);
      totalCostUsd += calculatedCost;

      if (traceFailed) {
        spanStatus = "ERROR";
      }
    }

    spans.push({
      spanId,
      traceId,
      parentSpanId,
      spanType: step.type,
      name: step.name,
      status: spanStatus,
      modelName: isLlmSpan ? modelProfile.modelName : undefined,
      inputTokens,
      outputTokens,
      calculatedCost,
      latencyMs,
      startedAt: spanStartedAt,
      endedAt: spanEndedAt,
      metadata: {
        route,
        feature,
        userId,
        tenant: tenant.slug,
        spanIndex: index,
        ...(latencyAnomaly ? { anomaly: "latency_spike", expectedLatencyMs: modelProfile.baseLatencyMs[1] } : {}),
        ...(traceFailed && isLlmSpan ? { statusCode: 500, error: "Upstream LLM provider timeout" } : {})
      }
    });

    parentSpanId = spanId;
  }

  const status: TraceStatus = traceFailed ? "ERROR" : "OK";

  return {
    spans,
    totalCostUsd,
    latencyMs: totalLatencyMs,
    status
  };
}

async function upsertTenants(): Promise<Map<string, string>> {
  const projectIds = new Map<string, string>();

  for (const tenant of TENANTS) {
    const organization = await prisma.organization.upsert({
      where: { slug: tenant.slug },
      create: {
        slug: tenant.slug,
        name: tenant.name
      },
      update: {
        name: tenant.name
      }
    });

    const project = await prisma.project.upsert({
      where: {
        organizationId_slug: {
          organizationId: organization.id,
          slug: tenant.project.slug
        }
      },
      create: {
        organizationId: organization.id,
        slug: tenant.project.slug,
        name: tenant.project.name
      },
      update: {
        name: tenant.project.name
      }
    });

    projectIds.set(tenant.slug, project.id);
  }

  return projectIds;
}

async function clearTelemetryTables(): Promise<void> {
  await prisma.span.deleteMany();
  await prisma.trace.deleteMany();
}

async function insertTraceBatch(traces: GeneratedTrace[]): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.trace.createMany({
      data: traces.map((trace) => ({
        traceId: trace.traceId,
        projectId: trace.projectId,
        route: trace.route,
        status: trace.status,
        startedAt: trace.startedAt,
        endedAt: trace.endedAt,
        latencyMs: trace.latencyMs,
        totalCostUsd: trace.totalCostUsd,
        metadata: trace.metadata
      }))
    });

    const spanRows = traces.flatMap((trace) =>
      trace.spans.map((span) => ({
        traceId: span.traceId,
        spanId: span.spanId,
        parentSpanId: span.parentSpanId,
        spanType: span.spanType,
        name: span.name,
        status: span.status,
        modelName: span.modelName,
        inputTokens: span.inputTokens,
        outputTokens: span.outputTokens,
        calculatedCost: span.calculatedCost,
        latencyMs: span.latencyMs,
        startedAt: span.startedAt,
        endedAt: span.endedAt,
        metadata: span.metadata
      }))
    );

    if (spanRows.length > 0) {
      await tx.span.createMany({
        data: spanRows,
        skipDuplicates: true
      });
    }
  });
}

function estimateStorageBytes(traceCount: number, spanCount: number): number {
  const traceRowEstimate = 560;
  const spanRowEstimate = 430;
  const indexOverheadMultiplier = 1.28;
  return Math.round((traceCount * traceRowEstimate + spanCount * spanRowEstimate) * indexOverheadMultiplier);
}

function readJsonFlag(value: Prisma.InputJsonValue | undefined, key: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return (value as Record<string, unknown>)[key] === true;
}

function readJsonString(value: Prisma.InputJsonValue | undefined, key: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_048_576) {
    return `${(bytes / 1_048_576).toFixed(2)} MB`;
  }

  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${bytes} B`;
}

async function main(): Promise<void> {
  const rng = createRng(SEED);
  const endDate = new Date();
  const stats: SeedStats = {
    traces: 0,
    spans: 0,
    errors: 0,
    latencyAnomalies: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostUsd: 0,
    whaleInputTokens: 0,
    whaleOutputTokens: 0
  };

  console.log("Flight Recorder seed starting...");
  console.log(`Target window: last ${DAYS} days (~${TARGET_TRACES} traces)`);

  await clearTelemetryTables();
  const projectIds = await upsertTenants();
  const userPools = new Map(TENANTS.map((tenant) => [tenant.slug, buildUserPool(rng, tenant.slug)]));

  const dayWeights = buildDayWeights(endDate);
  const traceCounts = allocateTraceCounts(dayWeights, TARGET_TRACES);
  const generatedTraces: GeneratedTrace[] = [];

  for (let dayIndex = 0; dayIndex < DAYS; dayIndex += 1) {
    const tracesForDay = traceCounts[dayIndex] ?? 0;
    const isAnomalyDay = ANOMALY_DAY_OFFSETS.has(dayIndex);

    for (let index = 0; index < tracesForDay; index += 1) {
      const tenant = pickOne(rng, TENANTS);
      const projectId = projectIds.get(tenant.slug);

      if (!projectId) {
        throw new Error(`Missing project for tenant ${tenant.slug}`);
      }

      const { timestamp, dayOffset } = randomTimestampForDay(rng, dayIndex, endDate);
      const userPool = userPools.get(tenant.slug)!;
      const isWhaleTrace = rng() < WHALE_TRACE_FRACTION;
      const user = isWhaleTrace
        ? pickOne(
            rng,
            userPool.filter((candidate) => candidate.isWhale)
          )
        : pickOne(
            rng,
            userPool.filter((candidate) => !candidate.isWhale)
          );

      const route = pickOne(rng, tenant.routes);
      const feature = pickOne(rng, tenant.features);
      const traceId = createTraceId();
      const forceError = isAnomalyDay && rng() < 0.38;
      const forceLatencyAnomaly = isAnomalyDay && rng() < 0.22;

      const spanBundle = generateSpansForTrace(
        rng,
        traceId,
        timestamp,
        tenant,
        route,
        feature,
        user.id,
        user.isWhale || isWhaleTrace,
        forceError,
        forceLatencyAnomaly
      );

      const endedAt = addMilliseconds(timestamp, spanBundle.latencyMs);

      generatedTraces.push({
        traceId,
        projectId,
        route,
        status: spanBundle.status,
        startedAt: timestamp,
        endedAt,
        latencyMs: spanBundle.latencyMs,
        totalCostUsd: spanBundle.totalCostUsd,
        metadata: {
          feature,
          userId: user.id,
          tenant: tenant.slug,
          isWhale: user.isWhale || isWhaleTrace,
          dayOffset,
          ...(forceError ? { incident: "provider_500_spike", statusCode: 500 } : {})
        },
        spans: spanBundle.spans
      });
    }
  }

  for (let offset = 0; offset < generatedTraces.length; offset += INSERT_BATCH_SIZE) {
    const batch = generatedTraces.slice(offset, offset + INSERT_BATCH_SIZE);
    await insertTraceBatch(batch);
  }

  for (const trace of generatedTraces) {
    stats.traces += 1;
    if (trace.status === "ERROR") {
      stats.errors += 1;
    }

    stats.totalCostUsd += trace.totalCostUsd;

    for (const span of trace.spans) {
      stats.spans += 1;
      stats.totalInputTokens += span.inputTokens ?? 0;
      stats.totalOutputTokens += span.outputTokens ?? 0;

      const metadata = span.metadata;
      if (readJsonString(metadata, "anomaly") === "latency_spike") {
        stats.latencyAnomalies += 1;
      }

      const traceMetadata = trace.metadata;
      if (readJsonFlag(traceMetadata, "isWhale")) {
        stats.whaleInputTokens += span.inputTokens ?? 0;
        stats.whaleOutputTokens += span.outputTokens ?? 0;
      }
    }
  }

  const totalTokens = stats.totalInputTokens + stats.totalOutputTokens;
  const whaleTokens = stats.whaleInputTokens + stats.whaleOutputTokens;
  const estimatedBytes = estimateStorageBytes(stats.traces, stats.spans);

  console.log("\nSeed complete.");
  console.log("-------------------------------------------");
  console.log(`Organizations: ${TENANTS.length}`);
  console.log(`Projects:      ${TENANTS.length}`);
  console.log(`Traces:        ${stats.traces.toLocaleString()}`);
  console.log(`Spans:         ${stats.spans.toLocaleString()}`);
  console.log(`Error traces:  ${stats.errors.toLocaleString()} (${((stats.errors / stats.traces) * 100).toFixed(1)}%)`);
  console.log(
    `Latency spikes:${stats.latencyAnomalies.toLocaleString()} LLM spans`
  );
  console.log(`Input tokens:  ${stats.totalInputTokens.toLocaleString()}`);
  console.log(`Output tokens: ${stats.totalOutputTokens.toLocaleString()}`);
  console.log(`Total cost:    $${stats.totalCostUsd.toFixed(4)} USD (simulated)`);
  console.log(
    `Whale share:   ${((whaleTokens / totalTokens) * 100).toFixed(1)}% of token volume`
  );
  console.log(`Est. DB size:  ~${formatBytes(estimatedBytes)} (rows + index overhead)`);
  console.log("-------------------------------------------");
}

main()
  .catch((error) => {
    console.error("Seed failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
