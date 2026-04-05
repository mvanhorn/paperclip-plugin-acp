import { describe, it, expect } from "vitest";
import {
  getAgent,
  listAgents,
  parseEnabledAgents,
} from "../src/agents.js";

describe("getAgent", () => {
  it("returns config for built-in agents", () => {
    const claude = getAgent("claude");
    expect(claude).toBeDefined();
    expect(claude!.id).toBe("claude");
    expect(claude!.command).toBe("claude");
    expect(claude!.displayName).toBe("Claude Code");

    const codex = getAgent("codex");
    expect(codex).toBeDefined();
    expect(codex!.id).toBe("codex");

    const gemini = getAgent("gemini");
    expect(gemini).toBeDefined();
    expect(gemini!.id).toBe("gemini");

    const opencode = getAgent("opencode");
    expect(opencode).toBeDefined();
    expect(opencode!.id).toBe("opencode");
  });

  it("returns undefined for unknown agent", () => {
    expect(getAgent("nonexistent")).toBeUndefined();
    expect(getAgent("")).toBeUndefined();
  });
});

describe("listAgents", () => {
  it("returns all 4 built-in agents", () => {
    const agents = listAgents();
    expect(agents).toHaveLength(4);
    const ids = agents.map((a) => a.id);
    expect(ids).toContain("claude");
    expect(ids).toContain("codex");
    expect(ids).toContain("gemini");
    expect(ids).toContain("opencode");
  });

  it("each agent has command, displayName, and description", () => {
    for (const agent of listAgents()) {
      expect(agent.command).toBeTruthy();
      expect(agent.displayName).toBeTruthy();
      expect(agent.description).toBeTruthy();
      expect(agent.args).toBeInstanceOf(Array);
    }
  });
});

describe("parseEnabledAgents", () => {
  it("parses comma-separated agent IDs", () => {
    const result = parseEnabledAgents("claude,codex");
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("claude");
    expect(result[1].id).toBe("codex");
  });

  it("handles whitespace around IDs", () => {
    const result = parseEnabledAgents(" claude , gemini , opencode ");
    expect(result).toHaveLength(3);
    expect(result.map((a) => a.id)).toEqual(["claude", "gemini", "opencode"]);
  });

  it("filters out unknown agents silently", () => {
    const result = parseEnabledAgents("claude,fake,codex,bogus");
    expect(result).toHaveLength(2);
    expect(result.map((a) => a.id)).toEqual(["claude", "codex"]);
  });

  it("returns all agents for empty string (fallback to defaults)", () => {
    const result = parseEnabledAgents("");
    expect(result).toHaveLength(4);
    expect(result.map((a) => a.id)).toEqual(["claude", "codex", "gemini", "opencode"]);
  });

  it("returns empty array for all unknown agents", () => {
    expect(parseEnabledAgents("fake1,fake2")).toEqual([]);
  });
});
