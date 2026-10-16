// Verifies SQLite-backed outbound queue storage, metadata, failure updates,
// recovery-state markers, and failed-entry moves.
import fs from "node:fs/promises";
import path from "node:path";
import { assert, describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import {
  updateDeliveryQueueEntryInDatabase,
  upsertDeliveryQueueEntryInDatabase,
} from "../delivery-queue-sqlite.kernel.js";
import { runSqliteReadOperationSync } from "../sqlite-schema-facts.js";
import { failPendingDelivery } from "./delivery-queue-ack.js";
import { ackDeliveryInDatabase } from "./delivery-queue-ack.kernel.js";
import { releaseSpoolArtifacts } from "./delivery-queue-media-spool.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "./delivery-queue-media-staging.js";
import { renewDeliveryPlatformSendLease } from "./delivery-queue-platform-lease.js";
import {
  ackDelivery,
  claimDeliveryPlatformSendAttempt,
  enqueueDelivery,
  enqueueDeliveryOnce,
  failDelivery,
  failDeliveryAfterPlatformSend,
  failDeliveryBeforePlatformSend,
  loadPendingDelivery,
  loadUnfinishedDeliveries,
  markDeliveryPlatformOutcomeUnknown,
  markDeliveryPlatformSendDispatched,
  markDeliveryPlatformSendAttemptStarted,
  moveToFailed,
  reserveDeliveryAttempt,
} from "./delivery-queue-storage.js";
import { readOutboundDeliveriesInDatabase } from "./delivery-queue-storage.kernel.js";
import { installDeliveryQueueTmpDirHooks, readQueuedEntry } from "./delivery-queue.test-helpers.js";

describe("delivery-queue storage", () => {
  const { tmpDir } = installDeliveryQueueTmpDirHooks();
  function textDelivery(params: Partial<Parameters<typeof enqueueDelivery>[0]> = {}) {
    return { channel: "directchat", to: "+1555", ...params };
  }
  const enqueueTextDelivery = (params: Partial<Parameters<typeof enqueueDelivery>[0]> = {}) =>
    enqueueDelivery(textDelivery(params), tmpDir());
  async function createMedia(suffix: string, content: string) {
    const artifact = path.join(
      tmpDir(),
      "delivery-queue-media",
      `00000000-0000-4000-8000-${suffix}.ogg`,
    );
    await fs.mkdir(path.dirname(artifact), { recursive: true });
    await fs.writeFile(artifact, content);
    return artifact;
  }

  it("refreshes empty recovery facts after worker and native writes without publishing rollback", async () => {
    const stateDir = tmpDir();
    const options = { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
    const database = openOpenClawStateDatabase(options);
    const read = () => loadUnfinishedDeliveries(stateDir);
    expect(await read()).toEqual([]);
    expect(await read()).toEqual([]);

    const id = await enqueueTextDelivery({ payloads: [{ text: "Queued after an idle poll" }] });
    expect((await read()).map((entry) => entry.id)).toEqual([id]);
    const entry = await loadPendingDelivery(id, stateDir);
    assert(entry, "Expected pending delivery");
    await ackDelivery(id, stateDir);
    expect(await read()).toEqual([]);
    expect(await read()).toEqual([]);

    expect(() =>
      runOpenClawStateWriteTransaction(
        () => {
          upsertDeliveryQueueEntryInDatabase(
            { queueName: OUTBOUND_DELIVERY_QUEUE_NAME, entry },
            database,
          );
          expect(
            runSqliteReadOperationSync(database.db, () =>
              readOutboundDeliveriesInDatabase(database, { mode: "unfinished" }),
            ).map(({ entry: pending }) => pending.id),
          ).toEqual([id]);
          throw new Error("roll back recovery fixture");
        },
        { ...options, database },
      ),
    ).toThrow("roll back recovery fixture");
    expect(await read()).toEqual([]);

    upsertDeliveryQueueEntryInDatabase(
      { queueName: OUTBOUND_DELIVERY_QUEUE_NAME, entry },
      database,
    );
    expect((await read()).map((pending) => pending.id)).toEqual([id]);
  });

  function readStatus(id: string): string | undefined {
    const { db } = openOpenClawStateDatabase({
      env: { ...process.env, OPENCLAW_STATE_DIR: tmpDir() },
    });
    const row = db
      .prepare("SELECT status FROM delivery_queue_entries WHERE queue_name = ? AND id = ?")
      .get(OUTBOUND_DELIVERY_QUEUE_NAME, id) as { status?: string } | undefined;
    return row?.status;
  }

  describe("enqueue + ack lifecycle", () => {
    it("fences stale same-millisecond terminal mutations without releasing newer owner media", async () => {
      const stateDir = tmpDir();
      const id = "cron-direct-delivery:v1:fenced-stale-terminal-media";
      const artifact = await createMedia("000000000090", "newer owner still needs these bytes");
      await enqueueDeliveryOnce(
        textDelivery({
          payloads: [{ text: "x".repeat(64 * 1024), mediaUrl: artifact, audioAsVoice: true }],
          completionRetention: {
            idPrefix: "cron-direct-delivery:v1:",
            maxAgeMs: 24 * 60 * 60_000,
            maxEntries: 2_000,
          },
        }),
        id,
        stateDir,
      );
      const unclaimedSnapshot = await loadPendingDelivery(id, stateDir);
      assert(unclaimedSnapshot, "test invariant: the unclaimed bounded row must be readable");
      const firstAttemptId = await claimDeliveryPlatformSendAttempt(id, stateDir);
      assert(firstAttemptId, "test invariant: first platform owner must claim the durable row");
      const lostClaim = `Delivery platform claim was lost: ${id}`;
      // Admission snapshots taken before ownership must CAS the unclaimed
      // state; a producer that claimed meanwhile retains its media and row.
      await expect(
        ackDelivery(id, stateDir, { expectedPlatformSendAttemptId: null }),
      ).rejects.toThrow(lostClaim);
      await expect(moveToFailed(id, stateDir, null)).rejects.toThrow(lostClaim);
      await expect(
        failPendingDelivery(
          {
            id,
            entry: unclaimedSnapshot,
          },
          stateDir,
        ),
      ).resolves.toEqual({ status: "not_pending" });
      expect(await fs.readFile(artifact, "utf8")).toBe("newer owner still needs these bytes");
      await markDeliveryPlatformSendAttemptStarted(
        id,
        stateDir,
        { replyToId: null },
        firstAttemptId,
      );
      const sameStartedAt = (await loadPendingDelivery(id, stateDir))?.platformSendStartedAt;
      if (typeof sameStartedAt !== "number") {
        throw new Error("Expected the first worker attempt to record its start time");
      }
      const secondAttemptId = await claimDeliveryPlatformSendAttempt(
        id,
        stateDir,
        sameStartedAt,
        firstAttemptId,
      );
      assert(secondAttemptId, "test invariant: reconciled replacement must claim the durable row");
      await markDeliveryPlatformSendAttemptStarted(
        id,
        stateDir,
        { replyToId: null },
        secondAttemptId,
      );
      const fixtureDatabase = openOpenClawStateDatabase({
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      });
      // Preserve a same-millisecond collision across independent worker attempts.
      updateDeliveryQueueEntryInDatabase(
        fixtureDatabase,
        OUTBOUND_DELIVERY_QUEUE_NAME,
        id,
        (entry) => ({
          ...entry,
          platformSendStartedAt: sameStartedAt,
        }),
      );

      await expect(
        ackDelivery(id, stateDir, { expectedPlatformSendAttemptId: firstAttemptId }),
      ).rejects.toThrow(lostClaim);
      await expect(failDelivery(id, "stale failure", stateDir, firstAttemptId)).rejects.toThrow(
        lostClaim,
      );
      await expect(
        failDeliveryBeforePlatformSend(id, "stale pre-send", stateDir, firstAttemptId),
      ).rejects.toThrow(lostClaim);
      await expect(
        failDeliveryAfterPlatformSend(id, "stale post-send", stateDir, firstAttemptId),
      ).rejects.toThrow(lostClaim);
      await expect(
        markDeliveryPlatformOutcomeUnknown(id, stateDir, firstAttemptId),
      ).rejects.toThrow(lostClaim);
      await expect(
        markDeliveryPlatformSendDispatched(id, stateDir, { replyToId: null }, firstAttemptId),
      ).rejects.toThrow(lostClaim);
      await expect(moveToFailed(id, stateDir, firstAttemptId)).rejects.toThrow(lostClaim);
      await expect(reserveDeliveryAttempt(id, 5, stateDir, firstAttemptId)).rejects.toThrow(
        lostClaim,
      );
      expect(await fs.readFile(artifact, "utf8")).toBe("newer owner still needs these bytes");
      const pending = await loadPendingDelivery(id, stateDir);
      assert(pending, "Expected the replacement platform owner to remain pending");
      expect(pending).toMatchObject({
        recoveryState: "send_attempt_started",
        platformSendAttemptId: secondAttemptId,
        platformSendStartedAt: sameStartedAt,
      });
      expect(readStatus(id)).toBe("pending");

      const { db } = fixtureDatabase;
      const retryCount = db.prepare(
        "UPDATE delivery_queue_entries SET retry_count = ? WHERE queue_name = ? AND id = ?",
      );
      retryCount.run(9007199254740992n, OUTBOUND_DELIVERY_QUEUE_NAME, id);
      try {
        const readError = await loadPendingDelivery(id, stateDir).catch((error: unknown) => error);
        assert(
          readError instanceof Error,
          "Expected the pending reader to reject the unsafe integer",
        );
        expect(readError).toMatchObject({ code: "ERR_OUT_OF_RANGE" });
        const ackError = await ackDelivery(id, stateDir, {
          expectedPlatformSendAttemptId: secondAttemptId,
        }).catch((error: unknown) => error);
        expect(ackError).toBeInstanceOf(Error);
        expect(ackError).toMatchObject({
          code: "ERR_OUT_OF_RANGE",
          name: readError.name,
          message: readError.message,
        });
        expect(readStatus(id)).toBe("pending");
        expect(await fs.readFile(artifact, "utf8")).toBe("newer owner still needs these bytes");
      } finally {
        retryCount.run(pending.retryCount, OUTBOUND_DELIVERY_QUEUE_NAME, id);
      }
      const entryTextBytes = Buffer.byteLength(JSON.stringify(readQueuedEntry(stateDir, id)));
      const reads = trackSqliteStatementExecutions(
        requireNativeSqliteDatabase(db),
        ["queue"],
        (sql) =>
          /^\s*select\b/i.test(sql) && /\bfrom\s+"?delivery_queue_entries"?\b/i.test(sql)
            ? "queue"
            : null,
      );
      try {
        // Count the native kernel's reads; the public ACK now runs in a separate worker.
        const spoolPaths = runOpenClawStateWriteTransaction(
          (database) =>
            ackDeliveryInDatabase(database, id, stateDir, {
              expectedPlatformSendAttemptId: secondAttemptId,
            }),
          { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } },
        );
        await releaseSpoolArtifacts(spoolPaths, stateDir);
        expect(reads.rowCounts.queue).toBeGreaterThan(0);
        expect(reads.textBytes.queue).toBeGreaterThan(0);
        expect.soft(reads.counts.queue).toBeLessThanOrEqual(3);
        // One full pending row plus the existing compact receipt ownership reads.
        expect.soft(reads.textBytes.queue).toBeLessThan(entryTextBytes + 4096);
      } finally {
        reads.restore();
      }
      expect(readStatus(id)).toBe("completed");
      await expect(fs.stat(artifact)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("projects process-local hook metadata out before JSON custody", async () => {
      const entry = {
        sourceIndex: 0,
        status: "suppressed" as const,
        reason: "cancelled_by_message_sending_hook" as const,
      };
      const preparedBatch = { schemaVersion: 1 as const, sourcePayloadCount: 1, entries: [entry] };
      const id = await enqueueTextDelivery({
        preparedBatch: {
          ...preparedBatch,
          entries: [
            {
              ...entry,
              hookEffect: {
                cancelReason: "owned elsewhere",
                metadata: { nonJsonValue: 1n },
              },
            },
          ],
        },
      });

      expect(readQueuedEntry(tmpDir(), id).preparedBatch).toEqual(preparedBatch);
    });

    it("atomically reserves delivery attempts up to the producer budget", async () => {
      const id = await enqueueTextDelivery({
        payloads: [{ text: "attempt-budget" }],
        maxRetries: 2,
      });

      for (const maxAttempts of [0, Number.NaN]) {
        await expect(reserveDeliveryAttempt(id, maxAttempts, tmpDir())).rejects.toThrow(
          `Invalid delivery attempt budget: ${maxAttempts}`,
        );
      }

      await expect(reserveDeliveryAttempt(id, 2, tmpDir())).resolves.toEqual({
        status: "reserved",
        attemptCount: 1,
      });
      await expect(reserveDeliveryAttempt(id, 2, tmpDir())).resolves.toEqual({
        status: "reserved",
        attemptCount: 2,
      });
      await expect(reserveDeliveryAttempt(id, 2, tmpDir())).resolves.toEqual({
        status: "exhausted",
        attemptCount: 2,
      });
      expect(readQueuedEntry(tmpDir(), id).attemptCount).toBe(2);
    });

    it("claimless ack rejects a live-claimed row instead of deleting it", async () => {
      const stateDir = tmpDir();
      const id = await enqueueTextDelivery({
        to: "+1",
        payloads: [{ text: "claimless-ack-guard" }],
      });
      const attemptId = await claimDeliveryPlatformSendAttempt(id, stateDir);
      assert(attemptId, "test invariant: the unclaimed row must accept a platform claim");

      await expect(ackDelivery(id, stateDir)).rejects.toThrow(
        `Delivery platform claim was lost: ${id}`,
      );

      const pending = await loadPendingDelivery(id, stateDir);
      expect(pending).toMatchObject({ id, producerClaimId: attemptId });
      expect(readStatus(id)).toBe("pending");
    });
  });

  describe("failDelivery", () => {
    it("preserves and renews the exact explicit owner after an ambiguous platform outcome", async () => {
      const stateDir = tmpDir();
      const id = "cron-direct-delivery:v1:unknown-owner-lease";
      await enqueueDeliveryOnce(
        {
          channel: "forum",
          to: "123",
          payloads: [{ text: "test" }],
          completionRetention: {
            idPrefix: "cron-direct-delivery:v1:",
            maxAgeMs: 24 * 60 * 60_000,
            maxEntries: 2_000,
          },
          requiresProducerClaim: true,
        },
        id,
        stateDir,
      );
      const claimId = await claimDeliveryPlatformSendAttempt(id, stateDir);
      assert(claimId, "test invariant: explicit producer must own the stable row");
      await markDeliveryPlatformSendAttemptStarted(id, stateDir, undefined, claimId);
      const originalExpiry = Date.now() + 10_000;
      updateDeliveryQueueEntryInDatabase(
        openOpenClawStateDatabase({ env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } }),
        OUTBOUND_DELIVERY_QUEUE_NAME,
        id,
        (entry) => ({
          ...entry,
          availableAt: originalExpiry,
        }),
      );

      await markDeliveryPlatformOutcomeUnknown(id, stateDir, claimId);

      expect(readQueuedEntry(stateDir, id)).toMatchObject({
        recoveryState: "unknown_after_send",
        platformSendAttemptId: claimId,
        availableAt: originalExpiry,
      });
      const beforeRenewal = Date.now();
      const renewedUntil = await renewDeliveryPlatformSendLease(id, stateDir, claimId);
      expect(renewedUntil).toBeGreaterThanOrEqual(beforeRenewal + 60_000);
      expect(renewedUntil).toBeLessThanOrEqual(Date.now() + 60_000);
      expect(readQueuedEntry(stateDir, id).availableAt).toBe(renewedUntil);
    });

    it("keeps ambiguous post-send evidence across a later unclaimed batch dispatch", async () => {
      const id = await enqueueTextDelivery({
        channel: "forum",
        to: "123",
        payloads: [{ text: "test" }],
      });

      await markDeliveryPlatformSendAttemptStarted(id, tmpDir());
      await markDeliveryPlatformOutcomeUnknown(id, tmpDir());
      await markDeliveryPlatformSendDispatched(id, tmpDir());

      // Downgrading to send_attempt_started would let recovery replay the whole
      // batch as not_sent and duplicate the payload that already reached the platform.
      expect(readQueuedEntry(tmpDir(), id).recoveryState).toBe("unknown_after_send");
    });

    it("releases a settled live owner while retaining retryable custody", async () => {
      const id = await enqueueTextDelivery({
        channel: "forum",
        to: "123",
        payloads: [{ text: "test" }],
        requiresProducerClaim: true,
      });
      const claimId = await claimDeliveryPlatformSendAttempt(id, tmpDir());
      expect(claimId).toEqual(expect.any(String));

      await failDelivery(id, "provider failed", tmpDir(), claimId);

      const entry = readQueuedEntry(tmpDir(), id);
      expect(entry).toMatchObject({
        retryCount: 1,
        lastError: "provider failed",
      });
      for (const key of ["availableAt", "producerClaimId", "recoveryState"]) {
        expect(entry).not.toHaveProperty(key);
      }
    });

    it("terminalizes a rejected stable row under its exact crash claim", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(1_000);
        const artifact = await createMedia("000000000091", "private rejected media");
        const id = "stable-rejected-after-crash-claim";
        await enqueueDeliveryOnce(
          textDelivery({
            payloads: [{ mediaUrl: artifact, audioAsVoice: true }],
            requiresProducerClaim: true,
          }),
          id,
          tmpDir(),
        );
        const claimId = await claimDeliveryPlatformSendAttempt(id, tmpDir());
        assert(claimId, "test invariant: stable rejection must own a producer claim");
        vi.setSystemTime(60_000);
        const claimed = await loadPendingDelivery(id, tmpDir());
        assert(claimed, "test invariant: claimed delivery must remain pending");

        await expect(failPendingDelivery({ id, entry: claimed }, tmpDir())).resolves.toEqual({
          status: "failed",
        });

        expect(readStatus(id)).toBe("failed");
        expect(readQueuedEntry(tmpDir(), id)).toEqual({
          id,
          enqueuedAt: 60_000,
          failedAt: 60_000,
          retryCount: 0,
          completionRetention: "permanent",
          recoveryState: "completed_permanent",
        });
        await expect(fs.stat(artifact)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        vi.useRealTimers();
      }
    });

    it("returns a typed no-op when a status race already moved the row", async () => {
      const id = await enqueueTextDelivery({
        channel: "slack",
        to: "C123",
        payloads: [{ text: "blocked" }],
      });
      const entry = await loadPendingDelivery(id, tmpDir());
      assert(entry, "expected pending entry");
      await moveToFailed(id, tmpDir());

      await expect(
        failPendingDelivery(
          {
            id,
            entry,
          },
          tmpDir(),
        ),
      ).resolves.toEqual({ status: "not_pending" });
      expect(readStatus(id)).toBeUndefined();
      await expect(
        failPendingDelivery(
          {
            id,
            entry: { ...entry, id: "unused-after-owner-removal" },
            expectedPlatformSendAttemptId: "stale-claim",
          },
          tmpDir(),
        ),
      ).resolves.toEqual({ status: "not_pending" });
    });
  });

  describe("moveToFailed", () => {
    it("retains a minimal stable fence that later producers cannot replace", async () => {
      const id = "stable-failed-delivery";
      await enqueueDeliveryOnce(
        {
          channel: "workspace",
          to: "#general",
          payloads: [{ text: "private stable payload" }],
        },
        id,
        tmpDir(),
      );

      await moveToFailed(id, tmpDir());
      await ackDelivery(id, tmpDir());

      expect(readStatus(id)).toBe("failed");
      expect(readQueuedEntry(tmpDir(), id)).toEqual({
        id,
        enqueuedAt: expect.any(Number),
        failedAt: expect.any(Number),
        retryCount: 0,
        completionRetention: "permanent",
        recoveryState: "completed_permanent",
      });
      await expect(
        enqueueDeliveryOnce(
          { channel: "workspace", to: "#general", payloads: [{ text: "replacement" }] },
          id,
          tmpDir(),
        ),
      ).resolves.toEqual({ id, created: false });
    });
  });
});
