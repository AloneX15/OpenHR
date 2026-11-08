import { Injectable } from '@nestjs/common';
import { config } from '../config';
import { Tx } from '../db/db.service';

export interface NotifyInput {
  type: string;
  title: string;
  body?: string;
  /** Ruta de la web, p. ej. /ausencias */
  link?: string;
  email?: boolean;
}

@Injectable()
export class NotificationsService {
  /**
   * Crea la notificación en la bandeja y, si procede, encola el email en el outbox
   * dentro de la misma transacción: si la operación de negocio falla, no sale nada.
   */
  async notifyUsers(tx: Tx, userIds: string[], n: NotifyInput) {
    const unique = [...new Set(userIds.filter(Boolean))];
    for (const userId of unique) {
      await tx.query(
        `INSERT INTO notification (tenant_id, user_id, type, title, body, link) VALUES ($1, $2, $3, $4, $5, $6)`,
        [tx.tenantId, userId, n.type, n.title, n.body ?? null, n.link ?? null],
      );
      if (n.email !== false) {
        const u = await tx.maybeOne<{ email: string; is_active: boolean }>(
          'SELECT email, is_active FROM app_user WHERE id = $1',
          [userId],
        );
        if (u?.is_active) {
          const link = n.link ? `\n\n${config.publicUrl}${n.link}` : '';
          await this.queueEmail(tx, u.email, n.title, `${n.body ?? n.title}${link}`);
        }
      }
    }
  }

  async queueEmail(tx: Tx, to: string, subject: string, text: string) {
    await tx.query(`INSERT INTO outbox (tenant_id, type, payload) VALUES ($1, 'email', $2)`, [
      tx.tenantId,
      JSON.stringify({ to, subject, text }),
    ]);
  }

  /** Usuarios con rol de RR. HH. (o admin) para una sociedad. */
  async hrUserIds(tx: Tx, companyId: string): Promise<string[]> {
    const rows = await tx.query<{ user_id: string }>(
      `SELECT DISTINCT user_id FROM role_assignment
        WHERE role = 'admin' OR (role = 'hr' AND (company_id IS NULL OR company_id = $1))`,
      [companyId],
    );
    return rows.map((r) => r.user_id);
  }

  /** Usuario del responsable directo de una relación laboral, si lo tiene. */
  async managerUserId(tx: Tx, employmentId: string): Promise<string | null> {
    const row = await tx.maybeOne<{ id: string }>(
      `SELECT u.id FROM employment e
         JOIN employment m ON m.id = e.manager_employment_id
         JOIN app_user u ON u.person_id = m.person_id AND u.is_active
        WHERE e.id = $1`,
      [employmentId],
    );
    return row?.id ?? null;
  }

  async userIdForEmployment(tx: Tx, employmentId: string): Promise<string | null> {
    const row = await tx.maybeOne<{ id: string }>(
      `SELECT u.id FROM employment e JOIN app_user u ON u.person_id = e.person_id WHERE e.id = $1`,
      [employmentId],
    );
    return row?.id ?? null;
  }
}
