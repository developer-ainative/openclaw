import { beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { SessionRowProjection } from "../session-row-projection.js";
import {
  roleClient,
  rolePolicyConfig,
  sharingPolicyClient,
} from "../session-sharing.test-utils.js";
import {
  ArtifactSessionResolutionError,
  createArtifactSessionAccess,
  prepareArtifactSessionResolution,
  type ArtifactQuery,
} from "./artifacts-session-resolution.js";
import type { GatewayClient } from "./types.js";

const mocks = vi.hoisted(() => ({
  resolveRunSession: vi.fn(),
}));

vi.mock("../server-session-key.js", () => ({
  resolveSessionForRun: mocks.resolveRunSession,
}));

async function resolveSession(
  query: ArtifactQuery,
  cfg: OpenClawConfig | undefined,
  client: GatewayClient | null,
) {
  using access = createArtifactSessionAccess({
    getRuntimeConfig: () => cfg ?? {},
    client,
  });
  const resolve = await prepareArtifactSessionResolution(query);
  const selected = await resolve(access);
  return selected ? { sessionKey: selected.sessionKey, agentId: selected.agentId } : undefined;
}

function expectSession(
  sessionKey: string,
  query: ArtifactQuery,
  cfg: OpenClawConfig | undefined,
  client: GatewayClient | null,
) {
  return expect(resolveSession(query, cfg, client)).resolves.toMatchObject({ sessionKey });
}

function putSession(sessionKey: string, entry: Parameters<typeof upsertSessionEntryCore>[1]) {
  return upsertSessionEntryCore(
    { agentId: "main", sessionKey },
    {
      sessionId: `session-${sessionKey.split(":").at(-1)}`,
      updatedAt: 1,
      ...entry,
    },
  );
}

function identifiedClient(scopes: string[], profileId = "viewer@example.com"): GatewayClient {
  return {
    ...sharingPolicyClient({ user: profileId, scopes }),
    authenticatedUserId: "viewer@example.com",
  };
}

const profileState = { scenario: "minimal", prepareProfileCatalog: true } as const;

describe("artifact session authorization", () => {
  beforeEach(() => vi.clearAllMocks());

  it("waits for indirect artifact topology without waiting for unrelated row enrichment", async () => {
    const unavailable = new Error("session projection is unavailable");
    const projection = {
      sharingRevision: undefined,
      sharingTarget: vi.fn(),
      sharingTargetState: vi.fn(),
      readSource: vi.fn(),
      readMembership: vi.fn(),
      needsMembershipPreparation: vi.fn(),
      prepareMembership: vi.fn(),
      ensureMaterialized: vi
        .fn<SessionRowProjection["ensureMaterialized"]>()
        .mockRejectedValue(unavailable),
      findBySessionId: vi.fn<SessionRowProjection["findBySessionId"]>(),
    } satisfies NonNullable<Parameters<typeof prepareArtifactSessionResolution>[1]>;
    await expect(
      prepareArtifactSessionResolution({ sessionKey: "agent:main:main" }, projection),
    ).resolves.toBeTypeOf("function");
    expect(projection.ensureMaterialized).not.toHaveBeenCalled();
    await expect(prepareArtifactSessionResolution({ runId: "run-1" }, projection)).rejects.toBe(
      unavailable,
    );
    const current = { ...projection, sharingRevision: {} };
    await expect(prepareArtifactSessionResolution({ runId: "run-1" }, current)).resolves.toBeTypeOf(
      "function",
    );
  });

  it("denies direct and indirect incognito selectors while preserving admin access", async () => {
    await withOpenClawTestState(profileState, async () => {
      const sessionKey = "agent:main:dashboard:incognito-artifacts";
      const cfg = { agents: { entries: { main: {} } } };
      setRuntimeConfigSnapshot(cfg);
      await putSession(sessionKey, {
        incognito: true,
        visibility: "shared",
      });
      mocks.resolveRunSession.mockReturnValue({ sessionKey, agentId: "main" });
      const viewer = identifiedClient(["operator.read"]);

      await expect(
        resolveSession(
          { sessionKey: "dashboard:incognito-artifacts", agentId: "main" },
          cfg,
          viewer,
        ),
      ).rejects.toThrow('Incognito session "dashboard:incognito-artifacts" was not found.');
      await expect(resolveSession({ runId: "run-private" }, cfg, viewer)).rejects.toMatchObject({
        constructor: ArtifactSessionResolutionError,
        shape: {
          message: "no session found for artifact query",
          details: { type: "artifact_scope_not_found" },
        },
      });
      await expectSession(
        sessionKey,
        { sessionKey: "dashboard:incognito-artifacts", agentId: "main" },
        cfg,
        identifiedClient(["operator.admin"]),
      );
    });
  });

  it.each([
    { name: "draft without roles", visibility: "draft", cfg: {}, role: undefined },
    { name: "draft without runtime config", visibility: "draft", cfg: undefined, role: undefined },
    {
      name: "shared with a none role",
      visibility: "shared",
      cfg: rolePolicyConfig(),
      role: "none",
    },
    {
      name: "draft with a write role",
      visibility: "draft",
      cfg: rolePolicyConfig(),
      role: "write",
    },
  ] as const)(
    "hides $name artifacts behind direct and run selectors",
    async ({ visibility, cfg, role }) => {
      await withOpenClawTestState(profileState, async () => {
        setRuntimeConfigSnapshot(cfg ?? {});
        const viewerProfile = ensureProfileForEmail("viewer@example.com");
        const ownerProfile = ensureProfileForEmail("owner@example.com");
        using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
        const sessionKey = "agent:main:foreign-artifacts";
        await putSession(sessionKey, {
          createdActor: { type: "human", source: "profile", id: ownerProfile.id },
          visibility,
        });
        mocks.resolveRunSession.mockReturnValue({ sessionKey, agentId: "main" });
        const viewer = role
          ? roleClient(role, "artifact-viewer")
          : identifiedClient(["operator.read"], viewerProfile.id);

        for (const query of [{ sessionKey }, { runId: "run-foreign" }]) {
          await expect(resolveSession(query, cfg, viewer)).rejects.toThrowError(
            expect.objectContaining({
              shape: {
                code: "INVALID_REQUEST",
                message: "no session found for artifact query",
                details: { type: "artifact_scope_not_found" },
              },
            }),
          );
        }

        await expectSession(
          sessionKey,
          { sessionKey },
          cfg,
          identifiedClient(["operator.read"], ownerProfile.id),
        );
        await expectSession(
          sessionKey,
          { runId: "run-foreign" },
          cfg,
          identifiedClient(["operator.admin"], viewerProfile.id),
        );
      });
    },
  );

  it.each(["shared", "read-only", "suggest"] as const)(
    "allows reading foreign %s artifacts without participation",
    async (visibility) => {
      await withOpenClawTestState(profileState, async () => {
        setRuntimeConfigSnapshot({});
        const owner = ensureProfileForEmail("artifact-owner@example.test");
        const viewer = roleClient("view", "artifact-reader");
        using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
        const sessionKey = "agent:main:readable-artifacts";
        await putSession(sessionKey, {
          createdActor: { type: "human", source: "profile", id: owner.id },
          visibility,
        });

        for (const cfg of [undefined, {}, rolePolicyConfig()]) {
          await expectSession(sessionKey, { sessionKey }, cfg, viewer);
        }
      });
    },
  );

  it("preserves solo and system reads while denying identityless reads with roles", async () => {
    await withOpenClawTestState(profileState, async () => {
      setRuntimeConfigSnapshot({});
      const sessionKey = "agent:main:solo-artifacts";
      await putSession(sessionKey, {
        visibility: "draft",
      });
      const identityless = sharingPolicyClient({});
      for (const client of [null, identityless, sharingPolicyClient({ user: "gateway-owner" })]) {
        await expectSession(sessionKey, { sessionKey }, {}, client);
      }
      const cfg = rolePolicyConfig();
      await expect(resolveSession({ sessionKey }, cfg, identityless)).rejects.toThrow(
        "no session found for artifact query",
      );
      const system: GatewayClient = {
        ...identityless,
        internal: { operatorRoleActor: { kind: "system" } },
      };
      await expectSession(sessionKey, { sessionKey }, cfg, system);
    });
  });
});
