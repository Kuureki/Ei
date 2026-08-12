// agent/sandbox/sandbox.ts
import { defineSandbox, type SandboxBackend } from "eve/sandbox";
import { createHostSession, type HostProcess } from "../../lib/host-sandbox";

/**
 * Hermes-style host backend: no isolation. The built-in bash / file tools
 * operate on the real VPS filesystem from EI_AGENT_ROOT (default "/").
 */
export const HOST_BACKEND: SandboxBackend = {
  name: "host",
  async prewarm() {
    return { reused: false };
  },
  async create({ sessionKey }) {
    const root = process.env.EI_AGENT_ROOT ?? "/";
    const tracked = new Set<HostProcess>();
    const session = createHostSession(root, { id: `host-${sessionKey}`, track: tracked });
    return {
      session,
      useSessionFn: async () => session,
      captureState: async () => ({ backendName: "host", sessionKey, metadata: { root } }),
      shutdown: async () => {
        for (const p of tracked) await p.kill();
      },
    };
  },
};

export default defineSandbox({ backend: HOST_BACKEND });
