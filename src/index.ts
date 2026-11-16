#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { SearchObject } from "imapflow";
import { simpleParser } from "mailparser";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { loadConfig } from "./config.js";
import { ImapService } from "./imap.js";
import { SmtpService } from "./smtp.js";

const config = loadConfig();
const imap = new ImapService(config);
const smtp = new SmtpService(config);

const server = new McpServer({ name: "mail-mcp", version: "0.1.0" });

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/** Wraps a handler so results become JSON text and errors are reported to the model instead of crashing. */
function handle<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A): Promise<ToolResult> => {
    try {
      const result = await fn(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const detail = (err as { responseText?: string })?.responseText;
      return { content: [{ type: "text", text: `Error: ${message}${detail ? ` (${detail})` : ""}` }], isError: true };
    }
  };
}

const mailbox = z.string().default("INBOX").describe("Mailbox path, e.g. INBOX or INBOX/Archive");
const uid = z.number().int().positive().describe("Message UID (from list/search results)");
const uids = z.array(z.number().int().positive()).min(1).describe("Message UIDs");
const addresses = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .describe('Address(es), e.g. "Jane <jane@example.com>" or a list');
const attachments = z
  .array(
    z.object({
      filename: z.string().optional(),
      path: z.string().optional().describe("Local file path on the server machine"),
      content: z.string().optional().describe("File content (base64 unless encoding is set)"),
      encoding: z.enum(["base64", "utf8"]).default("base64"),
      contentType: z.string().optional(),
    }),
  )
  .optional();

type AttachmentInput = NonNullable<z.infer<typeof attachments>>;

async function toNodemailerAttachments(list: AttachmentInput | undefined) {
  if (!list) return undefined;
  return Promise.all(
    list.map(async (a) => {
      if (a.path) {
        return { filename: a.filename ?? basename(a.path), content: await readFile(a.path), contentType: a.contentType };
      }
      if (a.content === undefined) throw new Error("Attachment needs either path or content");
      return { filename: a.filename, content: Buffer.from(a.content, a.encoding), contentType: a.contentType };
    }),
  );
}

// ---------------------------------------------------------------- IMAP: read

server.registerTool(
  "list_mailboxes",
  {
    title: "List mailboxes",
    description: "List all IMAP folders with message and unread counts.",
    annotations: { readOnlyHint: true },
  },
  handle(async () => imap.listMailboxes()),
);

server.registerTool(
  "list_messages",
  {
    title: "List messages",
    description: "List messages in a mailbox, newest first (envelope only, no body).",
    inputSchema: {
      mailbox,
      limit: z.number().int().min(1).max(200).default(20),
      offset: z.number().int().min(0).default(0),
      unreadOnly: z.boolean().default(false),
    },
    annotations: { readOnlyHint: true },
  },
  handle(async ({ mailbox, limit, offset, unreadOnly }) =>
    imap.searchMessages(mailbox, unreadOnly ? { seen: false } : { all: true }, limit, offset),
  ),
);

server.registerTool(
  "search_messages",
  {
    title: "Search messages",
    description: "Search a mailbox using IMAP SEARCH. All given criteria are combined with AND. Results newest first.",
    inputSchema: {
      mailbox,
      from: z.string().optional(),
      to: z.string().optional(),
      cc: z.string().optional(),
      subject: z.string().optional(),
      body: z.string().optional().describe("Text in the message body"),
      text: z.string().optional().describe("Text anywhere in headers or body"),
      since: z.string().optional().describe("ISO date, e.g. 2026-01-31 (inclusive)"),
      before: z.string().optional().describe("ISO date (exclusive)"),
      seen: z.boolean().optional().describe("true = only read, false = only unread"),
      flagged: z.boolean().optional(),
      answered: z.boolean().optional(),
      larger: z.number().int().optional().describe("Minimum size in bytes"),
      smaller: z.number().int().optional().describe("Maximum size in bytes"),
      limit: z.number().int().min(1).max(200).default(20),
      offset: z.number().int().min(0).default(0),
    },
    annotations: { readOnlyHint: true },
  },
  handle(async ({ mailbox, limit, offset, since, before, ...criteria }) => {
    const query: SearchObject = {};
    for (const [k, v] of Object.entries(criteria)) if (v !== undefined) (query as Record<string, unknown>)[k] = v;
    if (since) query.since = new Date(since);
    if (before) query.before = new Date(before);
    if (Object.keys(query).length === 0) query.all = true;
    return imap.searchMessages(mailbox, query, limit, offset);
  }),
);

server.registerTool(
  "get_message",
  {
    title: "Read message",
    description: "Fetch and parse a full message: headers, plain-text body, optional HTML and attachment list.",
    inputSchema: {
      mailbox,
      uid,
      markSeen: z.boolean().default(false).describe("Mark the message as read"),
      includeHtml: z.boolean().default(false),
      maxChars: z.number().int().min(100).default(20000).describe("Truncate text body after this many characters"),
    },
  },
  handle(async ({ mailbox, uid, markSeen, includeHtml, maxChars }) =>
    imap.getMessage(mailbox, uid, { markSeen, includeHtml, maxChars }),
  ),
);

server.registerTool(
  "get_attachment",
  {
    title: "Get attachment",
    description:
      "Return one attachment of a message (index from get_message). Text-like attachments are returned as text, everything else as base64.",
    inputSchema: {
      mailbox,
      uid,
      index: z.number().int().min(0),
      maxBytes: z.number().int().min(1).default(5_000_000),
    },
    annotations: { readOnlyHint: true },
  },
  handle(async ({ mailbox, uid, index, maxBytes }) => {
    const att = await imap.getAttachment(mailbox, uid, index);
    if (att.content.length > maxBytes) {
      throw new Error(`Attachment is ${att.content.length} bytes, larger than maxBytes=${maxBytes}`);
    }
    const isText = /^text\/|json|xml|csv|javascript/.test(att.contentType);
    return {
      filename: att.filename,
      contentType: att.contentType,
      size: att.content.length,
      encoding: isText ? "utf8" : "base64",
      content: att.content.toString(isText ? "utf8" : "base64"),
    };
  }),
);

// ---------------------------------------------------------------- IMAP: modify

server.registerTool(
  "set_flags",
  {
    title: "Set flags",
    description: "Add/remove flags, e.g. \\Seen (read), \\Flagged (starred), \\Answered, or custom keywords.",
    inputSchema: {
      mailbox,
      uids,
      add: z.array(z.string()).default([]),
      remove: z.array(z.string()).default([]),
    },
    annotations: { idempotentHint: true },
  },
  handle(async ({ mailbox, uids, add, remove }) => imap.setFlags(mailbox, uids, add, remove)),
);

server.registerTool(
  "move_messages",
  {
    title: "Move messages",
    description: "Move messages to another mailbox.",
    inputSchema: { mailbox, uids, destination: z.string() },
  },
  handle(async ({ mailbox, uids, destination }) => imap.moveMessages(mailbox, uids, destination)),
);

server.registerTool(
  "copy_messages",
  {
    title: "Copy messages",
    description: "Copy messages to another mailbox.",
    inputSchema: { mailbox, uids, destination: z.string() },
  },
  handle(async ({ mailbox, uids, destination }) => imap.copyMessages(mailbox, uids, destination)),
);

server.registerTool(
  "delete_messages",
  {
    title: "Delete messages",
    description: "Move messages to Trash, or delete them permanently (expunge) with permanent=true.",
    inputSchema: { mailbox, uids, permanent: z.boolean().default(false) },
    annotations: { destructiveHint: true },
  },
  handle(async ({ mailbox, uids, permanent }) => imap.deleteMessages(mailbox, uids, permanent)),
);

server.registerTool(
  "create_mailbox",
  {
    title: "Create mailbox",
    description: "Create a new IMAP folder.",
    inputSchema: { path: z.string().describe("Full path, using the server's delimiter, e.g. INBOX/Projects") },
  },
  handle(async ({ path }) => imap.createMailbox(path)),
);

server.registerTool(
  "delete_mailbox",
  {
    title: "Delete mailbox",
    description: "Delete an IMAP folder including all messages in it.",
    inputSchema: { path: z.string() },
    annotations: { destructiveHint: true },
  },
  handle(async ({ path }) => imap.deleteMailbox(path)),
);

// ---------------------------------------------------------------- SMTP

const composeShape = {
  to: addresses,
  cc: addresses,
  bcc: addresses,
  subject: z.string().default(""),
  text: z.string().optional().describe("Plain-text body"),
  html: z.string().optional().describe("HTML body"),
  replyTo: z.string().optional(),
  inReplyTo: z.string().optional().describe("Message-ID this mail replies to"),
  references: z.union([z.string(), z.array(z.string())]).optional(),
  attachments,
};

server.registerTool(
  "send_email",
  {
    title: "Send email",
    description: "Send an email via SMTP. A copy is stored in the Sent folder unless MAIL_SAVE_SENT=false.",
    inputSchema: composeShape,
    annotations: { destructiveHint: false, openWorldHint: true },
  },
  handle(async (args) => {
    if (!args.to && !args.cc && !args.bcc) throw new Error("At least one recipient (to/cc/bcc) is required");
    const { info, raw } = await smtp.send({ ...args, attachments: await toNodemailerAttachments(args.attachments) });
    const saved = config.saveSent ? await imap.append("\\Sent", raw, ["\\Seen"]).catch((e: Error) => e.message) : null;
    return { messageId: info.messageId, accepted: info.accepted, rejected: info.rejected, savedToSent: saved };
  }),
);

server.registerTool(
  "reply_to_message",
  {
    title: "Reply to message",
    description:
      "Reply to an existing message. Sets recipients, 'Re:' subject, In-Reply-To/References and quotes the original text.",
    inputSchema: {
      mailbox,
      uid,
      text: z.string().describe("Reply text (plain text)"),
      html: z.string().optional(),
      replyAll: z.boolean().default(false),
      quote: z.boolean().default(true).describe("Append the quoted original message"),
      cc: addresses,
      bcc: addresses,
      attachments,
    },
    annotations: { openWorldHint: true },
  },
  handle(async ({ mailbox, uid, text, html, replyAll, quote, cc, bcc, attachments: att }) => {
    const original = await simpleParser(await imap.getRawMessage(mailbox, uid));
    const list = (a: typeof original.to) => (a ? (Array.isArray(a) ? a : [a]).flatMap((x) => x.value) : []);
    const self = config.from.toLowerCase();
    const notSelf = (e: { address?: string }) => e.address && !self.includes(e.address.toLowerCase());

    const primary = list(original.replyTo).length ? list(original.replyTo) : list(original.from);
    const to = primary.map((e) => e.address!).filter(Boolean);
    const extraCc = replyAll
      ? [...list(original.to), ...list(original.cc)].filter(notSelf).map((e) => e.address!)
      : [];
    const ccAll = [...new Set([...extraCc, ...[cc ?? []].flat()])].filter((a) => !to.includes(a));

    const subject = /^re:/i.test(original.subject ?? "") ? original.subject! : `Re: ${original.subject ?? ""}`;
    const refs = [original.references ?? []].flat();
    if (original.messageId) refs.push(original.messageId);

    let body = text;
    if (quote && original.text) {
      const who = original.from?.text ?? "";
      const when = original.date?.toLocaleString("de-DE") ?? "";
      body += `\n\nAm ${when} schrieb ${who}:\n` + original.text.replace(/^/gm, "> ");
    }

    const { info, raw } = await smtp.send({
      to,
      cc: ccAll.length ? ccAll : undefined,
      bcc,
      subject,
      text: body,
      html,
      inReplyTo: original.messageId,
      references: refs,
      attachments: await toNodemailerAttachments(att),
    });
    const saved = config.saveSent ? await imap.append("\\Sent", raw, ["\\Seen"]).catch((e: Error) => e.message) : null;
    await imap.setFlags(mailbox, [uid], ["\\Answered"], []).catch(() => undefined);
    return { messageId: info.messageId, to, cc: ccAll, subject, accepted: info.accepted, savedToSent: saved };
  }),
);

server.registerTool(
  "save_draft",
  {
    title: "Save draft",
    description: "Compose a message and store it in the Drafts folder without sending.",
    inputSchema: composeShape,
  },
  handle(async (args) => {
    const raw = await smtp.build({ ...args, attachments: await toNodemailerAttachments(args.attachments) });
    return imap.append("\\Drafts", raw, ["\\Draft", "\\Seen"]);
  }),
);

server.registerTool(
  "verify_connection",
  {
    title: "Verify connection",
    description: "Check that IMAP login and SMTP login work with the configured credentials.",
    annotations: { readOnlyHint: true },
  },
  handle(async () => {
    const result: Record<string, string> = {};
    try {
      await imap.withClient(async () => undefined);
      result.imap = `ok (${config.imap.host}:${config.imap.port})`;
    } catch (e) {
      result.imap = `failed: ${(e as Error).message}`;
    }
    try {
      await smtp.verify();
      result.smtp = `ok (${config.smtp.host}:${config.smtp.port})`;
    } catch (e) {
      result.smtp = `failed: ${(e as Error).message}`;
    }
    return result;
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("mail-mcp running on stdio");
