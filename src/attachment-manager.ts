import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { AcpAttachment, AcpAttachmentResponse } from "./types.js";
import {
  ATTACHMENT_DEFAULTS,
  ATTACHMENT_STATE_PREFIX,
  ATTACHMENT_INDEX_PREFIX,
  ATTACHMENT_METRIC_NAMES,
} from "./constants.js";

// --- State key helpers ---

function attachmentStateKey(attachmentId: string): string {
  return `${ATTACHMENT_STATE_PREFIX}${attachmentId}`;
}

function attachmentIndexKey(issueId: string): string {
  return `${ATTACHMENT_INDEX_PREFIX}${issueId}`;
}

// --- ID generation ---

export function generateAttachmentId(): string {
  return `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// --- Storage helpers ---

/**
 * Ensure the storage directory for a given issue exists.
 * Returns the resolved directory path.
 */
async function ensureIssueDir(storageDir: string, issueId: string): Promise<string> {
  const dir = resolve(storageDir, issueId);
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Sanitize a filename to prevent path traversal.
 */
function sanitizeFilename(filename: string): string {
  // Strip directory components and null bytes
  return filename
    .replace(/[\x00]/g, "")
    .replace(/^.*[/\\]/, "")
    .replace(/\.\./g, "_") || "unnamed";
}

/**
 * Infer a MIME type from filename extension if not provided.
 */
function inferMimeType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  const mimeMap: Record<string, string> = {
    txt: "text/plain",
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
    json: "application/json",
    csv: "text/csv",
    zip: "application/zip",
    md: "text/markdown",
    html: "text/html",
    xml: "application/xml",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
  return mimeMap[ext ?? ""] ?? "application/octet-stream";
}

// --- CRUD operations ---

/**
 * Create a new attachment: decode base64 content, write to filesystem,
 * persist metadata to plugin state, and update the issue's attachment index.
 */
export async function createAttachment(
  ctx: PluginContext,
  params: {
    issueId: string;
    filename: string;
    content: string; // base64-encoded
    mimeType?: string;
    createdBy?: string;
  },
  storageDir: string = ATTACHMENT_DEFAULTS.storageDir,
): Promise<AcpAttachmentResponse> {
  const attachmentId = generateAttachmentId();
  const safeName = sanitizeFilename(params.filename);
  const mimeType = params.mimeType || inferMimeType(safeName);

  // Decode base64 content
  const buffer = Buffer.from(params.content, "base64");
  const sizeBytes = buffer.length;

  // Enforce file size limit
  if (sizeBytes > ATTACHMENT_DEFAULTS.maxFileSizeBytes) {
    throw new Error(
      `File size ${sizeBytes} exceeds maximum ${ATTACHMENT_DEFAULTS.maxFileSizeBytes} bytes`,
    );
  }

  // Enforce per-issue attachment limit
  const existingIds = await getAttachmentIndex(ctx, params.issueId);
  if (existingIds.length >= ATTACHMENT_DEFAULTS.maxAttachmentsPerIssue) {
    throw new Error(
      `Issue ${params.issueId} already has ${existingIds.length} attachments (max: ${ATTACHMENT_DEFAULTS.maxAttachmentsPerIssue})`,
    );
  }

  // Write file to disk
  const issueDir = await ensureIssueDir(storageDir, params.issueId);
  const storagePath = join(issueDir, `${attachmentId}_${safeName}`);
  await writeFile(storagePath, buffer);

  const now = Date.now();

  // Persist attachment metadata
  const attachment: AcpAttachment = {
    attachmentId,
    issueId: params.issueId,
    filename: safeName,
    mimeType,
    sizeBytes,
    storagePath,
    createdAt: now,
    createdBy: params.createdBy,
  };

  await ctx.state.set(
    { scopeKind: "instance", stateKey: attachmentStateKey(attachmentId) },
    attachment,
  );

  // Update the issue's attachment index
  existingIds.push(attachmentId);
  await ctx.state.set(
    { scopeKind: "instance", stateKey: attachmentIndexKey(params.issueId) },
    existingIds,
  );

  await ctx.metrics.write(ATTACHMENT_METRIC_NAMES.attachmentsCreated, 1);

  ctx.logger.info("Attachment created", {
    attachmentId,
    issueId: params.issueId,
    filename: safeName,
    sizeBytes,
  });

  return {
    attachmentId,
    issueId: params.issueId,
    filename: safeName,
    mimeType,
    sizeBytes,
    url: `/issues/${params.issueId}/attachments/${attachmentId}`,
    createdAt: now,
  };
}

/**
 * Retrieve attachment metadata by ID.
 */
export async function getAttachment(
  ctx: PluginContext,
  attachmentId: string,
): Promise<AcpAttachment | null> {
  const data = await ctx.state.get({
    scopeKind: "instance",
    stateKey: attachmentStateKey(attachmentId),
  });
  return (data as AcpAttachment) ?? null;
}

/**
 * Retrieve the attachment index (list of attachment IDs) for an issue.
 */
export async function getAttachmentIndex(
  ctx: PluginContext,
  issueId: string,
): Promise<string[]> {
  const data = await ctx.state.get({
    scopeKind: "instance",
    stateKey: attachmentIndexKey(issueId),
  });
  return Array.isArray(data) ? (data as string[]) : [];
}

/**
 * List all attachment metadata for an issue.
 */
export async function listAttachments(
  ctx: PluginContext,
  issueId: string,
): Promise<AcpAttachmentResponse[]> {
  const ids = await getAttachmentIndex(ctx, issueId);
  const attachments: AcpAttachmentResponse[] = [];

  for (const id of ids) {
    const att = await getAttachment(ctx, id);
    if (att) {
      attachments.push({
        attachmentId: att.attachmentId,
        issueId: att.issueId,
        filename: att.filename,
        mimeType: att.mimeType,
        sizeBytes: att.sizeBytes,
        url: `/issues/${att.issueId}/attachments/${att.attachmentId}`,
        createdAt: att.createdAt,
      });
    }
  }

  await ctx.metrics.write(ATTACHMENT_METRIC_NAMES.attachmentsListed, 1);

  return attachments;
}

/**
 * Read the raw file content of an attachment from disk.
 * Returns the file as a Buffer, or null if not found.
 */
export async function readAttachmentContent(
  ctx: PluginContext,
  attachmentId: string,
): Promise<{ buffer: Buffer; attachment: AcpAttachment } | null> {
  const attachment = await getAttachment(ctx, attachmentId);
  if (!attachment) return null;

  try {
    await access(attachment.storagePath);
    const buffer = await readFile(attachment.storagePath);
    return { buffer, attachment };
  } catch {
    ctx.logger.warn("Attachment file not found on disk", {
      attachmentId,
      storagePath: attachment.storagePath,
    });
    return null;
  }
}
