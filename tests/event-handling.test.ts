import { describe, it, expect } from "vitest";
import {
  CHAT_PLATFORM_PLUGINS,
  INBOUND_EVENT_SUFFIXES,
  OUTBOUND_EVENTS,
  PLUGIN_ID,
  DEFAULT_CONFIG,
} from "../src/constants.js";

describe("cross-plugin event name generation", () => {
  it("generates correct inbound event names for each platform", () => {
    const expected = [
      "plugin.paperclip-plugin-telegram.acp-spawn",
      "plugin.paperclip-plugin-telegram.acp-message",
      "plugin.paperclip-plugin-telegram.acp-cancel",
      "plugin.paperclip-plugin-telegram.acp-close",
      "plugin.paperclip-plugin-slack.acp-spawn",
      "plugin.paperclip-plugin-slack.acp-message",
      "plugin.paperclip-plugin-slack.acp-cancel",
      "plugin.paperclip-plugin-slack.acp-close",
      "plugin.paperclip-plugin-discord.acp-spawn",
      "plugin.paperclip-plugin-discord.acp-message",
      "plugin.paperclip-plugin-discord.acp-cancel",
      "plugin.paperclip-plugin-discord.acp-close",
    ];

    const generated: string[] = [];
    for (const platform of CHAT_PLATFORM_PLUGINS) {
      for (const suffix of INBOUND_EVENT_SUFFIXES) {
        generated.push(`plugin.${platform}.${suffix}`);
      }
    }

    expect(generated).toEqual(expected);
  });

  it("lists all 3 chat platform plugins", () => {
    expect(CHAT_PLATFORM_PLUGINS).toHaveLength(3);
    expect(CHAT_PLATFORM_PLUGINS).toContain("paperclip-plugin-telegram");
    expect(CHAT_PLATFORM_PLUGINS).toContain("paperclip-plugin-slack");
    expect(CHAT_PLATFORM_PLUGINS).toContain("paperclip-plugin-discord");
  });

  it("lists all 4 inbound event suffixes", () => {
    expect(INBOUND_EVENT_SUFFIXES).toHaveLength(4);
    expect(INBOUND_EVENT_SUFFIXES).toContain("acp-spawn");
    expect(INBOUND_EVENT_SUFFIXES).toContain("acp-message");
    expect(INBOUND_EVENT_SUFFIXES).toContain("acp-cancel");
    expect(INBOUND_EVENT_SUFFIXES).toContain("acp-close");
  });

  it("outbound events has output key", () => {
    expect(OUTBOUND_EVENTS.output).toBe("output");
  });
});

describe("constants", () => {
  it("PLUGIN_ID matches package name", () => {
    expect(PLUGIN_ID).toBe("paperclip-plugin-acp");
  });

  it("DEFAULT_CONFIG has sensible defaults", () => {
    expect(DEFAULT_CONFIG.maxSessionsPerThread).toBe(5);
    expect(DEFAULT_CONFIG.defaultAgent).toBe("claude");
    expect(DEFAULT_CONFIG.defaultMode).toBe("persistent");
    expect(DEFAULT_CONFIG.defaultCwd).toBe("/workspace");
    expect(DEFAULT_CONFIG.sessionIdleTimeoutMs).toBeGreaterThan(0);
    expect(DEFAULT_CONFIG.sessionMaxAgeMs).toBeGreaterThan(DEFAULT_CONFIG.sessionIdleTimeoutMs);
  });

  it("enabledAgents default includes all 4 built-in agents", () => {
    const ids = DEFAULT_CONFIG.enabledAgents.split(",");
    expect(ids).toHaveLength(4);
    expect(ids).toContain("claude");
    expect(ids).toContain("codex");
    expect(ids).toContain("gemini");
    expect(ids).toContain("opencode");
  });
});
