// PostHog Cloud AI observability via the official eve instrumentation hook.
// No-op (no OTel registration, no network) unless POSTHOG_PROJECT_TOKEN is set.
import { defineInstrumentation } from "eve/instrumentation";
import { registerOTel } from "@vercel/otel";
import { PostHogTraceExporter } from "@posthog/ai/otel";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";

const setup = ({ agentName }: { agentName: string }): void => {
  const projectToken = process.env.POSTHOG_PROJECT_TOKEN;
  if (!projectToken) return;
  try {
    // Test seam: proves setup ran against a token-bearing env.
    (globalThis as { __otelRegistered?: boolean }).__otelRegistered = true;
    registerOTel({
      serviceName: agentName,
      spanProcessors: [
        new BatchSpanProcessor(
          new PostHogTraceExporter({
            projectToken,
            host: process.env.POSTHOG_HOST || undefined,
          }),
        ),
      ],
    });
  } catch {
    // Exporter registration failure is never fatal to boot.
  }
};

export default defineInstrumentation({
  setup,
  events: {
    "step.started"(input) {
      const principalId =
        input.session.auth.initiator?.principalId ?? input.session.auth.current?.principalId;
      if (!principalId) return undefined;
      return {
        runtimeContext: {
          "posthog.distinct_id": principalId,
        },
      };
    },
  },
});
