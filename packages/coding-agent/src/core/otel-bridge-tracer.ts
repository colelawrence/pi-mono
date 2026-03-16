/**
 * otel-bridge-tracer.ts — Effect Tracer → OTEL SDK bridge for epi.
 *
 * Delegates Effect span creation to the OTEL tracer managed by telemetry-otel extension.
 * Reads telemetry-otel's registries via Symbol.for (read-only, never writes).
 * When telemetry-otel is not loaded, returns noop spans.
 */
import type { Exit, Option } from "effect"
import { Context, Tracer } from "effect"
import * as OtelApi from "@opentelemetry/api"

// Symbol.for keys — must match telemetry-otel exactly (read-only consumers)
const ACTIVE_SPAN_CONTEXT_REGISTRY = Symbol.for("pi.telemetry-otel.activeSpanContextRegistry.v1")
const RUNTIME_REGISTRY = Symbol.for("pi.telemetry-otel.runtimeRegistry.v1")

// Key to stash the OTEL span inside an Effect span's context (for parent resolution)
const OTEL_SPAN_KEY = Symbol.for("pi.epi.otelSpanBridge.v1")

// Registries are Map<string, T> — must match telemetry-otel's registry shape exactly.
// See: telemetry-otel/extensions/span-context-registry.ts and runtime-registry.ts

interface SpanContextLike {
  traceId: string
  spanId: string
  traceFlags?: number
}

interface TelemetryRuntimeLike {
  tracer: OtelApi.Tracer
}

type GlobalWithRegistries = {
  [key: symbol]: unknown
}

function getActiveSpanContext(sessionId: string): OtelApi.SpanContext | undefined {
  const registry = (globalThis as unknown as GlobalWithRegistries)[ACTIVE_SPAN_CONTEXT_REGISTRY] as
    | Map<string, SpanContextLike>
    | undefined
  const ctx = registry?.get(sessionId)
  if (!ctx) return undefined
  return {
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    traceFlags: ctx.traceFlags ?? OtelApi.TraceFlags.SAMPLED,
  }
}

function getOtelTracer(sessionId: string): OtelApi.Tracer | undefined {
  const registry = (globalThis as unknown as GlobalWithRegistries)[RUNTIME_REGISTRY] as
    | Map<string, TelemetryRuntimeLike>
    | undefined
  return registry?.get(sessionId)?.tracer
}

function effectKindToOtel(kind: Tracer.SpanKind): OtelApi.SpanKind {
  switch (kind) {
    case "client":
      return OtelApi.SpanKind.CLIENT
    case "server":
      return OtelApi.SpanKind.SERVER
    case "producer":
      return OtelApi.SpanKind.PRODUCER
    case "consumer":
      return OtelApi.SpanKind.CONSUMER
    default:
      return OtelApi.SpanKind.INTERNAL
  }
}

function bigintNsToHrTime(ns: bigint): OtelApi.HrTime {
  const ms = Number(ns / 1_000_000n)
  const remainderNs = Number(ns % 1_000_000n)
  // HrTime is [seconds, nanoseconds]
  const seconds = Math.floor(ms / 1000)
  const nanoRemainder = (ms % 1000) * 1_000_000 + remainderNs
  return [seconds, nanoRemainder]
}

/**
 * Resolve the OTEL parent context for an Effect span.
 *
 * Priority:
 * 1. If the Effect parent span has an OTEL span stashed in it, use that.
 * 2. Fall back to the activeSpanContextRegistry (telemetry-otel's session-level active span).
 * 3. Fall back to OtelApi.context.active() (process-level active context).
 */
function resolveParentContext(parent: Option.Option<Tracer.AnySpan>, sessionId: string): OtelApi.Context {
  // Check for an Effect-internal parent with a stashed OTEL span
  if (parent._tag === "Some") {
    const parentSpan = parent.value
    const stashed = (parentSpan as unknown as Record<symbol, unknown>)[OTEL_SPAN_KEY]
    if (stashed !== undefined) {
      const otelSpan = stashed as OtelApi.Span
      return OtelApi.trace.setSpan(OtelApi.context.active(), otelSpan)
    }
    // ExternalSpan: try to reconstruct from spanId/traceId
    if (parentSpan._tag === "ExternalSpan") {
      // We can't reconstruct a full span context without the full traceFlags;
      // fall through to registry-based lookup.
    }
  }

  // Check telemetry-otel's session-level active span context registry
  const spanContext = getActiveSpanContext(sessionId)
  if (spanContext) {
    return OtelApi.trace.setSpanContext(OtelApi.context.active(), spanContext)
  }

  // Fall back to OTEL's current active context
  return OtelApi.context.active()
}

/**
 * Create a noop Effect Span — used when telemetry-otel is not loaded.
 */
function makeNoopSpan(name: string, parent: Option.Option<Tracer.AnySpan>, startTime: bigint): Tracer.Span {
  const spanId = Math.random().toString(36).slice(2, 18).padEnd(16, "0")
  const traceId =
    parent._tag === "Some"
      ? parent.value.traceId
      : (Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)).slice(0, 32)

  const attrs = new Map<string, unknown>()
  const status: Tracer.SpanStatus = { _tag: "Started", startTime }

  return {
    _tag: "Span",
    name,
    spanId,
    traceId,
    parent,
    context: Context.empty(),
    get status() {
      return status
    },
    get attributes() {
      return attrs
    },
    links: [],
    sampled: false,
    kind: "internal",
    end(_endTime: bigint, _exit: Exit.Exit<unknown, unknown>): void {},
    attribute(key: string, value: unknown): void {
      attrs.set(key, value)
    },
    event(_name: string, _startTime: bigint, _attributes?: Record<string, unknown>): void {},
    addLinks(_links: ReadonlyArray<Tracer.SpanLink>): void {},
  }
}

/**
 * Create an Effect Span backed by a real OTEL span.
 */
function makeOtelBackedSpan(
  name: string,
  otelSpan: OtelApi.Span,
  parent: Option.Option<Tracer.AnySpan>,
  startTime: bigint,
  kind: Tracer.SpanKind,
): Tracer.Span {
  const otelCtx = otelSpan.spanContext()
  const attrs = new Map<string, unknown>()
  let currentStatus: Tracer.SpanStatus = { _tag: "Started", startTime }

  const span: Tracer.Span & Record<symbol, unknown> = {
    _tag: "Span",
    name,
    spanId: otelCtx.spanId,
    traceId: otelCtx.traceId,
    parent,
    context: Context.empty(),
    get status() {
      return currentStatus
    },
    get attributes() {
      return attrs
    },
    links: [],
    sampled: (otelCtx.traceFlags & OtelApi.TraceFlags.SAMPLED) !== 0,
    kind,
    end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
      currentStatus = { _tag: "Ended", startTime, endTime, exit }
      const code = exit._tag === "Failure" ? OtelApi.SpanStatusCode.ERROR : OtelApi.SpanStatusCode.OK
      otelSpan.setStatus({ code })
      otelSpan.end(bigintNsToHrTime(endTime))
    },
    attribute(key: string, value: unknown): void {
      attrs.set(key, value)
      if (
        value !== null &&
        value !== undefined &&
        (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
      ) {
        otelSpan.setAttribute(key, value)
      } else {
        otelSpan.setAttribute(key, String(value))
      }
    },
    event(evName: string, evTime: bigint, attributes?: Record<string, unknown>): void {
      const otelAttrs: OtelApi.Attributes | undefined = attributes as OtelApi.Attributes | undefined
      otelSpan.addEvent(evName, otelAttrs, bigintNsToHrTime(evTime))
    },
    addLinks(_links: ReadonlyArray<Tracer.SpanLink>): void {
      // OTEL links must be set at span creation; post-creation add is not supported.
    },
    [OTEL_SPAN_KEY]: otelSpan,
  }

  return span
}

/**
 * Create an Effect Tracer that bridges to the OTEL SDK used by telemetry-otel.
 *
 * - When telemetry-otel is not loaded: returns noop spans (zero overhead).
 * - When telemetry-otel is loaded: creates real OTEL spans, reads activeSpanContextRegistry
 *   for parent resolution (read-only — never writes to it).
 */
export function makeOtelBridgeTracer(sessionId: string): Tracer.Tracer {
  return {
    [Tracer.TracerTypeId]: Tracer.TracerTypeId as unknown as typeof Tracer.TracerTypeId,

    span(
      name: string,
      parent: Option.Option<Tracer.AnySpan>,
      _context: Context.Context<never>,
      _links: ReadonlyArray<Tracer.SpanLink>,
      startTime: bigint,
      kind: Tracer.SpanKind,
    ): Tracer.Span {
      const otelTracer = getOtelTracer(sessionId)

      if (!otelTracer) {
        return makeNoopSpan(name, parent, startTime)
      }

      const parentContext = resolveParentContext(parent, sessionId)
      const otelSpan = otelTracer.startSpan(
        name,
        {
          kind: effectKindToOtel(kind),
          startTime: bigintNsToHrTime(startTime),
        },
        parentContext,
      )

      return makeOtelBackedSpan(name, otelSpan, parent, startTime, kind)
    },

    context<X>(f: () => X): X {
      return f()
    },
  } as unknown as Tracer.Tracer
}
