# mail-mcp

MCP server (Model Context Protocol) for reading and sending email via **IMAP** and **SMTP**, written in Node.js/TypeScript.
Built on [`imapflow`](https://github.com/postalsys/imapflow), [`nodemailer`](https://nodemailer.com) and [`mailparser`](https://github.com/nodemailer/mailparser).

Works with any standard mail provider (e.g. IONOS, Strato, all-inkl, Gmail/Google Workspace with an app password, Outlook/Microsoft 365 with IMAP enabled, Mailbox.org, Dovecot/Postfix).

## Tools

| Tool | Purpose |
| --- | --- |
| `list_mailboxes` | All folders with message/unread counts and special-use (Sent, Trash, …) |
| `list_messages` | Messages of a folder, newest first, with paging (`limit`, `offset`, `unreadOnly`) |
| `search_messages` | IMAP search: `from`, `to`, `cc`, `subject`, `body`, `text`, `since`, `before`, `seen`, `flagged`, `answered`, `larger`, `smaller` |
| `get_message` | Full message: headers, text body (truncatable), optional HTML, attachment list; optional `markSeen` |
| `get_attachment` | One attachment (text as UTF-8, anything else as base64) |
| `set_flags` | Add/remove flags, e.g. `\Seen`, `\Flagged`, `\Answered` |
| `move_messages` / `copy_messages` | Move/copy to another folder |
| `delete_messages` | Move to Trash, or `permanent: true` to expunge |
| `create_mailbox` / `delete_mailbox` | Manage folders |
| `send_email` | Send via SMTP (to/cc/bcc, text/html, attachments from base64 or a local path); copy is stored in "Sent" |
| `reply_to_message` | Reply / reply-all with correct `In-Reply-To`/`References`, "Re:" subject and quoted original; marks the original `\Answered` |
| `save_draft` | Store a composed message in "Drafts" |
| `verify_connection` | Checks IMAP and SMTP login |

Messages are addressed by **UID** within a mailbox (default `INBOX`).

## Optional: local clone (for development)

```bash
git clone https://github.com/m8rzel/mail-mcp.git
cd mail-mcp
npm install      # also builds to dist/
```

Requires Node.js ≥ 18.

## Configuration (environment variables)

| Variable | Default | Description |
| --- | --- | --- |
| `IMAP_HOST` | – (required) | IMAP server |
| `IMAP_PORT` | `993` | |
| `IMAP_SECURE` | `true` if port 993 | `true` = implicit TLS, `false` = STARTTLS/plain |
| `IMAP_USER` / `IMAP_PASS` | `MAIL_USER` / `MAIL_PASS` | IMAP login |
| `SMTP_HOST` | `IMAP_HOST` | SMTP server |
| `SMTP_PORT` | `465` | use `587` for STARTTLS |
| `SMTP_SECURE` | `true` if port 465 | |
| `SMTP_USER` / `SMTP_PASS` | IMAP credentials | SMTP login |
| `MAIL_USER` / `MAIL_PASS` | – | Shared credentials for IMAP and SMTP |
| `MAIL_FROM` | SMTP user | Sender, e.g. `Max Muster <max@example.com>` |
| `MAIL_SAVE_SENT` | `true` | Append sent mail to the Sent folder (disable for Gmail, which does this itself) |
| `MAIL_SENT_MAILBOX` / `MAIL_TRASH_MAILBOX` / `MAIL_DRAFTS_MAILBOX` | auto-detected | Override folder names if the server does not announce SPECIAL-USE |
| `MAIL_TLS_REJECT_UNAUTHORIZED` | `true` | Set `false` only for self-signed test servers |

## Als lokaler MCP-Server per JSON einbinden (direkt aus GitHub)

Kein Download, kein Klonen nötig – `npx` holt und baut den Server beim ersten Start direkt aus GitHub (Node.js ≥ 18 und `git` müssen installiert sein).

In die MCP-Konfiguration eintragen (Vorlage: [`mcp.example.json`](mcp.example.json)):
- **Claude Desktop:** `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) bzw. `%APPDATA%\Claude\claude_desktop_config.json` (Windows)
- **Claude Code:** `.mcp.json` im Projekt
- **Cursor / andere Clients:** deren `mcp.json`

```json
{
  "mcpServers": {
    "mail": {
      "command": "npx",
      "args": ["-y", "github:m8rzel/mail-mcp"],
      "env": {
        "IMAP_HOST": "imap.example.com",
        "SMTP_HOST": "smtp.example.com",
        "MAIL_USER": "du@example.com",
        "MAIL_PASS": "dein-passwort",
        "MAIL_FROM": "Dein Name <du@example.com>"
      }
    }
  }
}
```

Client neu starten – fertig. Eine bestimmte Version/Branch: `"github:m8rzel/mail-mcp#v0.1.0"`. Ist das Repo privat, braucht der Rechner Git-Zugriff darauf (SSH-Key oder Credential-Helper).

Claude Code CLI:

```bash
claude mcp add mail -e IMAP_HOST=imap.example.com -e SMTP_HOST=smtp.example.com \
  -e MAIL_USER=du@example.com -e MAIL_PASS=dein-passwort -- npx -y github:m8rzel/mail-mcp
```

## Alternative: run from a local clone

`claude_desktop_config.json` (or `.mcp.json` for Claude Code):

```json
{
  "mcpServers": {
    "mail": {
      "command": "node",
      "args": ["/absolute/path/to/mail-mcp/dist/index.js"],
      "env": {
        "IMAP_HOST": "imap.example.com",
        "SMTP_HOST": "smtp.example.com",
        "SMTP_PORT": "587",
        "MAIL_USER": "max@example.com",
        "MAIL_PASS": "app-password",
        "MAIL_FROM": "Max Muster <max@example.com>"
      }
    }
  }
}
```

Claude Code CLI:

```bash
claude mcp add mail \
  -e IMAP_HOST=imap.example.com -e SMTP_HOST=smtp.example.com -e SMTP_PORT=587 \
  -e MAIL_USER=max@example.com -e MAIL_PASS=app-password \
  -- node /absolute/path/to/mail-mcp/dist/index.js
```

## Development

```bash
npm run build   # compile TypeScript
npm test        # end-to-end test against an in-process IMAP (hoodiecrow) and SMTP server
```

## Notes

- Each tool call opens its own IMAP connection, so there are no stale/idle sessions to manage.
- Bcc recipients are delivered but never written into message headers (also not in the Sent copy).
- Passwords are only read from environment variables; never commit them.
