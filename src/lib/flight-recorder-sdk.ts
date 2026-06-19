import { randomBytes } from "node:crypto";
import { get_encoding, type Tiktoken } from "@dqbd/tiktoken";
import type { Prisma, SpanStatus, SpanType, TraceStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";

const BATCH_SIZE_THRESHOLD = 10;
const FLUSH_INTERVAL_MS = 3_000;
const TOKEN_ENCODING = "cl100k_base";

type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
};

type ModelPricingPer1K = {
  inputUsdPer1KTokens: number;
  outputUsdPer1KTokens: number;
};

type SerializedError = {
  name?: string;
  message: string;
  stack?: string;
};

type BufferedSpanRecord = {
  spanId: string;
  parentSpanId?: string;
  spanType: SpanType;
  name: string;
  status: SpanStatus;
  modelName?: string;
  inputTokens: number;
  outputTokens: number;
  calculatedCostUsd: number;
  latencyMs: number;
  startedAt: Date;
  endedAt: Date;
  metadata?: Prisma.InputJsonValue;
};

type BufferedTraceRecord = {
  organization: {
    slug: string;
    name: string;
  };
  project: {
    slug: string;
    name: string;
  };
  trace: {
    traceId: string;
    route: string;
    status: TraceStatus;
    startedAt: Date;
    endedAt: Date;
    latencyMs: number;
    totalCostUsd: number;
    metadata?: Prisma.InputJsonValue;
  };
  spans: BufferedSpanRecord[];
};

export type FlightRecorderTraceContext<TResponse = unknown> = {
  userId?: string;
  featureName: string;
  modelName?: string;
  organizationSlug?: string;
  organizationName?: string;
  projectSlug?: string;
  projectName?: string;
  route?: string;
  spanName?: string;
  spanType?: SpanType;
  input?: unknown;
  usage?: Partial<TokenUsage>;
  metadata?: Record<string, unknown>;
  responseToText?: (response: TResponse) => string;
};

class TelemetryBatchWorker {
  private readonly buffer: BufferedTraceRecord[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;

  enqueue(record: BufferedTraceRecord): void {
    this.buffer.push(record);

    if (this.buffer.length >= BATCH_SIZE_THRESHOLD) {
      queueMicrotask(() => {
        void this.flush();
      });
      return;
    }

    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) {
      return;
    }

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, FLUSH_INTERVAL_MS);
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) {
      return;
    }

    this.flushing = true;

    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    const batch = this.buffer.splice(0, this.buffer.length);

    try {
      await persistBufferedBatch(batch);
    } catch (error) {
      this.buffer.unshift(...batch);

      if (process.env.NODE_ENV !== "test") {
        console.error("FlightRecorder batch flush failed", error);
      }
    } finally {
      this.flushing = false;

      if (this.buffer.length >= BATCH_SIZE_THRESHOLD) {
        queueMicrotask(() => {
          void this.flush();
        });
      } else if (this.buffer.length > 0) {
        this.scheduleFlush();
      }
    }
  }
}

class FlightRecorderClient {
  private static readonly MODEL_PRICING_USD_PER_1K: Record<string, ModelPricingPer1K> = {
    "gpt-4o": {
      inputUsdPer1KTokens: 0.0025,
      outputUsdPer1KTokens: 0.01
    },
    "gpt-4o-mini": {
      inputUsdPer1KTokens: 0.00015,
      outputUsdPer1KTokens: 0.0006
    },
    "claude-3-5-sonnet": {
      inputUsdPer1KTokens: 0.003,
      outputUsdPer1KTokens: 0.015
    },
    "claude-3-5-haiku": {
      inputUsdPer1KTokens: 0.0008,
      outputUsdPer1KTokens: 0.004
    },
    "deepseek-chat": {
      inputUsdPer1KTokens: 0.00014,
      outputUsdPer1KTokens: 0.00028
    }
  };

  private static readonly DEFAULT_PRICING: ModelPricingPer1K = {
    inputUsdPer1KTokens: 0.001,
    outputUsdPer1KTokens: 0.002
  };

  private readonly batchWorker = new TelemetryBatchWorker();

  async trace<TResponse>(
    context: FlightRecorderTraceContext<TResponse>,
    callback: () => Promise<TResponse>
  ): Promise<TResponse> {
    const traceId = createTraceId();
    const spanId = createSpanId();
    const startedAt = new Date();
    const startMs = performance.now();

    let response: TResponse | undefined;
    let status: TraceStatus = "OK";
    let capturedError: unknown;

    try {
      response = await callback();
      return response;
    } catch (error) {
      status = "ERROR";
      capturedError = error;
      throw error;
    } finally {
      const endedAt = new Date();
      const latencyMs = elapsedMs(startMs);
      const usage = resolveTokenUsage(response, context, status);
      const calculatedCostUsd = FlightRecorderClient.calculateCostUsd(context.modelName, usage);
      const metadata = buildTraceMetadata(context, capturedError);

      this.batchWorker.enqueue({
        organization: {
          slug: context.organizationSlug ?? "default",
          name: context.organizationName ?? "Default Organization"
        },
        project: {
          slug: context.projectSlug ?? "default",
          name: context.projectName ?? "Default Project"
        },
        trace: {
          traceId,
          route: context.route ?? context.featureName,
          status,
          startedAt,
          endedAt,
          latencyMs,
          totalCostUsd: calculatedCostUsd,
          metadata
        },
        spans: [
          {
            spanId,
            spanType: context.spanType ?? "llm",
            name: context.spanName ?? context.featureName,
            status: mapTraceStatusToSpanStatus(status),
            modelName: context.modelName,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            calculatedCostUsd,
            latencyMs,
            startedAt,
            endedAt,
            metadata
          }
        ]
      });
    }
  }

  private static calculateCostUsd(modelName: string | undefined, usage: TokenUsage): number {
    const pricing = FlightRecorderClient.resolveModelPricing(modelName);
    const inputCost = (usage.inputTokens / 1_000) * pricing.inputUsdPer1KTokens;
    const outputCost = (usage.outputTokens / 1_000) * pricing.outputUsdPer1KTokens;

    return inputCost + outputCost;
  }

  private static resolveModelPricing(modelName: string | undefined): ModelPricingPer1K {
    if (!modelName) {
      return FlightRecorderClient.DEFAULT_PRICING;
    }

    const normalizedModelName = modelName.trim().toLowerCase();
    const exactMatch = FlightRecorderClient.MODEL_PRICING_USD_PER_1K[normalizedModelName];

    if (exactMatch) {
      return exactMatch;
    }

    const fuzzyMatch = Object.entries(FlightRecorderClient.MODEL_PRICING_USD_PER_1K).find(([key]) =>
      normalizedModelName.includes(key)
    );

    return fuzzyMatch?.[1] ?? FlightRecorderClient.DEFAULT_PRICING;
  }
}

async function persistBufferedBatch(batch: BufferedTraceRecord[]): Promise<void> {
  const organizationCache = new Map<string, string>();
  const projectCache = new Map<string, string>();
  const spanRows: Prisma.SpanCreateManyInput[] = [];

  await prisma.$transaction(async (tx) => {
    for (const record of batch) {
      const organizationId = await resolveOrganizationId(tx, record.organization, organizationCache);
      const projectId = await resolveProjectId(
        tx,
        record.project,
        organizationId,
        projectCache
      );

      await tx.trace.create({
        data: {
          traceId: record.trace.traceId,
          projectId,
          route: record.trace.route,
          status: record.trace.status,
          startedAt: record.trace.startedAt,
          endedAt: record.trace.endedAt,
          latencyMs: record.trace.latencyMs,
          totalCostUsd: record.trace.totalCostUsd,
          metadata: record.trace.metadata
        }
      });

      for (const span of record.spans) {
        spanRows.push({
          traceId: record.trace.traceId,
          spanId: span.spanId,
          parentSpanId: span.parentSpanId,
          spanType: span.spanType,
          name: span.name,
          status: span.status,
          modelName: span.modelName,
          inputTokens: span.inputTokens,
          outputTokens: span.outputTokens,
          calculatedCost: span.calculatedCostUsd,
          latencyMs: span.latencyMs,
          startedAt: span.startedAt,
          endedAt: span.endedAt,
          metadata: span.metadata
        });
      }
    }

    if (spanRows.length > 0) {
      await tx.span.createMany({
        data: spanRows,
        skipDuplicates: true
      });
    }
  });
}

async function resolveOrganizationId(
  tx: Prisma.TransactionClient,
  organization: BufferedTraceRecord["organization"],
  cache: Map<string, string>
): Promise<string> {
  const cached = cache.get(organization.slug);

  if (cached) {
    return cached;
  }

  const record = await tx.organization.upsert({
    where: { slug: organization.slug },
    create: {
      slug: organization.slug,
      name: organization.name
    },
    update: {
      name: organization.name
    }
  });

  cache.set(organization.slug, record.id);
  return record.id;
}

async function resolveProjectId(
  tx: Prisma.TransactionClient,
  project: BufferedTraceRecord["project"],
  organizationId: string,
  cache: Map<string, string>
): Promise<string> {
  const cacheKey = `${organizationId}:${project.slug}`;
  const cached = cache.get(cacheKey);

  if (cached) {
    return cached;
  }

  const record = await tx.project.upsert({
    where: {
      organizationId_slug: {
        organizationId,
        slug: project.slug
      }
    },
    create: {
      organizationId,
      slug: project.slug,
      name: project.name
    },
    update: {
      name: project.name
    }
  });

  cache.set(cacheKey, record.id);
  return record.id;
}

function resolveTokenUsage<TResponse>(
  response: TResponse | undefined,
  context: FlightRecorderTraceContext<TResponse>,
  status: TraceStatus
): TokenUsage {
  if (status === "OK" && response !== undefined) {
    const extracted = extractUsageFromResponse(response);

    return {
      inputTokens:
        context.usage?.inputTokens ?? extracted?.inputTokens ?? countTokens(context.input),
      outputTokens:
        context.usage?.outputTokens ??
        extracted?.outputTokens ??
        countTokens(context.responseToText?.(response) ?? inferResponseText(response))
    };
  }

  return {
    inputTokens: context.usage?.inputTokens ?? countTokens(context.input),
    outputTokens: context.usage?.outputTokens ?? 0
  };
}

function extractUsageFromResponse(response: unknown): TokenUsage | null {
  if (!isRecord(response)) {
    return null;
  }

  const directUsage = isRecord(response.usage) ? response.usage : null;

  if (directUsage) {
    const inputTokens =
      readNumber(directUsage.input_tokens) ??
      readNumber(directUsage.prompt_tokens) ??
      readNumber(directUsage.inputTokens);
    const outputTokens =
      readNumber(directUsage.output_tokens) ??
      readNumber(directUsage.completion_tokens) ??
      readNumber(directUsage.outputTokens);

    if (inputTokens !== undefined && outputTokens !== undefined) {
      return { inputTokens, outputTokens };
    }
  }

  if (isRecord(response.message) && isRecord(response.message.usage)) {
    return extractUsageFromResponse({ usage: response.message.usage });
  }

  return null;
}

let cachedEncoding: Tiktoken | null = null;

function countTokens(value: unknown): number {
  const text = normalizeToText(value);

  if (text.length === 0) {
    return 0;
  }

  const encoding = cachedEncoding ?? get_encoding(TOKEN_ENCODING);
  cachedEncoding = encoding;

  return encoding.encode(text).length;
}

function inferResponseText(response: unknown): string {
  if (typeof response === "string") {
    return response;
  }

  if (!isRecord(response)) {
    return normalizeToText(response);
  }

  if (typeof response.output_text === "string") {
    return response.output_text;
  }

  const firstChoice = Array.isArray(response.choices) ? response.choices[0] : undefined;

  if (isRecord(firstChoice)) {
    if (isRecord(firstChoice.message)) {
      return normalizeToText(firstChoice.message.content);
    }

    if (typeof firstChoice.text === "string") {
      return firstChoice.text;
    }
  }

  if (Array.isArray(response.content)) {
    return response.content
      .map((block) => {
        if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
          return block.text;
        }

        return normalizeToText(block);
      })
      .join("");
  }

  if (typeof response.content === "string") {
    return response.content;
  }

  return normalizeToText(response);
}

function normalizeToText(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function buildTraceMetadata<TResponse>(
  context: FlightRecorderTraceContext<TResponse>,
  error: unknown
): Prisma.InputJsonValue | undefined {
  const metadata: Record<string, unknown> = {
    ...(context.metadata ?? {}),
    featureName: context.featureName
  };

  if (context.userId) {
    metadata.userId = context.userId;
  }

  if (context.modelName) {
    metadata.modelName = context.modelName;
  }

  if (error !== undefined) {
    metadata.error = serializeError(error);
  }

  return Object.keys(metadata).length > 0 ? (metadata as Prisma.InputJsonValue) : undefined;
}

function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack
    };
  }

  return {
    message: String(error)
  };
}

function mapTraceStatusToSpanStatus(status: TraceStatus): SpanStatus {
  if (status === "ERROR") {
    return "ERROR";
  }

  if (status === "CANCELLED") {
    return "CANCELLED";
  }

  return "OK";
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function elapsedMs(startMs: number): number {
  return Math.max(0, Math.round(performance.now() - startMs));
}

function createTraceId(): string {
  return randomBytes(16).toString("hex");
}

function createSpanId(): string {
  return randomBytes(8).toString("hex");
}

export const FlightRecorder = new FlightRecorderClient();

/*
import { NextResponse } from "next/server";
import OpenAI from "openai";

import { FlightRecorder } from "@/lib/flight-recorder-sdk";

export const runtime = "nodejs";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function POST(request: Request) {
  const { prompt, userId } = await request.json();

  const completion = await FlightRecorder.trace(
    {
      userId,
      featureName: "chat-completion",
      modelName: "gpt-4o",
      route: "/api/chat",
      input: prompt
    },
    () =>
      openai.chat.completions.create({
        model: "gpt-4o",
        messages: [{ role: "user", content: prompt }]
      })
  );

  return NextResponse.json({
    text: completion.choices[0]?.message?.content ?? ""
  });
}

// Anthropic example:
//
// const message = await FlightRecorder.trace(
//   {
//     userId,
//     featureName: "anthropic-stream",
//     modelName: "claude-3-5-sonnet",
//     route: "/api/anthropic",
//     input: prompt,
//     responseToText: (response) =>
//       response.content
//         .filter((block) => block.type === "text")
//         .map((block) => block.text)
//         .join("")
//   },
//   () =>
//     anthropic.messages.create({
//       model: "claude-3-5-sonnet-20241022",
//       max_tokens: 1024,
//       messages: [{ role: "user", content: prompt }]
//     })
// );
*/
