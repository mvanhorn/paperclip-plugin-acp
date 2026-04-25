import { execSync } from "node:child_process";
import type { AcpAgentConfig, AcpAgentId } from "./types.js";

const BUILT_IN_AGENTS: Record<string, AcpAgentConfig> = {
  claude: {
    id: "claude",
    command: "claude",
    args: [],
    displayName: "Claude Code",
    description: "Anthropic's Claude Code CLI - full coding agent with tools, file editing, and terminal access.",
  },
  codex: {
    id: "codex",
    command: "codex",
    args: [],
    displayName: "Codex CLI",
    description: "OpenAI's Codex CLI - coding agent with sandbox execution.",
  },
  gemini: {
    id: "gemini",
    command: "gemini",
    args: ["--acp"],
    displayName: "Gemini CLI",
    description: "Google's Gemini CLI - coding agent with Gemini models.",
  },
  opencode: {
    id: "opencode",
    command: "opencode",
    args: [],
    displayName: "OpenCode",
    description: "Open-source terminal coding agent.",
  },
};

export function getAgent(id: AcpAgentId): AcpAgentConfig | undefined {
  return BUILT_IN_AGENTS[id];
}

export function listAgents(): AcpAgentConfig[] {
  return Object.values(BUILT_IN_AGENTS);
}

export function parseEnabledAgents(configStr: string | undefined | null): AcpAgentConfig[] {
  if (!configStr) configStr = "claude,codex,gemini,opencode";
  const ids = configStr.split(",").map((s) => s.trim()).filter(Boolean);
  return ids.map((id) => BUILT_IN_AGENTS[id]).filter((a): a is AcpAgentConfig => !!a);
}

export function isAgentInstalled(agent: AcpAgentConfig): boolean {
  try {
    execSync(`which ${agent.command}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
