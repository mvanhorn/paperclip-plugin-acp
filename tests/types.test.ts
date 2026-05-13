import { describe, it, expectTypeOf } from "vitest";
import type {
  AcpAgentId,
  AcpSessionMode,
  AcpAgentConfig,
  AcpSession,
  AcpBinding,
  AcpSessionEntry,
  LegacyAcpBinding,
  AcpSpawnRequest,
  AcpPromptRequest,
  AcpOutputEvent,
  AcpMessageEvent,
  AcpSpawnEvent,
  AcpMessageCrossEvent,
  AcpCancelEvent,
  AcpCloseEvent,
} from "../src/types.js";

describe("type exports compile correctly", () => {
  it("AcpAgentId accepts built-in and custom strings", () => {
    expectTypeOf<"claude">().toMatchTypeOf<AcpAgentId>();
    expectTypeOf<"codex">().toMatchTypeOf<AcpAgentId>();
    expectTypeOf<"custom-agent">().toMatchTypeOf<AcpAgentId>();
  });

  it("AcpSessionMode is persistent or oneshot", () => {
    expectTypeOf<"persistent">().toMatchTypeOf<AcpSessionMode>();
    expectTypeOf<"oneshot">().toMatchTypeOf<AcpSessionMode>();
  });

  it("AcpSession has required fields", () => {
    expectTypeOf<AcpSession>().toHaveProperty("sessionId");
    expectTypeOf<AcpSession>().toHaveProperty("agentId");
    expectTypeOf<AcpSession>().toHaveProperty("mode");
    expectTypeOf<AcpSession>().toHaveProperty("cwd");
    expectTypeOf<AcpSession>().toHaveProperty("state");
    expectTypeOf<AcpSession>().toHaveProperty("createdAt");
    expectTypeOf<AcpSession>().toHaveProperty("lastActivityAt");
  });

  it("AcpSession.state is a union of valid states", () => {
    type SessionState = AcpSession["state"];
    expectTypeOf<"spawning">().toMatchTypeOf<SessionState>();
    expectTypeOf<"active">().toMatchTypeOf<SessionState>();
    expectTypeOf<"idle">().toMatchTypeOf<SessionState>();
    expectTypeOf<"closing">().toMatchTypeOf<SessionState>();
    expectTypeOf<"closed">().toMatchTypeOf<SessionState>();
    expectTypeOf<"error">().toMatchTypeOf<SessionState>();
  });

  it("AcpBinding has platform and threadId", () => {
    expectTypeOf<AcpBinding>().toHaveProperty("platform");
    expectTypeOf<AcpBinding>().toHaveProperty("threadId");
    expectTypeOf<AcpBinding>().toHaveProperty("boundAt");
  });

  it("AcpSessionEntry has required fields for 1:N array", () => {
    expectTypeOf<AcpSessionEntry>().toHaveProperty("sessionId");
    expectTypeOf<AcpSessionEntry>().toHaveProperty("agentName");
    expectTypeOf<AcpSessionEntry>().toHaveProperty("agentDisplayName");
    expectTypeOf<AcpSessionEntry>().toHaveProperty("spawnedAt");
    expectTypeOf<AcpSessionEntry>().toHaveProperty("status");
  });

  it("AcpOutputEvent type is a union of valid output types", () => {
    type OutputType = AcpOutputEvent["type"];
    expectTypeOf<"text">().toMatchTypeOf<OutputType>();
    expectTypeOf<"tool_call">().toMatchTypeOf<OutputType>();
    expectTypeOf<"tool_result">().toMatchTypeOf<OutputType>();
    expectTypeOf<"error">().toMatchTypeOf<OutputType>();
    expectTypeOf<"done">().toMatchTypeOf<OutputType>();
  });

  it("cross-plugin event payloads have expected shapes", () => {
    expectTypeOf<AcpSpawnEvent>().toHaveProperty("sessionId");
    expectTypeOf<AcpSpawnEvent>().toHaveProperty("agentName");
    expectTypeOf<AcpSpawnEvent>().toHaveProperty("chatId");
    expectTypeOf<AcpSpawnEvent>().toHaveProperty("threadId");
    expectTypeOf<AcpSpawnEvent>().toHaveProperty("companyId");

    expectTypeOf<AcpMessageCrossEvent>().toHaveProperty("sessionId");
    expectTypeOf<AcpMessageCrossEvent>().toHaveProperty("text");

    expectTypeOf<AcpCancelEvent>().toHaveProperty("sessionId");
    expectTypeOf<AcpCloseEvent>().toHaveProperty("sessionId");
  });

  it("LegacyAcpBinding matches old 1:1 format", () => {
    expectTypeOf<LegacyAcpBinding>().toHaveProperty("sessionId");
    expectTypeOf<LegacyAcpBinding>().toHaveProperty("agentName");
    expectTypeOf<LegacyAcpBinding>().toHaveProperty("boundAt");
  });

  it("AcpSessionEntry.status is the same union as AcpSession.state", () => {
    type EntryStatus = AcpSessionEntry["status"];
    type SessionState = AcpSession["state"];
    expectTypeOf<SessionState>().toEqualTypeOf<EntryStatus>();
  });
});
