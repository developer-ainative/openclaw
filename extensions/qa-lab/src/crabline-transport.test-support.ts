import type { OpenClawCrablineChannelDriverSelection } from "@openclaw/crabline";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { createQaBusState } from "./bus-state.js";
import { createQaCrablineTransportAdapter } from "./crabline-transport.js";

export type CrablineTransport = Awaited<ReturnType<typeof createQaCrablineTransportAdapter>>;

export function createSelection(
  channel: OpenClawCrablineChannelDriverSelection["channel"] = "telegram",
) {
  return {
    capabilityMatrixPath: "crabline-channel-driver-capabilities.json",
    channel,
    channelDriver: "crabline",
    providerReadinessArtifactPath: "crabline-provider-readiness.json",
  } as const;
}

export function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`${label} is required`);
  }
  return value;
}

export async function withTransport(
  channel: OpenClawCrablineChannelDriverSelection["channel"],
  run: (transport: CrablineTransport, outputDir: string) => Promise<void>,
  transportPolicy?: Parameters<typeof createQaCrablineTransportAdapter>[0]["transportPolicy"],
) {
  await withTempDir("qa-crabline-transport-", async (outputDir) => {
    const transport = await createQaCrablineTransportAdapter({
      outputDir,
      selection: createSelection(channel),
      state: createQaBusState(),
      transportPolicy,
    });
    try {
      await run(transport, outputDir);
    } finally {
      await transport.cleanupAfterGatewayStop();
    }
  });
}
