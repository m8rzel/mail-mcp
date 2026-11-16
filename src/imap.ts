import { ImapFlow, type FetchMessageObject, type SearchObject } from "imapflow";
import { simpleParser, type AddressObject } from "mailparser";
import type { Config } from "./config.js";

export class ImapService {
  constructor(private readonly config: Config) {}

  /** Opens a fresh connection for each operation – robust against timeouts/idle disconnects. */
  async withClient<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const { imap } = this.config;
    const client = new ImapFlow({
      host: imap.host,
      port: imap.port,
      secure: imap.secure,
      auth: { user: imap.user, pass: imap.pass },
      tls: { rejectUnauthorized: imap.rejectUnauthorized },
      logger: false,
    });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.logout().catch(() => client.close());
    }
  }

  async withMailbox<T>(mailbox: string, fn: (client: ImapFlow) => Promise<T>, readOnly = false): Promise<T> {
    return this.withClient(async (client) => {
      const lock = await client.getMailboxLock(mailbox, { readOnly });
      try {
        return await fn(client);
      } finally {
        lock.release();
      }
    });
  }

  async listMailboxes() {
    return this.withClient(async (client) => {
      const boxes = await client.list({ statusQuery: { messages: true, unseen: true } });
      return boxes.map((b) => ({
        path: b.path,
        name: b.name,
        specialUse: b.specialUse ?? null,
        messages: b.status?.messages ?? null,
        unseen: b.status?.unseen ?? null,
      }));
    });
  }

  async findSpecialUse(client: ImapFlow, use: "\\Sent" | "\\Trash" | "\\Drafts", override?: string) {
    if (override) return override;
    const boxes = await client.list();
    const hit = boxes.find((b) => b.specialUse === use);
    if (hit) return hit.path;
    const names: Record<string, string[]> = {
      "\\Sent": ["sent", "sent items", "sent messages", "gesendet", "gesendete objekte", "inbox.sent"],
      "\\Trash": ["trash", "deleted items", "deleted messages", "papierkorb", "gelöschte elemente", "inbox.trash"],
      "\\Drafts": ["drafts", "entwürfe", "inbox.drafts"],
    };
    return boxes.find((b) => names[use].includes(b.path.toLowerCase()))?.path;
  }

  async searchMessages(mailbox: string, query: SearchObject, limit: number, offset: number) {
    return this.withMailbox(
      mailbox,
      async (client) => {
        const uids = (await client.search(query, { uid: true })) || [];
        const total = uids.length;
        const page = uids.sort((a, b) => b - a).slice(offset, offset + limit);
        const messages = page.length ? await this.fetchSummaries(client, page) : [];
        return { mailbox, total, offset, count: messages.length, messages };
      },
      true,
    );
  }

  private async fetchSummaries(client: ImapFlow, uids: number[]) {
    const out: ReturnType<typeof summarize>[] = [];
    for await (const msg of client.fetch(
      uids.join(","),
      { uid: true, envelope: true, flags: true, internalDate: true, size: true },
      { uid: true },
    )) {
      out.push(summarize(msg));
    }
    return out.sort((a, b) => b.uid - a.uid);
  }

  async getMessage(mailbox: string, uid: number, opts: { markSeen: boolean; includeHtml: boolean; maxChars: number }) {
    return this.withMailbox(
      mailbox,
      async (client) => {
        const msg = await client.fetchOne(String(uid), { uid: true, source: true, flags: true }, { uid: true });
        if (!msg || !msg.source) throw new Error(`Message UID ${uid} not found in ${mailbox}`);
        if (opts.markSeen) await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
        const parsed = await simpleParser(msg.source);
        let text = parsed.text ?? "";
        const truncated = text.length > opts.maxChars;
        if (truncated) text = text.slice(0, opts.maxChars);
        return {
          uid,
          mailbox,
          messageId: parsed.messageId ?? null,
          inReplyTo: parsed.inReplyTo ?? null,
          references: parsed.references ?? null,
          date: parsed.date?.toISOString() ?? null,
          from: addr(parsed.from),
          to: addr(parsed.to),
          cc: addr(parsed.cc),
          replyTo: addr(parsed.replyTo),
          subject: parsed.subject ?? "",
          flags: [...(msg.flags ?? [])],
          text,
          textTruncated: truncated,
          html: opts.includeHtml ? (parsed.html || null) : undefined,
          attachments: parsed.attachments.map((a, index) => ({
            index,
            filename: a.filename ?? null,
            contentType: a.contentType,
            size: a.size,
            contentId: a.contentId ?? null,
          })),
        };
      },
      !opts.markSeen,
    );
  }

  async getRawMessage(mailbox: string, uid: number): Promise<Buffer> {
    return this.withMailbox(
      mailbox,
      async (client) => {
        const msg = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
        if (!msg || !msg.source) throw new Error(`Message UID ${uid} not found in ${mailbox}`);
        return msg.source;
      },
      true,
    );
  }

  async getAttachment(mailbox: string, uid: number, index: number) {
    const parsed = await simpleParser(await this.getRawMessage(mailbox, uid));
    const att = parsed.attachments[index];
    if (!att) throw new Error(`Attachment #${index} not found (message has ${parsed.attachments.length})`);
    return { filename: att.filename ?? `attachment-${index}`, contentType: att.contentType, content: att.content };
  }

  async setFlags(mailbox: string, uids: number[], add: string[], remove: string[]) {
    return this.withMailbox(mailbox, async (client) => {
      const range = uids.join(",");
      if (add.length) await client.messageFlagsAdd(range, add, { uid: true });
      if (remove.length) await client.messageFlagsRemove(range, remove, { uid: true });
      return { mailbox, uids, added: add, removed: remove };
    });
  }

  async moveMessages(mailbox: string, uids: number[], destination: string) {
    return this.withMailbox(mailbox, async (client) => {
      const res = await client.messageMove(uids.join(","), destination, { uid: true });
      return { from: mailbox, to: destination, uidMap: res ? Object.fromEntries(res.uidMap ?? []) : null };
    });
  }

  async copyMessages(mailbox: string, uids: number[], destination: string) {
    return this.withMailbox(mailbox, async (client) => {
      const res = await client.messageCopy(uids.join(","), destination, { uid: true });
      return { from: mailbox, to: destination, uidMap: res ? Object.fromEntries(res.uidMap ?? []) : null };
    });
  }

  async deleteMessages(mailbox: string, uids: number[], permanent: boolean) {
    return this.withClient(async (client) => {
      const trash = permanent ? undefined : await this.findSpecialUse(client, "\\Trash", this.config.trashMailbox);
      const lock = await client.getMailboxLock(mailbox);
      try {
        const range = uids.join(",");
        if (!permanent && trash && trash !== mailbox) {
          await client.messageMove(range, trash, { uid: true });
          return { mailbox, uids, movedTo: trash };
        }
        await client.messageDelete(range, { uid: true });
        return { mailbox, uids, permanentlyDeleted: true };
      } finally {
        lock.release();
      }
    });
  }

  async createMailbox(path: string) {
    return this.withClient(async (client) => client.mailboxCreate(path));
  }

  async deleteMailbox(path: string) {
    return this.withClient(async (client) => client.mailboxDelete(path));
  }

  async append(kind: "\\Sent" | "\\Drafts", raw: Buffer, flags: string[]) {
    return this.withClient(async (client) => {
      const override = kind === "\\Sent" ? this.config.sentMailbox : this.config.draftsMailbox;
      const box = await this.findSpecialUse(client, kind, override);
      if (!box) throw new Error(`No ${kind} mailbox found – set MAIL_${kind === "\\Sent" ? "SENT" : "DRAFTS"}_MAILBOX`);
      const res = await client.append(box, raw, flags);
      return { mailbox: box, uid: res ? (res.uid ?? null) : null };
    });
  }
}

function summarize(msg: FetchMessageObject) {
  const e = msg.envelope;
  const fmt = (list?: { name?: string; address?: string }[]) =>
    (list ?? []).map((a) => (a.name ? `${a.name} <${a.address}>` : (a.address ?? ""))).join(", ");
  return {
    uid: msg.uid,
    date: toIso(e?.date ?? msg.internalDate),
    from: fmt(e?.from),
    to: fmt(e?.to),
    subject: e?.subject ?? "",
    messageId: e?.messageId ?? null,
    flags: [...(msg.flags ?? [])],
    seen: msg.flags?.has("\\Seen") ?? false,
    size: msg.size ?? null,
  };
}

function addr(a: AddressObject | AddressObject[] | undefined): string | null {
  if (!a) return null;
  return (Array.isArray(a) ? a : [a]).map((x) => x.text).join(", ");
}

function toIso(d: Date | string | undefined): string | null {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  return isNaN(date.getTime()) ? null : date.toISOString();
}
