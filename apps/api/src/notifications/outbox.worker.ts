import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import nodemailer, { Transporter } from 'nodemailer';
import { config } from '../config';
import { Db } from '../db/db.service';

/** Procesa el outbox: envía emails con reintentos y espera exponencial. */
@Injectable()
export class OutboxWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('Outbox');
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private transport: Transporter | null = null;

  constructor(private readonly db: Db) {}

  onApplicationBootstrap() {
    if (!config.outboxWorker) return;
    if (config.smtp.host) {
      this.transport = nodemailer.createTransport({
        host: config.smtp.host,
        port: config.smtp.port,
        secure: config.smtp.port === 465,
        auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.password } : undefined,
      });
    } else {
      this.log.warn('SMTP_HOST vacío: los emails se escriben en el log en lugar de enviarse');
    }
    this.timer = setInterval(() => void this.tick(), 5000);
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const jobs = await this.db.raw<{ id: string; type: string; payload: any }>('SELECT * FROM outbox_claim(20)');
      for (const job of jobs) {
        let error: string | null = null;
        try {
          await this.handle(job.type, job.payload);
        } catch (err) {
          error = (err as Error).message.slice(0, 500);
          this.log.warn(`Fallo en outbox ${job.id}: ${error}`);
        }
        await this.db.raw('SELECT outbox_finish($1, $2)', [job.id, error]);
      }
    } catch (err) {
      this.log.error(`Outbox: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  private async handle(type: string, payload: any) {
    if (type !== 'email') throw new Error(`Tipo de outbox desconocido: ${type}`);
    if (!this.transport) {
      this.log.log(`[email] Para: ${payload.to} · ${payload.subject}\n${payload.text}`);
      return;
    }
    await this.transport.sendMail({
      from: config.smtp.from,
      to: payload.to,
      subject: payload.subject,
      text: payload.text,
      attachments: payload.attachments,
    });
  }
}
