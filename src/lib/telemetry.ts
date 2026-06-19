import type { Prisma } from "@prisma/client";
import { z } from "zod";

import { prisma } from "@/lib/prisma";

export const traceStatusSchema = z.enum(["OK", "ERROR", "CANCELLED"]);
export const spanStatusSchema = z.enum(["OK", "ERROR", "CANCELLED"]);
export const spanTypeSchema = z.enum(["llm", "db", "tool", "http", "cache", "other"]);

const metadataSchema = z.record(z.string(), z.unknown());

export const telemetrySpanSchema = z.object({
  spanId: z.string().min(1),
  parentSpanId: z.string().min(1).optional(),
  spanType: spanTypeSchema,
  name: z.string().min(1),
  status: spanStatusSchema.default("OK"),
  modelName: z.string().min(1).optional(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  calculatedCostUsd: z.number().nonnegative().default(0),
  latencyMs: z.number().int().nonnegative(),
  startedAt: z.coerce.date(),
  endedAt: z.coerce.date().optional(),
  metadata: metadataSchema.optional()
});

export const telemetryTraceSchema = z.object({
  traceId: z.string().min(1),
  route: z.string().min(1),
  status: traceStatusSchema.default("OK"),
  startedAt: z.coerce.date(),
  endedAt: z.coerce.date().optional(),
  latencyMs: z.number().int().nonnegative(),
  totalCostUsd: z.number().nonnegative().default(0),
  metadata: metadataSchema.optional()
});

export const telemetryPacketSchema = z.object({
  organization: z.object({
    slug: z.string().min(1),
    name: z.string().min(1).optional()
  }),
  project: z.object({
    slug: z.string().min(1),
    name: z.string().min(1).optional()
  }),
  trace: telemetryTraceSchema,
  spans: z.array(telemetrySpanSchema).default([])
});

export type TelemetryPacket = z.infer<typeof telemetryPacketSchema>;
export type TelemetrySpan = z.infer<typeof telemetrySpanSchema>;

export async function persistTelemetryPacket(packet: TelemetryPacket) {
  return prisma.$transaction(async (tx) => {
    const organization = await tx.organization.upsert({
      where: { slug: packet.organization.slug },
      create: {
        slug: packet.organization.slug,
        name: packet.organization.name ?? packet.organization.slug
      },
      update: {
        name: packet.organization.name ?? packet.organization.slug
      }
    });

    const project = await tx.project.upsert({
      where: {
        organizationId_slug: {
          organizationId: organization.id,
          slug: packet.project.slug
        }
      },
      create: {
        organizationId: organization.id,
        slug: packet.project.slug,
        name: packet.project.name ?? packet.project.slug
      },
      update: {
        name: packet.project.name ?? packet.project.slug
      }
    });

    const trace = await tx.trace.upsert({
      where: { traceId: packet.trace.traceId },
      create: {
        traceId: packet.trace.traceId,
        projectId: project.id,
        route: packet.trace.route,
        status: packet.trace.status,
        startedAt: packet.trace.startedAt,
        endedAt: packet.trace.endedAt,
        latencyMs: packet.trace.latencyMs,
        totalCostUsd: packet.trace.totalCostUsd,
        metadata: packet.trace.metadata as Prisma.InputJsonValue | undefined
      },
      update: {
        projectId: project.id,
        route: packet.trace.route,
        status: packet.trace.status,
        startedAt: packet.trace.startedAt,
        endedAt: packet.trace.endedAt,
        latencyMs: packet.trace.latencyMs,
        totalCostUsd: packet.trace.totalCostUsd,
        metadata: packet.trace.metadata as Prisma.InputJsonValue | undefined
      }
    });

    await Promise.all(
      packet.spans.map((span) =>
        tx.span.upsert({
          where: {
            traceId_spanId: {
              traceId: trace.traceId,
              spanId: span.spanId
            }
          },
          create: {
            traceId: trace.traceId,
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
            metadata: span.metadata as Prisma.InputJsonValue | undefined
          },
          update: {
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
            metadata: span.metadata as Prisma.InputJsonValue | undefined
          }
        })
      )
    );

    return { traceId: trace.traceId, projectId: project.id };
  });
}
