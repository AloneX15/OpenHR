import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Actor, assertAdmin, audit } from '../common/access';
import { decrypt, encrypt } from '../common/crypto';
import { config } from '../config';
import { Tx } from '../db/db.service';

export type ChatProvider = 'slack' | 'teams';
export type ChatEvent = 'announcement' | 'absence' | 'welcome';

export interface ChatMessage {
  title: string;
  text: string;
  /** Ruta de la web, p. ej. /anuncios */
  link?: string;
}

/** Dominios a los que puede apuntar un webhook de cada servicio (y sus subdominios). */
const HOSTS: Record<ChatProvider, string[]> = {
  slack: ['hooks.slack.com'],
  // Flujos de trabajo de Teams (Power Automate) y los antiguos conectores de Office 365.
  teams: ['logic.azure.com', 'api.powerplatform.com', 'webhook.office.com'],
};

export function allowedWebhook(provider: ChatProvider, raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null;
  const host = url.hostname.toLowerCase();
  return HOSTS[provider].some((h) => host === h || host.endsWith('.' + h)) ? url : null;
}

/** Cuerpo del mensaje en el formato de cada servicio. */
export function chatPayload(provider: ChatProvider, m: ChatMessage) {
  const url = m.link ? `${config.publicUrl}${m.link}` : undefined;
  if (provider === 'slack') {
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return { text: `*${esc(m.title)}*\n${esc(m.text)}${url ? `\n<${url}|Abrir en OpenHR>` : ''}` };
  }
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body: [
            { type: 'TextBlock', text: m.title, weight: 'Bolder', size: 'Medium', wrap: true },
            { type: 'TextBlock', text: m.text, wrap: true },
          ],
          actions: url ? [{ type: 'Action.OpenUrl', title: 'Abrir en OpenHR', url }] : [],
        },
      },
    ],
  };
}

@Injectable()
export class ChatService {
  list(tx: Tx) {
    return tx.query(
      `SELECT w.id, w.company_id, c.name AS company_name, w.provider, w.label, w.url_hint, w.events, w.enabled, w.last_sent_at, w.last_error, w.created_at
         FROM chat_webhook w LEFT JOIN company c ON c.id = w.company_id ORDER BY w.created_at`,
    );
  }

  async save(
    tx: Tx,
    actor: Actor,
    id: string | null,
    input: { provider: ChatProvider; label: string; url?: string; companyId: string | null; events: ChatEvent[]; enabled: boolean },
  ) {
    assertAdmin(actor);
    let urlCols: { enc: string; hint: string } | null = null;
    if (input.url) {
      const url = allowedWebhook(input.provider, input.url);
      if (!url) {
        throw new BadRequestException(
          input.provider === 'slack'
            ? 'La URL debe ser un webhook entrante de Slack (https://hooks.slack.com/…)'
            : 'La URL debe ser un webhook de un flujo de trabajo de Teams (Power Automate)',
        );
      }
      urlCols = { enc: encrypt(url.toString()), hint: url.hostname };
    } else if (!id) throw new BadRequestException('Falta la URL del webhook');

    let row;
    if (id) {
      row = await tx.maybeOne(
        `UPDATE chat_webhook SET provider = $2, label = $3, company_id = $4, events = $5, enabled = $6,
                url_enc = coalesce($7, url_enc), url_hint = coalesce($8, url_hint), last_error = CASE WHEN $7 IS NULL THEN last_error END
          WHERE id = $1 RETURNING id`,
        [id, input.provider, input.label, input.companyId, input.events, input.enabled, urlCols?.enc ?? null, urlCols?.hint ?? null],
      );
      if (!row) throw new NotFoundException();
    } else {
      row = await tx.one(
        `INSERT INTO chat_webhook (tenant_id, company_id, provider, label, url_enc, url_hint, events, enabled, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [tx.tenantId, input.companyId, input.provider, input.label, urlCols!.enc, urlCols!.hint, input.events, input.enabled, actor.userId],
      );
    }
    // Nunca se audita la URL: es la credencial del canal.
    await audit(tx, 'chat_webhook.saved', 'chat_webhook', row.id, { provider: input.provider, label: input.label, events: input.events, enabled: input.enabled, urlChanged: !!urlCols });
    return row;
  }

  async remove(tx: Tx, actor: Actor, id: string) {
    assertAdmin(actor);
    await tx.query('DELETE FROM chat_webhook WHERE id = $1', [id]);
    await audit(tx, 'chat_webhook.deleted', 'chat_webhook', id);
    return { ok: true };
  }

  async test(tx: Tx, actor: Actor, id: string) {
    assertAdmin(actor);
    const w = await tx.maybeOne('SELECT id FROM chat_webhook WHERE id = $1', [id]);
    if (!w) throw new NotFoundException();
    await this.enqueue(tx, id, { title: 'OpenHR conectado', text: 'Este canal recibirá los avisos que hayas elegido.', link: '/' });
    return { ok: true };
  }

  /** Publica un aviso en los canales suscritos a ese evento (de la sociedad o de todo el grupo). */
  async emit(tx: Tx, event: ChatEvent, companyId: string | null, m: ChatMessage) {
    const hooks = await tx.query<{ id: string }>(
      `SELECT id FROM chat_webhook WHERE enabled AND $1 = ANY(events) AND (company_id IS NULL OR $2::uuid IS NULL OR company_id = $2)`,
      [event, companyId],
    );
    for (const h of hooks) await this.enqueue(tx, h.id, m);
  }

  private enqueue(tx: Tx, webhookId: string, m: ChatMessage) {
    return tx.query(`INSERT INTO outbox (tenant_id, type, payload) VALUES ($1, 'chat', $2)`, [tx.tenantId, JSON.stringify({ webhookId, ...m })]);
  }

  /** Lo llama el outbox: descifra la URL y envía, sin redirecciones ni más de 10 s. Devuelve el error, si lo hay. */
  async deliver(tx: Tx, payload: { webhookId: string } & ChatMessage, fetchImpl: typeof fetch = fetch): Promise<string | null> {
    const w = await tx.maybeOne('SELECT provider, url_enc, enabled FROM chat_webhook WHERE id = $1', [payload.webhookId]);
    if (!w || !w.enabled) return null; // borrado o desactivado: se descarta
    const url = allowedWebhook(w.provider, decrypt(w.url_enc));
    if (!url) return 'Webhook no permitido';
    let error: string | null = null;
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(chatPayload(w.provider, payload)),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) error = `El servicio respondió ${res.status}`;
    } catch (err) {
      error = (err as Error).message.slice(0, 300);
    }
    await tx.query('UPDATE chat_webhook SET last_sent_at = CASE WHEN $2::text IS NULL THEN now() ELSE last_sent_at END, last_error = $2 WHERE id = $1', [
      payload.webhookId,
      error,
    ]);
    return error;
  }
}
