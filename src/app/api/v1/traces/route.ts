import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { persistTelemetryPacket, telemetryPacketSchema } from "@/lib/telemetry";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    name: "LLMTokenLedger trace ingestion",
    accepts: "POST",
    schema: {
      organization: "{ slug, name? }",
      project: "{ slug, name? }",
      trace: "{ traceId, route, status?, startedAt, endedAt?, latencyMs, totalCostUsd?, metadata? }",
      spans:
        "[{ spanId, parentSpanId?, spanType, name, status?, modelName?, inputTokens?, outputTokens?, calculatedCostUsd?, latencyMs, startedAt, endedAt?, metadata? }]"
    }
  });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const packet = telemetryPacketSchema.parse(body);
    const result = await persistTelemetryPacket(packet);

    return NextResponse.json(
      {
        ok: true,
        traceId: result.traceId,
        projectId: result.projectId
      },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json(
        {
          ok: false,
          error: "Invalid telemetry payload",
          issues: error.issues
        },
        { status: 400 }
      );
    }

    if (error instanceof SyntaxError) {
      return NextResponse.json(
        {
          ok: false,
          error: "Request body must be valid JSON"
        },
        { status: 400 }
      );
    }

    console.error("Trace ingestion failed", error);

    return NextResponse.json(
      {
        ok: false,
        error: "Trace ingestion failed"
      },
      { status: 500 }
    );
  }
}
