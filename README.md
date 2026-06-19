# LLMTokenLedger

> Sub-penny LLM telemetry with CI budget enforcement — monitors token spend, aggregates fractional-cent metrics, and blocks cost regressions inside CI/CD pipelines.

---

## 2. SYSTEM ARCHITECTURE DIAGRAM (Placeholder)

<!-- Replace this block with the production tech infographic -->
<!-- Data flow: SDK App → Docker Postgres → Next.js Dashboard & CI/CD Gate -->

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                                                                         │
│   [ PLACEHOLDER: System Architecture Infographic ]                                      │
│                                                                                         │
│   SDK App  ──►  Docker Postgres  ──►  Next.js Dashboard  &  CI/CD Budget Gate          │
│                                                                                         │
│   Left-to-right data flow: ingest → persist → visualize → enforce                       │
│                                                                                         │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. CORE TECHNICAL HIGHLIGHTS

### Asynchronous In-Memory Batching

- **Zero hot-path blocking** — `FlightRecorderClient.trace()` completes the application callback first; telemetry serialization runs in a `finally` block after the response is returned.
- **Microtask-scheduled flushes** — when the in-memory buffer hits 10 records, `queueMicrotask()` defers persistence to the next event-loop tick; sub-threshold batches drain on a 3-second debounced timer.
- **Backpressure-safe writes** — failed PostgreSQL batch inserts re-queue at the head of the buffer; concurrent flush cycles are serialized with a mutex flag so the application thread never awaits I/O.
- **Network amortization** — multi-record upserts collapse org/project/trace/span writes into a single transactional round-trip instead of per-request chatter.

### Precise Sub-Penny Token Economics

- **Local `cl100k_base` tiktoken estimators** — input and output token counts are computed in-process via `@dqbd/tiktoken`; no round-trip to provider billing APIs during trace capture.
- **Provider-agnostic usage extraction** — the SDK normalizes OpenAI, Anthropic, and generic `{ usage: { prompt_tokens, completion_tokens } }` response shapes before falling back to text inference.
- **Fuzzy model pricing dictionary** — exact-match lookup on normalized model slugs; substring fallback maps versioned identifiers (`gpt-4o-mini-2024-07-18`) to canonical rate cards without hard-coded per-version entries.
- **`Decimal(18, 12)` persistence** — PostgreSQL stores fractional-cent costs without IEEE-754 drift; budget math operates at six-decimal USD precision in the CI gate.

### Automated CI/CD Budget Gate

- **Rolling 7-day baseline** — `scripts/evaluate-budget.ts` aggregates OK-status traces for a target route, computing mean cost per trace over the trailing window.
- **Golden-dataset simulation** — 10 canonical prompt/response pairs are tokenized and priced against the candidate model before merge; projected average cost is compared to historical reality, not static thresholds.
- **Explicit process exit semantics** — `process.exit(0)` on pass, `process.exit(1)` on regression; CI runners treat non-zero exit as a hard merge block with a structured terminal audit report.
- **20% regression envelope** — projected cost must stay within `baseline × 1.20`; breaches emit a full per-sample breakdown (input tokens, output tokens, simulated USD) for FinOps triage.

---

## 4. SYSTEM INSTALLATION & LOCAL VERIFICATION

Ensure PostgreSQL credentials are available before starting. The bundled Docker service exposes Postgres on **port 5433**:

```env
DATABASE_URL="postgresql://flight_recorder:flight_recorder_password@localhost:5433/flight_recorder?schema=public"
```

### Bootstrap

```bash
# Install dependencies
npm install

# Launch isolated Postgres (pgvector image, health-checked, persistent volume)
docker compose up -d

# Synchronize schema to the running database
npx prisma db push

# Generate 30-day telemetry matrix (~1,500 traces, multi-tenant, sub-penny costs)
npm run db:seed
```

### Verify the Budget Gate

```bash
# Run the terminal budget auditor against seeded historical data
npx tsx scripts/evaluate-budget.ts
```

A successful run prints baseline statistics and exits `0`. A cost regression prints a per-sample golden-dataset table and exits `1` — the same signal a CI pipeline uses to block deployment.

Optional: start the Next.js dashboard and trace ingestion API.

```bash
npm run dev
```

Trace ingestion endpoint: `POST /api/v1/traces`
