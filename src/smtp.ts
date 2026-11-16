import nodemailer, { type Transporter } from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type Mail from "nodemailer/lib/mailer/index.js";
import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";

export class SmtpService {
  private transporter: Transporter;

  constructor(private readonly config: Config) {
    const { smtp } = config;
    this.transporter = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: { user: smtp.user, pass: smtp.pass },
      tls: { rejectUnauthorized: smtp.rejectUnauthorized },
    });
  }

  /** Builds the raw RFC822 message so the exact same bytes can be sent and stored in "Sent". */
  async build(options: Mail.Options): Promise<Buffer> {
    const composer = new MailComposer({ from: this.config.from, ...options });
    return composer.compile().build();
  }

  async send(options: Mail.Options) {
    // Fix the Message-ID up front so the returned id matches the sent bytes and the Sent copy.
    const mail = { from: this.config.from, messageId: options.messageId ?? this.newMessageId(), ...options };
    const raw = await this.build(mail);
    // With `raw`, nodemailer derives the SMTP envelope (incl. Bcc) from from/to/cc/bcc.
    const info = await this.transporter.sendMail({ from: mail.from, to: mail.to, cc: mail.cc, bcc: mail.bcc, raw });
    return { info: { ...info, messageId: mail.messageId }, raw };
  }

  private newMessageId(): string {
    const domain = /@([^>\s]+)/.exec(this.config.from)?.[1] ?? "localhost";
    return `<${randomUUID()}@${domain}>`;
  }

  async verify() {
    return this.transporter.verify();
  }
}
