# LLMTokenLedger

![LLM spend analytics dashboard](docs/dashboard.png)

A lightweight **tracking runtime** for LLM backends. Wrap your model calls once and every request automatically records input tokens, output tokens, cost, and latency.

Think of it as a thin layer around your existing LLM code. Your app stays the same. LLMTokenLedger handles the accounting.

## What it does

**At runtime:** wraps LLM calls in your backend and logs token usage as they happen

**In storage:** saves traces to PostgreSQL with sub penny cost precision

**In the dashboard:** shows total spend, token volume, and per request history

**In CI (optional):** fails the build if a prompt change pushes cost too high

## Quick start
```bash
npm install
cp .env.example .env
docker compose up -d
npx prisma db push
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) for the dashboard.

Optional demo data:

```bash
npm run db:seed
```

## Integrate into your backend

Add the SDK wrapper around any LLM call. Token counting and cost calculation happen at runtime without blocking your response.
```typescript
import { FlightRecorder } from "@/lib/flight-recorder-sdk";

const response = await FlightRecorder.trace(
  {
    featureName: "chat",
    modelName: "gpt-4o-mini",
    route: "/api/chat",
    input: prompt,
  },
  () => openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
  })
);
```

Works with OpenAI, Anthropic, and any provider that returns token usage in the response.

### Or send traces over HTTP

If your backend is a separate service, POST to the ingestion API:

```
POST /api/v1/traces
```

## What you get

**Token + cost tracking** per request (input/output tokens, USD)

**Dashboard** for total spend, latency, and recent traces

**Budget gate** as an optional CI check to block expensive prompt changes

```bash
npm run budget:check
```

## Stack

Next.js · PostgreSQL · Prisma · TypeScript
