import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMockContext } from "./helpers.js";
import {
  createAttachment,
  getAttachment,
  getAttachmentIndex,
  listAttachments,
  generateAttachmentId,
  readAttachmentContent,
} from "../src/attachment-manager.js";
import {
  ATTACHMENT_DEFAULTS,
  ATTACHMENT_STATE_PREFIX,
  ATTACHMENT_INDEX_PREFIX,
} from "../src/constants.js";

// Mock fs/promises for tests so no real disk I/O occurs
vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue(Buffer.from("file-content")),
  access: vi.fn().mockResolvedValue(undefined),
}));

describe("attachment-manager", () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext();
  });

  // --- generateAttachmentId ---

  describe("generateAttachmentId", () => {
    it("returns a string starting with att-", () => {
      const id = generateAttachmentId();
      expect(id).toMatch(/^att-/);
    });

    it("generates unique IDs on successive calls", () => {
      const ids = new Set(Array.from({ length: 50 }, () => generateAttachmentId()));
      expect(ids.size).toBe(50);
    });
  });

  // --- createAttachment ---

  describe("createAttachment", () => {
    const base64Content = Buffer.from("hello world").toString("base64");

    it("creates an attachment and returns metadata with correct fields", async () => {
      const result = await createAttachment(
        ctx,
        {
          issueId: "issue-1",
          filename: "report.pdf",
          content: base64Content,
          mimeType: "application/pdf",
        },
        "/tmp/test-attachments",
      );

      expect(result).toMatchObject({
        issueId: "issue-1",
        filename: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 11, // "hello world" is 11 bytes
      });
      expect(result.attachmentId).toMatch(/^att-/);
      expect(result.url).toBe(`/issues/issue-1/attachments/${result.attachmentId}`);
      expect(typeof result.createdAt).toBe("number");
    });

    it("infers MIME type from filename when mimeType is not provided", async () => {
      const result = await createAttachment(
        ctx,
        {
          issueId: "issue-2",
          filename: "image.png",
          content: base64Content,
        },
        "/tmp/test-attachments",
      );

      expect(result.mimeType).toBe("image/png");
    });

    it("defaults to application/octet-stream for unknown extensions", async () => {
      const result = await createAttachment(
        ctx,
        {
          issueId: "issue-3",
          filename: "data.xyz",
          content: base64Content,
        },
        "/tmp/test-attachments",
      );

      expect(result.mimeType).toBe("application/octet-stream");
    });

    it("sanitizes filenames to prevent path traversal", async () => {
      const result = await createAttachment(
        ctx,
        {
          issueId: "issue-4",
          filename: "../../../etc/passwd",
          content: base64Content,
        },
        "/tmp/test-attachments",
      );

      // Filename should not contain path traversal
      expect(result.filename).not.toContain("..");
      expect(result.filename).not.toContain("/");
    });

    it("persists attachment metadata in plugin state", async () => {
      const result = await createAttachment(
        ctx,
        {
          issueId: "issue-5",
          filename: "doc.txt",
          content: base64Content,
        },
        "/tmp/test-attachments",
      );

      const stored = await ctx.state.get({
        scopeKind: "instance",
        stateKey: `${ATTACHMENT_STATE_PREFIX}${result.attachmentId}`,
      });

      expect(stored).not.toBeNull();
      expect((stored as any).attachmentId).toBe(result.attachmentId);
      expect((stored as any).issueId).toBe("issue-5");
    });

    it("updates the issue attachment index", async () => {
      const result = await createAttachment(
        ctx,
        {
          issueId: "issue-6",
          filename: "file.txt",
          content: base64Content,
        },
        "/tmp/test-attachments",
      );

      const index = await ctx.state.get({
        scopeKind: "instance",
        stateKey: `${ATTACHMENT_INDEX_PREFIX}issue-6`,
      });

      expect(Array.isArray(index)).toBe(true);
      expect(index).toContain(result.attachmentId);
    });

    it("appends to existing attachment index", async () => {
      // Create two attachments for the same issue
      const r1 = await createAttachment(
        ctx,
        { issueId: "issue-7", filename: "a.txt", content: base64Content },
        "/tmp/test-attachments",
      );
      const r2 = await createAttachment(
        ctx,
        { issueId: "issue-7", filename: "b.txt", content: base64Content },
        "/tmp/test-attachments",
      );

      const index = await ctx.state.get({
        scopeKind: "instance",
        stateKey: `${ATTACHMENT_INDEX_PREFIX}issue-7`,
      });

      expect(index).toContain(r1.attachmentId);
      expect(index).toContain(r2.attachmentId);
      expect((index as string[]).length).toBe(2);
    });

    it("rejects files exceeding maximum size", async () => {
      // Create content larger than 25 MB
      const largeContent = Buffer.alloc(
        ATTACHMENT_DEFAULTS.maxFileSizeBytes + 1,
      ).toString("base64");

      await expect(
        createAttachment(
          ctx,
          { issueId: "issue-8", filename: "huge.bin", content: largeContent },
          "/tmp/test-attachments",
        ),
      ).rejects.toThrow(/exceeds maximum/);
    });

    it("rejects when per-issue attachment limit is reached", async () => {
      // Pre-seed the index with maxAttachmentsPerIssue entries
      const fakeIds = Array.from(
        { length: ATTACHMENT_DEFAULTS.maxAttachmentsPerIssue },
        (_, i) => `att-fake-${i}`,
      );
      await ctx.state.set(
        {
          scopeKind: "instance",
          stateKey: `${ATTACHMENT_INDEX_PREFIX}issue-9`,
        },
        fakeIds,
      );

      await expect(
        createAttachment(
          ctx,
          { issueId: "issue-9", filename: "one-more.txt", content: base64Content },
          "/tmp/test-attachments",
        ),
      ).rejects.toThrow(/already has/);
    });

    it("writes attachment created metric", async () => {
      await createAttachment(
        ctx,
        { issueId: "issue-10", filename: "m.txt", content: base64Content },
        "/tmp/test-attachments",
      );

      const metricWrites = (ctx.metrics as any)._writes;
      expect(metricWrites.some((w: any) => w.name === "acp.attachments.created")).toBe(
        true,
      );
    });
  });

  // --- getAttachment ---

  describe("getAttachment", () => {
    it("returns null for non-existent attachment", async () => {
      const result = await getAttachment(ctx, "att-nonexistent");
      expect(result).toBeNull();
    });

    it("returns attachment metadata after creation", async () => {
      const base64 = Buffer.from("test").toString("base64");
      const created = await createAttachment(
        ctx,
        { issueId: "issue-get-1", filename: "test.txt", content: base64 },
        "/tmp/test-attachments",
      );

      const fetched = await getAttachment(ctx, created.attachmentId);
      expect(fetched).not.toBeNull();
      expect(fetched!.attachmentId).toBe(created.attachmentId);
      expect(fetched!.issueId).toBe("issue-get-1");
      expect(fetched!.filename).toBe("test.txt");
    });
  });

  // --- getAttachmentIndex ---

  describe("getAttachmentIndex", () => {
    it("returns empty array for issue with no attachments", async () => {
      const index = await getAttachmentIndex(ctx, "issue-empty");
      expect(index).toEqual([]);
    });

    it("returns attachment IDs after creation", async () => {
      const base64 = Buffer.from("test").toString("base64");
      const created = await createAttachment(
        ctx,
        { issueId: "issue-idx-1", filename: "test.txt", content: base64 },
        "/tmp/test-attachments",
      );

      const index = await getAttachmentIndex(ctx, "issue-idx-1");
      expect(index).toContain(created.attachmentId);
    });
  });

  // --- listAttachments ---

  describe("listAttachments", () => {
    it("returns empty array for issue with no attachments", async () => {
      const result = await listAttachments(ctx, "issue-none");
      expect(result).toEqual([]);
    });

    it("returns all attachments for an issue with metadata", async () => {
      const base64 = Buffer.from("content").toString("base64");

      await createAttachment(
        ctx,
        { issueId: "issue-list-1", filename: "a.txt", content: base64 },
        "/tmp/test-attachments",
      );
      await createAttachment(
        ctx,
        { issueId: "issue-list-1", filename: "b.pdf", content: base64, mimeType: "application/pdf" },
        "/tmp/test-attachments",
      );

      const attachments = await listAttachments(ctx, "issue-list-1");
      expect(attachments.length).toBe(2);

      const filenames = attachments.map((a) => a.filename);
      expect(filenames).toContain("a.txt");
      expect(filenames).toContain("b.pdf");

      // Each attachment should have a URL
      for (const att of attachments) {
        expect(att.url).toMatch(/^\/issues\/issue-list-1\/attachments\/att-/);
        expect(att.issueId).toBe("issue-list-1");
        expect(typeof att.sizeBytes).toBe("number");
        expect(typeof att.createdAt).toBe("number");
      }
    });

    it("does not return attachments from other issues", async () => {
      const base64 = Buffer.from("content").toString("base64");

      await createAttachment(
        ctx,
        { issueId: "issue-A", filename: "a.txt", content: base64 },
        "/tmp/test-attachments",
      );
      await createAttachment(
        ctx,
        { issueId: "issue-B", filename: "b.txt", content: base64 },
        "/tmp/test-attachments",
      );

      const aAttachments = await listAttachments(ctx, "issue-A");
      const bAttachments = await listAttachments(ctx, "issue-B");

      expect(aAttachments.length).toBe(1);
      expect(bAttachments.length).toBe(1);
      expect(aAttachments[0].filename).toBe("a.txt");
      expect(bAttachments[0].filename).toBe("b.txt");
    });

    it("writes listed metric", async () => {
      await listAttachments(ctx, "issue-metric");

      const metricWrites = (ctx.metrics as any)._writes;
      expect(metricWrites.some((w: any) => w.name === "acp.attachments.listed")).toBe(
        true,
      );
    });
  });

  // --- readAttachmentContent ---

  describe("readAttachmentContent", () => {
    it("returns null for non-existent attachment", async () => {
      const result = await readAttachmentContent(ctx, "att-nonexistent");
      expect(result).toBeNull();
    });

    it("returns buffer and metadata for existing attachment", async () => {
      const base64 = Buffer.from("hello").toString("base64");
      const created = await createAttachment(
        ctx,
        { issueId: "issue-read-1", filename: "hello.txt", content: base64 },
        "/tmp/test-attachments",
      );

      const result = await readAttachmentContent(ctx, created.attachmentId);
      expect(result).not.toBeNull();
      expect(result!.attachment.attachmentId).toBe(created.attachmentId);
      expect(Buffer.isBuffer(result!.buffer)).toBe(true);
    });
  });
});
