import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// ─── Formatters ───────────────────────────────────────────────────────────

function toNumber(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === "number") return value;
  return Number(value);
}

function formatUsd(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(amount);
}

function formatTokens(count: number): string {
  if (count >= 1_000_000_000) return `${(count / 1_000_000_000).toFixed(1)}B`;
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return count.toLocaleString("en-US");
}

function formatLatencySeconds(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatPercent(value: number, decimals = 1): string {
  return `${value.toFixed(decimals)}%`;
}

function formatMicroCost(usd: number): string {
  if (usd === 0) return "$0.000000";
  if (usd < 0.01) {
    return `$${usd.toFixed(6)}`;
  }
  return formatUsd(usd);
}

function formatTimestamp(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date);
}

function safeRate(numerator: number, denominator: number): number {
  if (denominator === 0) return 100;
  return (numerator / denominator) * 100;
}

// ─── Data Layer ─────────────────────────────────────────────────────────────

type TenantRow = {
  name: string;
  slug: string;
  cost: number;
  sharePercent: number;
  isTopSpender: boolean;
};

type RecentTraceRow = {
  id: string;
  timestamp: Date;
  route: string;
  modelName: string;
  latencyMs: number;
  costUsd: number;
  status: string;
};

async function fetchDashboardMetrics() {
  const [
    spanTotals,
    llmLatency,
    totalTraces,
    errorTraces,
    costByProject,
    recentTraces
  ] = await Promise.all([
    prisma.span.aggregate({
      _sum: {
        calculatedCost: true,
        inputTokens: true,
        outputTokens: true
      }
    }),
    prisma.span.aggregate({
      where: { spanType: "llm" },
      _avg: { latencyMs: true }
    }),
    prisma.trace.count(),
    prisma.trace.count({ where: { status: "ERROR" } }),
    prisma.trace.groupBy({
      by: ["projectId"],
      _sum: { totalCostUsd: true },
      orderBy: { _sum: { totalCostUsd: "desc" } }
    }),
    prisma.trace.findMany({
      take: 10,
      orderBy: { startedAt: "desc" },
      select: {
        id: true,
        route: true,
        startedAt: true,
        latencyMs: true,
        totalCostUsd: true,
        status: true,
        spans: {
          where: { spanType: "llm" },
          select: { modelName: true },
          take: 1
        }
      }
    })
  ]);

  const totalCost = toNumber(spanTotals._sum.calculatedCost);
  const totalInputTokens = spanTotals._sum.inputTokens ?? 0;
  const totalOutputTokens = spanTotals._sum.outputTokens ?? 0;
  const totalTokens = totalInputTokens + totalOutputTokens;
  const avgLlmLatencyMs = llmLatency._avg.latencyMs ?? 0;
  const successRate = safeRate(totalTraces - errorTraces, totalTraces);

  const projectIds = costByProject.map((row) => row.projectId);
  const projects =
    projectIds.length > 0
      ? await prisma.project.findMany({
          where: { id: { in: projectIds } },
          select: {
            id: true,
            organization: { select: { name: true, slug: true } }
          }
        })
      : [];

  const orgByProject = new Map(
    projects.map((project) => [project.id, project.organization])
  );

  const tenantRows: TenantRow[] = costByProject
    .map((row) => {
      const org = orgByProject.get(row.projectId);
      const cost = toNumber(row._sum.totalCostUsd);
      return {
        name: org?.name ?? "Unknown",
        slug: org?.slug ?? "unknown",
        cost,
        sharePercent: safeRate(cost, totalCost),
        isTopSpender: false
      };
    })
    .sort((a, b) => b.cost - a.cost);

  if (tenantRows.length > 0) {
    tenantRows[0]!.isTopSpender = true;
  }

  const traceStream: RecentTraceRow[] = recentTraces.map((trace) => ({
    id: trace.id,
    timestamp: trace.startedAt,
    route: trace.route,
    modelName: trace.spans[0]?.modelName ?? "—",
    latencyMs: trace.latencyMs,
    costUsd: toNumber(trace.totalCostUsd),
    status: trace.status
  }));

  return {
    totalCost,
    totalTokens,
    avgLlmLatencyMs,
    successRate,
    errorTraces,
    totalTraces,
    tenants: tenantRows,
    recentTraces: traceStream
  };
}

// ─── UI Primitives ──────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  accent,
  subtext
}: {
  label: string;
  value: string;
  accent: "green" | "violet" | "slate";
  subtext?: string;
}) {
  const accentRing =
    accent === "green"
      ? "from-emerald-500/20 to-transparent"
      : accent === "violet"
        ? "from-violet-500/20 to-transparent"
        : "from-slate-500/10 to-transparent";

  const accentText =
    accent === "green"
      ? "text-emerald-400"
      : accent === "violet"
        ? "text-violet-400"
        : "text-slate-300";

  return (
    <article className="relative overflow-hidden rounded-xl border border-zinc-800/80 bg-zinc-950/60 p-5 backdrop-blur-sm">
      <div
        className={`pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r ${accentRing}`}
      />
      <p className="text-[10px] font-semibold uppercase tracking-[0.25em] text-zinc-500">
        {label}
      </p>
      <p className={`mt-3 font-mono text-3xl font-medium tracking-tight ${accentText}`}>
        {value}
      </p>
      {subtext ? (
        <p className="mt-2 text-xs text-zinc-600">{subtext}</p>
      ) : null}
    </article>
  );
}

function TenantBar({
  tenant,
  rank
}: {
  tenant: TenantRow;
  rank: number;
}) {
  const barColor = tenant.isTopSpender
    ? "bg-gradient-to-r from-violet-600 via-violet-500 to-emerald-400"
    : "bg-gradient-to-r from-zinc-700 to-zinc-600";

  return (
    <li className="group space-y-2.5">
      <div className="flex items-baseline justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="font-mono text-[10px] tabular-nums text-zinc-600">
            {String(rank).padStart(2, "0")}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-zinc-100">
              {tenant.name}
            </p>
            <p className="font-mono text-[10px] uppercase tracking-wider text-zinc-600">
              {tenant.slug}
            </p>
          </div>
          {tenant.isTopSpender ? (
            <span className="shrink-0 rounded border border-violet-500/30 bg-violet-500/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.15em] text-violet-300">
              Whale
            </span>
          ) : null}
        </div>
        <div className="shrink-0 text-right">
          <p className="font-mono text-sm tabular-nums text-zinc-200">
            {formatUsd(tenant.cost)}
          </p>
          <p className="font-mono text-[10px] tabular-nums text-zinc-600">
            {formatPercent(tenant.sharePercent)} of spend
          </p>
        </div>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-zinc-900 ring-1 ring-zinc-800/80">
        <div
          className={`h-full rounded-full transition-all ${barColor} ${tenant.isTopSpender ? "shadow-[0_0_12px_rgba(139,92,246,0.45)]" : ""}`}
          style={{ width: `${Math.min(tenant.sharePercent, 100)}%` }}
          role="meter"
          aria-valuenow={tenant.sharePercent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${tenant.name} budget share`}
        />
      </div>
    </li>
  );
}

function StatusBadge({ status }: { status: string }) {
  const isError = status === "ERROR";
  return (
    <span
      className={`inline-flex rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider ${
        isError
          ? "bg-red-950/60 text-red-400 ring-1 ring-red-500/20"
          : "bg-emerald-950/40 text-emerald-400 ring-1 ring-emerald-500/20"
      }`}
    >
      {status}
    </span>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default async function Home() {
  const metrics = await fetchDashboardMetrics();

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* Ambient grid */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 bg-[linear-gradient(rgba(255,255,255,0.015)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.015)_1px,transparent_1px)] bg-[size:64px_64px] [mask-image:radial-gradient(ellipse_at_center,black_20%,transparent_75%)]"
      />

      <div className="relative mx-auto max-w-7xl px-6 py-10 lg:px-8 lg:py-14">
        {/* Header */}
        <header className="mb-10 flex flex-col gap-6 border-b border-zinc-800/80 pb-8 lg:flex-row lg:items-end lg:justify-between">
          <div className="space-y-3">
            <p className="text-[10px] font-semibold uppercase tracking-[0.35em] text-emerald-500/80">
              FinOps Command Center
            </p>
            <h1 className="text-3xl font-semibold tracking-tight text-zinc-50 sm:text-4xl">
              LLM Spend{" "}
              <span className="bg-gradient-to-r from-violet-400 to-emerald-400 bg-clip-text text-transparent">
                Analytics
              </span>
            </h1>
            <p className="max-w-xl text-sm leading-relaxed text-zinc-500">
              Real-time cost telemetry aggregated from PostgreSQL via Prisma.
              Live data from your Docker-backed trace store on port{" "}
              <span className="font-mono text-zinc-400">5433</span>.
            </p>
          </div>
          <div className="flex items-center gap-3 font-mono text-[11px] text-zinc-500">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-40" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
            </span>
            <span>
              {metrics.totalTraces.toLocaleString()} traces indexed
            </span>
          </div>
        </header>

        {/* Executive Stats */}
        <section aria-label="Executive statistics" className="mb-10">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              accent="green"
              label="Total Cost"
              subtext="Sum of span calculatedCost"
              value={formatUsd(metrics.totalCost)}
            />
            <StatCard
              accent="violet"
              label="Total Tokens"
              subtext={`In + out across all spans`}
              value={formatTokens(metrics.totalTokens)}
            />
            <StatCard
              accent="slate"
              label="Avg Latency"
              subtext="LLM span category mean"
              value={formatLatencySeconds(metrics.avgLlmLatencyMs)}
            />
            <StatCard
              accent="green"
              label="Platform Health"
              subtext={`${metrics.errorTraces.toLocaleString()} error traces`}
              value={formatPercent(metrics.successRate)}
            />
          </div>
        </section>

        {/* Leaderboard + Side panel */}
        <div className="mb-10 grid gap-6 lg:grid-cols-5">
          {/* Tenant Billing Leaderboard */}
          <section
            aria-label="Tenant billing leaderboard"
            className="rounded-xl border border-zinc-800/80 bg-zinc-950/60 p-6 backdrop-blur-sm lg:col-span-3"
          >
            <div className="mb-6 flex items-center justify-between">
              <div>
                <h2 className="text-xs font-semibold uppercase tracking-[0.25em] text-zinc-400">
                  Tenant Billing
                </h2>
                <p className="mt-1 text-sm text-zinc-600">
                  Cost share by organization
                </p>
              </div>
              <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-600">
                groupBy projectId
              </span>
            </div>
            <ol className="space-y-6">
              {metrics.tenants.length > 0 ? (
                metrics.tenants.map((tenant, index) => (
                  <TenantBar key={tenant.slug} rank={index + 1} tenant={tenant} />
                ))
              ) : (
                <li className="py-8 text-center text-sm text-zinc-600">
                  No tenant data available. Run{" "}
                  <code className="font-mono text-zinc-400">npm run db:seed</code>{" "}
                  to populate mock organizations.
                </li>
              )}
            </ol>
          </section>

          {/* Spend breakdown mini panel */}
          <aside className="rounded-xl border border-zinc-800/80 bg-zinc-950/60 p-6 backdrop-blur-sm lg:col-span-2">
            <h2 className="text-xs font-semibold uppercase tracking-[0.25em] text-zinc-400">
              Spend Distribution
            </h2>
            <div className="mt-6 space-y-4">
              {metrics.tenants.map((tenant) => (
                <div key={tenant.slug} className="flex items-center gap-3">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-zinc-800 bg-zinc-900 font-mono text-[10px] text-zinc-500">
                    {tenant.name.slice(0, 2).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex justify-between text-xs">
                      <span className="truncate text-zinc-400">{tenant.name}</span>
                      <span className="ml-2 shrink-0 font-mono tabular-nums text-zinc-500">
                        {formatPercent(tenant.sharePercent, 0)}
                      </span>
                    </div>
                    <div className="mt-1.5 flex h-1.5 gap-px overflow-hidden rounded-sm bg-zinc-900">
                      {Array.from({ length: 20 }).map((_, i) => {
                        const filled = i < Math.round(tenant.sharePercent / 5);
                        return (
                          <div
                            key={i}
                            className={`flex-1 ${
                              filled
                                ? tenant.isTopSpender
                                  ? "bg-violet-500"
                                  : "bg-zinc-600"
                                : "bg-zinc-800/50"
                            }`}
                          />
                        );
                      })}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-8 rounded-lg border border-zinc-800/60 bg-zinc-900/40 p-4">
              <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-zinc-600">
                Anomaly Window
              </p>
              <p className="mt-2 text-xs leading-relaxed text-zinc-500">
                Error rate reflects simulated provider spikes on anomaly days
                (days 4, 11, 19, 27). Current error footprint:{" "}
                <span className="font-mono text-red-400/80">
                  {formatPercent(safeRate(metrics.errorTraces, metrics.totalTraces))}
                </span>
              </p>
            </div>
          </aside>
        </div>

        {/* Recent Trace Stream */}
        <section
          aria-label="Recent trace stream"
          className="overflow-hidden rounded-xl border border-zinc-800/80 bg-zinc-950/60 backdrop-blur-sm"
        >
          <div className="flex items-center justify-between border-b border-zinc-800/80 px-5 py-4">
            <div>
              <h2 className="text-xs font-semibold uppercase tracking-[0.25em] text-zinc-400">
                Recent Trace Stream
              </h2>
              <p className="mt-0.5 text-sm text-zinc-600">
                Last 10 transactions · high-density log view
              </p>
            </div>
            <span className="hidden font-mono text-[10px] uppercase tracking-wider text-zinc-600 sm:inline">
              ordered by startedAt desc
            </span>
          </div>

          {/* Column headers */}
          <div className="hidden border-b border-zinc-800/60 bg-zinc-900/30 px-5 py-2.5 text-[10px] font-semibold uppercase tracking-[0.2em] text-zinc-600 sm:grid sm:grid-cols-[140px_1fr_120px_80px_100px_60px] sm:gap-4">
            <span>Timestamp</span>
            <span>Endpoint</span>
            <span>Model</span>
            <span className="text-right">Latency</span>
            <span className="text-right">Cost</span>
            <span className="text-right">Status</span>
          </div>

          <div className="scrollbar-hide max-h-[420px] overflow-y-auto">
            {metrics.recentTraces.length > 0 ? (
              <ul className="divide-y divide-zinc-800/50">
                {metrics.recentTraces.map((trace) => (
                  <li
                    key={trace.id}
                    className="px-5 py-3 transition-colors hover:bg-zinc-900/40 sm:grid sm:grid-cols-[140px_1fr_120px_80px_100px_60px] sm:items-center sm:gap-4"
                  >
                    <time
                      className="block font-mono text-[11px] tabular-nums text-zinc-500"
                      dateTime={trace.timestamp.toISOString()}
                    >
                      {formatTimestamp(trace.timestamp)}
                    </time>
                    <span className="mt-1 block truncate font-mono text-xs text-emerald-400/90 sm:mt-0">
                      {trace.route}
                    </span>
                    <span className="mt-1 block truncate font-mono text-[11px] text-violet-400/80 sm:mt-0">
                      {trace.modelName}
                    </span>
                    <span className="mt-1 block font-mono text-[11px] tabular-nums text-zinc-400 sm:mt-0 sm:text-right">
                      {formatLatencySeconds(trace.latencyMs)}
                    </span>
                    <span className="mt-1 block font-mono text-[11px] tabular-nums text-zinc-300 sm:mt-0 sm:text-right">
                      {formatMicroCost(trace.costUsd)}
                    </span>
                    <span className="mt-2 block sm:mt-0 sm:text-right">
                      <StatusBadge status={trace.status} />
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-5 py-12 text-center text-sm text-zinc-600">
                No traces recorded yet.
              </p>
            )}
          </div>
        </section>

        <footer className="mt-8 text-center font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-700">
          Flight Recorder · Prisma 7 · PostgreSQL · Next.js App Router
        </footer>
      </div>
    </main>
  );
}
