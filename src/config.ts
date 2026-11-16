export interface ServerConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  rejectUnauthorized: boolean;
}

export interface Config {
  imap: ServerConfig;
  smtp: ServerConfig;
  from: string;
  saveSent: boolean;
  sentMailbox?: string;
  trashMailbox?: string;
  draftsMailbox?: string;
}

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v !== undefined && v !== "") return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required environment variable ${name}`);
}

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

export function loadConfig(): Config {
  const user = process.env.MAIL_USER;
  const pass = process.env.MAIL_PASS;
  const rejectUnauthorized = bool(process.env.MAIL_TLS_REJECT_UNAUTHORIZED, true);

  const imapPort = Number(env("IMAP_PORT", "993"));
  const imap: ServerConfig = {
    host: env("IMAP_HOST"),
    port: imapPort,
    secure: bool(process.env.IMAP_SECURE, imapPort === 993),
    user: env("IMAP_USER", user),
    pass: env("IMAP_PASS", pass),
    rejectUnauthorized,
  };

  const smtpPort = Number(env("SMTP_PORT", "465"));
  const smtp: ServerConfig = {
    host: env("SMTP_HOST", imap.host),
    port: smtpPort,
    secure: bool(process.env.SMTP_SECURE, smtpPort === 465),
    user: env("SMTP_USER", imap.user),
    pass: env("SMTP_PASS", imap.pass),
    rejectUnauthorized,
  };

  return {
    imap,
    smtp,
    from: env("MAIL_FROM", smtp.user),
    saveSent: bool(process.env.MAIL_SAVE_SENT, true),
    sentMailbox: process.env.MAIL_SENT_MAILBOX || undefined,
    trashMailbox: process.env.MAIL_TRASH_MAILBOX || undefined,
    draftsMailbox: process.env.MAIL_DRAFTS_MAILBOX || undefined,
  };
}
