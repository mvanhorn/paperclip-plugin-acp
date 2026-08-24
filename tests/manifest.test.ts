import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import manifest from "../src/manifest.js";
import { PLUGIN_ID, PLUGIN_VERSION } from "../src/constants.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { name: string; version: string };

describe("manifest metadata", () => {
  it("advertises the published package version", () => {
    // Regression guard for the drift that made Paperclip record a stale plugin
    // version after every install (constant 0.3.0 vs package 0.6.0).
    expect(PLUGIN_VERSION).toBe(pkg.version);
    expect(manifest.version).toBe(pkg.version);
  });

  it("matches the package name and plugin id", () => {
    expect(manifest.id).toBe(PLUGIN_ID);
    expect(manifest.id).toBe(pkg.name);
  });

  it("declares no capability it does not use", () => {
    // `companies.read` existed only for the startup config walk. Nothing reads
    // company metadata any more, and an unused capability is a permission the
    // install does not need.
    expect(manifest.capabilities).not.toContain("companies.read");
  });
});
