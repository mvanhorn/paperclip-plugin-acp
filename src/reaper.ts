import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { AcpSession } from "./types.js";
import { getSession, closeSession } from "./session-manager.js";
import { METRIC_NAMES } from "./constants.js";

export type ReapReason = "idle timeout exceeded" | "max age exceeded";

/**
 * Pure decision function: given a session snapshot and thresholds, decide
 * whether it should be reaped and why. Returns null when the session is
 * either within thresholds or already in a terminal state.
 *
 * When both thresholds are exceeded, idle is reported as the reason. This is
 * an arbitrary tiebreak — both signals mean the session should close.
 *
 * Missing timestamps fall back to 0 so a broken session (no createdAt /
 * lastActivityAt recorded) is reaped immediately rather than appearing
 * perpetually fresh.
 */
export function computeReapReason(
  now: number,
  session: Pick<AcpSession, "state" | "lastActivityAt" | "createdAt">,
  idleTimeoutMs: number,
  maxAgeMs: number,
): ReapReason | null {
  if (session.state === "closed" || session.state === "error") return null;
  const lastActivity = session.lastActivityAt ?? session.createdAt ?? 0;
  const created = session.createdAt ?? 0;
  const idleFor = now - lastActivity;
  const ageFor = now - created;
  if (idleFor > idleTimeoutMs) return "idle timeout exceeded";
  if (ageFor > maxAgeMs) return "max age exceeded";
  return null;
}

export interface ReapSessionIfDueOptions {
  killSession: (sessionId: string) => boolean;
  now: number;
  idleTimeoutMs: number;
  maxAgeMs: number;
}

export interface ReapSessionResult {
  reaped: boolean;
  reason?: ReapReason;
}

/**
 * Fetch a session, decide whether it is due for reaping, and if so terminate
 * it and emit the `acp.sessions.reaped` counter. Kept separate from the
 * worker's setInterval loop so it is unit-testable.
 *
 * The counter is only written after closeSession resolves — if teardown
 * throws, the counter is not incremented and the error propagates.
 */
export async function reapSessionIfDue(
  ctx: PluginContext,
  sessionId: string,
  opts: ReapSessionIfDueOptions,
): Promise<ReapSessionResult> {
  const session = await getSession(ctx, sessionId);
  if (!session) return { reaped: false };

  const reason = computeReapReason(
    opts.now,
    session,
    opts.idleTimeoutMs,
    opts.maxAgeMs,
  );
  if (!reason) return { reaped: false };

  opts.killSession(sessionId);
  await closeSession(ctx, sessionId);
  await ctx.metrics.write(METRIC_NAMES.sessionsReaped, 1);

  return { reaped: true, reason };
}
