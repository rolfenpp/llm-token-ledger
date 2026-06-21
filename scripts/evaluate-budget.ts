import "dotenv/config";

import { get_encoding } from "@dqbd/tiktoken";
import type { Prisma } from "@prisma/client";

import { prisma } from "../src/lib/prisma";

const TOKEN_ENCODING = "cl100k_base";
const BASELINE_WINDOW_DAYS = 7;
const SIMULATION_ITERATIONS = 10;
const REGRESSION_THRESHOLD = 0.2;

const TARGET_ROUTE = process.env.BUDGET_TARGET_ROUTE ?? "/api/chat";
const TARGET_MODEL = process.env.BUDGET_TARGET_MODEL ?? "gpt-4o-mini";

type ModelPricingPer1K = {
  inputUsdPer1KTokens: number;
  outputUsdPer1KTokens: number;
};

type GoldenPromptSample = {
  id: string;
  prompt: string;
  mockResponse: string;
};

type BaselineSnapshot = {
  traceCount: number;
  totalCostUsd: number;
  averageCostUsd: number;
  windowStart: Date;
  windowEnd: Date;
};

type SimulationResult = {
  sample: GoldenPromptSample;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
};

type BudgetEvaluation = {
  baseline: BaselineSnapshot;
  simulations: SimulationResult[];
  projectedAverageCostUsd: number;
  regressionThresholdUsd: number;
  deltaUsd: number;
  deltaPercent: number;
  passed: boolean;
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

const GOLDEN_DATASET: GoldenPromptSample[] = [
  {
    id: "chat-01",
    prompt: "How do I reset my password?",
    mockResponse:
      "Open Settings > Security, choose Reset Password, and follow the email link. Links expire after 30 minutes."
  },
  {
    id: "chat-02",
    prompt: "Can you summarize our onboarding checklist for new workspace admins?",
    mockResponse:
      "Admins should verify billing, invite core teammates, connect SSO, and publish the default workflow template."
  },
  {
    id: "chat-03",
    prompt: "Why am I seeing a 429 error when calling the automation API?",
    mockResponse:
      "A 429 means you exceeded the workspace rate limit. Retry with exponential backoff or request a temporary limit increase."
  },
  {
    id: "chat-04",
    prompt: "Draft a polite reply telling a customer their refund was approved.",
    mockResponse:
      "Thanks for your patience. Your refund was approved today and should appear on your statement within 5-7 business days."
  },
  {
    id: "chat-05",
    prompt: "Compare annual vs monthly billing for a 25-seat team.",
    mockResponse:
      "Annual billing saves about 18% versus monthly for 25 seats and includes priority support on the Business plan."
  },
  {
    id: "chat-06",
    prompt: "What changed in the latest release notes for workflow triggers?",
    mockResponse:
      "Release 4.8 adds debounced webhook triggers, retry policies, and a new dry-run mode for automation testing."
  },
  {
    id: "chat-07",
    prompt: "Help me troubleshoot a failed SSO login for Google Workspace.",
    mockResponse:
      "Confirm the ACS URL, certificate expiry, and that the user email domain is mapped to the correct organization."
  },
  {
    id: "chat-08",
    prompt: "Generate three follow-up questions after a demo about ticket routing.",
    mockResponse:
      "Ask about current ticket volume, SLA targets, and whether agents need AI-suggested replies in the inbox."
  },
  {
    id: "chat-09",
    prompt: "Explain how to export audit logs for the last 30 days.",
    mockResponse:
      "Go to Admin > Compliance > Audit Logs, set the date range to 30 days, and export CSV or JSON."
  },
  {
    id: "chat-10",
    prompt: "Suggest a concise escalation message for a P1 outage affecting login.",
    mockResponse:
      "We are investigating a P1 login outage impacting multiple regions. Next update in 15 minutes with mitigation status."
  }
];

let cachedEncoding: ReturnType<typeof get_encoding> | null = null;

function countTokens(text: string): number {
  if (text.length === 0) {
    return 0;
  }

  const encoding = cachedEncoding ?? get_encoding(TOKEN_ENCODING);
  cachedEncoding = encoding;

  return encoding.encode(text).length;
}

function resolveModelPricing(modelName: string): ModelPricingPer1K {
  const normalizedModelName = modelName.trim().toLowerCase();
  const exactMatch = MODEL_PRICING_USD_PER_1K[normalizedModelName];

  if (exactMatch) {
    return exactMatch;
  }

  const fuzzyMatch = Object.entries(MODEL_PRICING_USD_PER_1K).find(([key]) =>
    normalizedModelName.includes(key)
  );

  return fuzzyMatch?.[1] ?? DEFAULT_PRICING;
}

function calculateCostUsd(modelName: string, inputTokens: number, outputTokens: number): number {
  const pricing = resolveModelPricing(modelName);
  const inputCost = (inputTokens / 1_000) * pricing.inputUsdPer1KTokens;
  const outputCost = (outputTokens / 1_000) * pricing.outputUsdPer1KTokens;

  return inputCost + outputCost;
}

function decimalToNumber(value: Prisma.Decimal | number): number {
  return typeof value === "number" ? value : Number(value);
}

function formatUsd(value: number): string {
  return `$${value.toFixed(6)}`;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value.padEnd(width, " ");
}

async function fetchBaselineSnapshot(route: string): Promise<BaselineSnapshot> {
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd);
  windowStart.setDate(windowStart.getDate() - BASELINE_WINDOW_DAYS);

  const traces = await prisma.trace.findMany({
    where: {
      route,
      status: "OK",
      startedAt: {
        gte: windowStart,
        lte: windowEnd
      }
    },
    select: {
      totalCostUsd: true
    }
  });

  const totalCostUsd = traces.reduce(
    (sum, trace) => sum + decimalToNumber(trace.totalCostUsd),
    0
  );
  const traceCount = traces.length;
  const averageCostUsd = traceCount > 0 ? totalCostUsd / traceCount : 0;

  return {
    traceCount,
    totalCostUsd,
    averageCostUsd,
    windowStart,
    windowEnd
  };
}

function simulateGoldenDataset(
  samples: GoldenPromptSample[],
  modelName: string
): SimulationResult[] {
  return samples.slice(0, SIMULATION_ITERATIONS).map((sample) => {
    const inputTokens = countTokens(sample.prompt);
    const outputTokens = countTokens(sample.mockResponse);
    const costUsd = calculateCostUsd(modelName, inputTokens, outputTokens);

    return {
      sample,
      inputTokens,
      outputTokens,
      costUsd
    };
  });
}

function evaluateBudget(
  baseline: BaselineSnapshot,
  simulations: SimulationResult[]
): BudgetEvaluation {
  const projectedAverageCostUsd =
    simulations.reduce((sum, result) => sum + result.costUsd, 0) / simulations.length;
  const regressionThresholdUsd = baseline.averageCostUsd * (1 + REGRESSION_THRESHOLD);
  const deltaUsd = projectedAverageCostUsd - baseline.averageCostUsd;
  const deltaPercent =
    baseline.averageCostUsd > 0 ? deltaUsd / baseline.averageCostUsd : projectedAverageCostUsd > 0 ? 1 : 0;
  const passed = projectedAverageCostUsd <= regressionThresholdUsd;

  return {
    baseline,
    simulations,
    projectedAverageCostUsd,
    regressionThresholdUsd,
    deltaUsd,
    deltaPercent,
    passed
  };
}

function printSuccess(evaluation: BudgetEvaluation): void {
  console.log("\n✅ BUDGET GATE PASSED");
  console.log("-------------------------------------------");
  console.log(`Route:                 ${TARGET_ROUTE}`);
  console.log(`Model:                 ${TARGET_MODEL}`);
  console.log(`Baseline window:       last ${BASELINE_WINDOW_DAYS} days`);
  console.log(`Historical traces:     ${evaluation.baseline.traceCount.toLocaleString()}`);
  console.log(`Baseline avg cost:     ${formatUsd(evaluation.baseline.averageCostUsd)} / trace`);
  console.log(`Projected avg cost:    ${formatUsd(evaluation.projectedAverageCostUsd)} / trace`);
  console.log(`Allowed threshold:     ${formatUsd(evaluation.regressionThresholdUsd)} (+${formatPercent(REGRESSION_THRESHOLD)})`);
  console.log(`Delta vs baseline:     ${formatUsd(evaluation.deltaUsd)} (${formatPercent(evaluation.deltaPercent)})`);
  console.log("-------------------------------------------");
  console.log("Simulated golden dataset within safe budget limits.");
}

function printRegressionWarning(evaluation: BudgetEvaluation): void {
  const title = "⛔ BUDGET REGRESSION DETECTED — CI/CD MERGE BLOCKED";
  const border = "=".repeat(Math.max(title.length + 4, 96));

  console.error(`\n${border}`);
  console.error(title);
  console.error(border);
  console.error("");
  console.error("Summary");
  console.error("-------");
  console.error(`Route:                 ${TARGET_ROUTE}`);
  console.error(`Model:                 ${TARGET_MODEL}`);
  console.error(`Baseline window:       ${evaluation.baseline.windowStart.toISOString()} → ${evaluation.baseline.windowEnd.toISOString()}`);
  console.error(`Historical traces:     ${evaluation.baseline.traceCount.toLocaleString()}`);
  console.error(`Baseline avg cost:     ${formatUsd(evaluation.baseline.averageCostUsd)} / trace`);
  console.error(`Projected avg cost:    ${formatUsd(evaluation.projectedAverageCostUsd)} / trace`);
  console.error(`Allowed threshold:     ${formatUsd(evaluation.regressionThresholdUsd)} (+${formatPercent(REGRESSION_THRESHOLD)})`);
  console.error(`Delta vs baseline:     ${formatUsd(evaluation.deltaUsd)} (${formatPercent(evaluation.deltaPercent)})`);
  console.error("");
  console.error("Golden Dataset Breakdown");
  console.error("------------------------");

  const headers = ["Sample", "Input Tok", "Output Tok", "Simulated Cost"];
  const rows = evaluation.simulations.map((result) => [
    result.sample.id,
    String(result.inputTokens),
    String(result.outputTokens),
    formatUsd(result.costUsd)
  ]);

  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]!.length))
  );

  console.error(headers.map((header, index) => pad(header, widths[index]!)).join(" | "));
  console.error(widths.map((width) => "-".repeat(width)).join("-+-"));

  for (const row of rows) {
    console.error(row.map((cell, index) => pad(cell, widths[index]!)).join(" | "));
  }

  console.error("");
  console.error(border);
  console.error("Projected cost exceeds the 7-day baseline by more than 20%.");
  console.error("Review prompt templates, model selection, or max token limits before merging.");
  console.error(border);
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set. Expected PostgreSQL on localhost:5433 from .env.");
  }

  console.log("LLMTokenLedger budget gate starting...");
  console.log(`Target route: ${TARGET_ROUTE}`);
  console.log(`Target model: ${TARGET_MODEL}`);

  const baseline = await fetchBaselineSnapshot(TARGET_ROUTE);

  if (baseline.traceCount === 0) {
    throw new Error(
      `No OK traces found for route "${TARGET_ROUTE}" in the last ${BASELINE_WINDOW_DAYS} days. Seed the database before running the budget gate.`
    );
  }

  console.log(
    `Baseline established from ${baseline.traceCount.toLocaleString()} traces: ${formatUsd(baseline.averageCostUsd)} avg / trace`
  );

  const simulations = simulateGoldenDataset(GOLDEN_DATASET, TARGET_MODEL);
  const evaluation = evaluateBudget(baseline, simulations);

  if (evaluation.passed) {
    printSuccess(evaluation);
    process.exit(0);
  }

  printRegressionWarning(evaluation);
  process.exit(1);
}

main()
  .catch((error) => {
    console.error("Budget gate failed to run:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
