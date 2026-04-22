import type { AcpSession } from "./types.js";

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
