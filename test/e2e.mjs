import hoodiecrow from "hoodiecrow-imap";
import { SMTPServer } from "smtp-server";
import { simpleParser } from "mailparser";
import assert from "node:assert/strict";


const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");

const raw = (id, from, subj, body, extra = "") =>
  `From: ${from}\r\nTo: testuser@example.com\r\nSubject: ${subj}\r\nMessage-ID: <${id}@example.com>\r\nDate: Mon, 16 Nov 2026 10:0${id}:00 +0100\r\n${extra}\r\n${body}\r\n`;
const multipart = `From: Bob <bob@example.com>\r\nTo: testuser@example.com\r\nCc: carol@example.com\r\nSubject: Rechnung\r\nMessage-ID: <3@example.com>\r\nDate: Mon, 16 Nov 2026 11:00:00 +0100\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=XX\r\n\r\n--XX\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nAnbei die Rechnung.\r\n--XX\r\nContent-Type: text/csv; name=r.csv\r\nContent-Disposition: attachment; filename=r.csv\r\n\r\na,b\r\n1,2\r\n--XX--\r\n`;

const imap = hoodiecrow({
  plugins: ["SPECIAL-USE", "MOVE", "UIDPLUS", "LIST-STATUS", "ENABLE"],
  storage: {
    INBOX: { messages: [
      { raw: raw(1, "Alice <alice@example.com>", "Hallo Welt", "Erste Nachricht"), flags: ["\\Seen"] },
      { raw: raw(2, "Alice <alice@example.com>", "Meeting morgen", "Treffen um 10?") },
      { raw: multipart },
    ] },
    "": { separator: "/", folders: {
      Sent: { "special-use": "\\Sent" }, Trash: { "special-use": "\\Trash" }, Drafts: { "special-use": "\\Drafts" }, Archive: {},
    } },
  },
});
await new Promise((r) => imap.listen(0, r));
const delivered = [];
const smtp = new SMTPServer({ authOptional: false, disabledCommands: ["STARTTLS"], allowInsecureAuth: true,
  onAuth: (a, s, cb) => a.username === "testuser" && a.password === "testpass" ? cb(null, { user: 1 }) : cb(new Error("bad auth")),
  onData: (stream, session, cb) => { const ch = []; stream.on("data", (c) => ch.push(c)); stream.on("end", async () => {
    delivered.push({ rcpt: session.envelope.rcptTo.map((r) => r.address), mail: await simpleParser(Buffer.concat(ch)) }); cb(); }); } });
await new Promise((r) => smtp.listen(0, "127.0.0.1", r));

const transport = new StdioClientTransport({ command: "node", args: [new URL("../dist/index.js", import.meta.url).pathname], env: {
  ...process.env, IMAP_HOST: "127.0.0.1", IMAP_PORT: String(imap.address().port), IMAP_SECURE: "false",
  SMTP_PORT: String(smtp.server.address().port), SMTP_SECURE: "false",
  MAIL_USER: "testuser", MAIL_PASS: "testpass", MAIL_FROM: "Test User <testuser@example.com>" } });
const client = new Client({ name: "e2e", version: "1" });
await client.connect(transport);
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const t = r.content[0].text; console.log(`\n### ${name} ${JSON.stringify(args)}${r.isError ? "  [ERROR]" : ""}\n${t.slice(0, 900)}`);
  return r.isError ? null : JSON.parse(t);
};
console.log("tools:", (await client.listTools()).tools.map((t) => t.name).join(", "));
await call("verify_connection");
await call("list_mailboxes");
await call("list_messages", { limit: 10 });
await call("search_messages", { from: "alice", seen: false });
const m = await call("get_message", { uid: 3, markSeen: true });
await call("get_attachment", { uid: 3, index: 0 });
await call("reply_to_message", { uid: 3, text: "Danke!", replyAll: true });
await call("send_email", { to: "dave@example.com", bcc: "eve@example.com", subject: "Test", text: "Hi Dave",
  attachments: [{ filename: "hi.txt", content: "SGFsbG8=" }] });
await call("save_draft", { to: "x@example.com", subject: "Entwurf", text: "später" });
await call("set_flags", { uids: [2], add: ["\\Flagged"] });
await call("move_messages", { uids: [1], destination: "Archive" });
await call("delete_messages", { uids: [2] });
await call("list_mailboxes");
await call("list_messages", { mailbox: "Sent" });
await call("get_message", { uid: 999 });
const sent = await call("list_messages", { mailbox: "Sent" });
assert.equal(delivered.length, 2);
assert.deepEqual(delivered[0].rcpt, ["bob@example.com", "carol@example.com"]);
assert.equal(delivered[0].mail.subject, "Re: Rechnung");
assert.equal(delivered[0].mail.inReplyTo, "<3@example.com>");
assert.deepEqual(delivered[1].rcpt, ["dave@example.com", "eve@example.com"]);
assert.equal(delivered[1].mail.headers.has("bcc"), false, "Bcc must not leak into headers");
assert.equal(delivered[1].mail.attachments[0].content.toString(), "Hallo");
assert.equal(sent.total, 2);
assert.ok(sent.messages.some((x) => x.messageId === delivered[1].mail.messageId), "Sent copy matches delivered mail");
assert.equal(m.attachments[0].filename, "r.csv");
console.log("\n### SMTP delivered:");
for (const d of delivered) console.log(JSON.stringify({ rcpt: d.rcpt, to: d.mail.to?.text, cc: d.mail.cc?.text, subject: d.mail.subject,
  inReplyTo: d.mail.inReplyTo, refs: d.mail.references, atts: d.mail.attachments.map((a) => a.filename), text: d.mail.text }));
console.log("\nALL CHECKS PASSED");
await client.close(); imap.close(); smtp.close(); process.exit(0);
