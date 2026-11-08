import { BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { Actor, assertHr, audit, canHr, hrCompanyFilter } from '../common/access';
import { safeEqual, sha256 } from '../common/crypto';
import { Tx } from '../db/db.service';
import { StorageService } from '../documents/storage.service';
import { NotificationsService } from '../notifications/notifications.service';

const OTP_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;

export interface SignatureEvidence {
  signer: { personId: string; userId: string; name: string; nationalId: string | null; email: string };
  document: { title: string; filename: string; sha256: string };
  signedAt: string;
  ip: string | null;
  userAgent: string | null;
  method: 'session+email_otp';
  consent: string;
}

/**
 * Añade al final del PDF una hoja de firma con las evidencias. Devuelve el PDF firmado.
 * Es una firma electrónica simple (eIDAS art. 3.10): la prueba es el conjunto de evidencias
 * y su huella, no un certificado cualificado.
 */
export async function stampSignaturePage(original: Buffer, ev: SignatureEvidence): Promise<Buffer> {
  const pdf = await PDFDocument.load(original);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const page = pdf.addPage([595.28, 841.89]);
  const navy = rgb(0.043, 0.122, 0.227);
  let y = 780;
  const line = (text: string, opts: { size?: number; f?: typeof font; gap?: number } = {}) => {
    page.drawText(text, { x: 56, y, size: opts.size ?? 10, font: opts.f ?? font, color: navy, maxWidth: 480 });
    y -= opts.gap ?? 16;
  };
  // Las fuentes estándar de PDF solo admiten WinAnsi: se quitan caracteres fuera de rango.
  const safe = (s: string) => s.replace(/[^\x20-\x7e -ÿ]/g, '?');
  line('Hoja de firma electronica', { size: 16, f: bold, gap: 28 });
  line(`Documento: ${safe(ev.document.title)}`);
  line(`Fichero original: ${safe(ev.document.filename)}`);
  line(`SHA-256 del original: ${ev.document.sha256}`, { size: 8, gap: 24 });
  line(`Firmante: ${safe(ev.signer.name)}`, { f: bold });
  line(`DNI/NIE: ${ev.signer.nationalId ?? 'no consta'}`);
  line(`Email: ${safe(ev.signer.email)}`);
  line(`Fecha y hora (UTC): ${ev.signedAt}`);
  line(`Direccion IP: ${ev.ip ?? 'no disponible'}`, { gap: 24 });
  line('Metodo: sesion autenticada en OpenHR y codigo de un solo uso enviado al email del firmante.', { size: 9 });
  line(`Declaracion aceptada: "${safe(ev.consent)}"`, { size: 9, gap: 24 });
  line('Firma electronica simple conforme al art. 3.10 del Reglamento (UE) 910/2014 (eIDAS).', { size: 8 });
  line('Las evidencias se conservan en OpenHR junto con la huella de este documento.', { size: 8 });
  return Buffer.from(await pdf.save());
}

export const CONSENT_TEXT = 'He leído el documento y lo firmo electrónicamente.';

@Injectable()
export class SignaturesService {
  constructor(
    private readonly storage: StorageService,
    private readonly notifications: NotificationsService,
  ) {}

  private columns = `s.id, s.company_id, c.name AS company_name, s.person_id, p.first_name || ' ' || p.last_name AS person_name, s.title, s.message,
    s.status, s.created_at, s.due_date::text, s.signed_at, s.decline_reason, s.document_id, f.filename`;

  async request(
    tx: Tx,
    actor: Actor,
    input: { personId: string; companyId: string; title: string; message?: string; dueDate?: string },
    file: { buffer: Buffer; originalname: string },
  ) {
    assertHr(actor, input.companyId);
    if (file.buffer.subarray(0, 5).toString() !== '%PDF-') throw new BadRequestException('Solo se pueden firmar PDF');
    try {
      await PDFDocument.load(file.buffer);
    } catch {
      throw new BadRequestException('No se puede leer el PDF (¿está protegido?)');
    }
    const emp = await tx.maybeOne('SELECT 1 FROM employment WHERE person_id = $1 AND company_id = $2', [input.personId, input.companyId]);
    if (!emp) throw new BadRequestException('La persona no tiene relación laboral con esa sociedad');
    const stored = await this.storage.store(tx, file.buffer, file.originalname, 'application/pdf');
    const row = await tx.one(
      `INSERT INTO signature_request (tenant_id, company_id, person_id, title, message, file_id, requested_by, due_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [tx.tenantId, input.companyId, input.personId, input.title, input.message ?? null, stored.id, actor.userId, input.dueDate ?? null],
    );
    const user = await tx.maybeOne('SELECT id FROM app_user WHERE person_id = $1 AND is_active', [input.personId]);
    if (user) {
      await this.notifications.notifyUsers(tx, [user.id], {
        type: 'signature.requested',
        title: `Tienes un documento para firmar: ${input.title}`,
        body: input.message ?? 'Léelo y fírmalo en OpenHR.',
        link: '/firmas',
      });
    }
    await audit(tx, 'signature.requested', 'signature_request', row.id, { personId: input.personId, title: input.title, sha256: stored.sha256 });
    return row;
  }

  mine(tx: Tx, actor: Actor) {
    if (!actor.personId) return Promise.resolve([]);
    return tx.query(
      `SELECT ${this.columns} FROM signature_request s JOIN company c ON c.id = s.company_id JOIN person p ON p.id = s.person_id
         JOIN stored_file f ON f.id = s.file_id WHERE s.person_id = $1 AND s.status <> 'cancelled' ORDER BY (s.status = 'pending') DESC, s.created_at DESC`,
      [actor.personId],
    );
  }

  list(tx: Tx, actor: Actor) {
    const companies = hrCompanyFilter(actor);
    if (companies !== null && companies.length === 0) throw new ForbiddenException();
    return tx.query(
      `SELECT ${this.columns} FROM signature_request s JOIN company c ON c.id = s.company_id JOIN person p ON p.id = s.person_id
         JOIN stored_file f ON f.id = s.file_id WHERE ($1::uuid[] IS NULL OR s.company_id = ANY($1)) ORDER BY s.created_at DESC LIMIT 300`,
      [companies],
    );
  }

  private async load(tx: Tx, id: string, lock = false) {
    const s = await tx.maybeOne(`SELECT * FROM signature_request WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [id]);
    if (!s) throw new NotFoundException('Solicitud de firma no encontrada');
    return s;
  }

  async file(tx: Tx, actor: Actor, id: string, signed: boolean) {
    const s = await this.load(tx, id);
    if (s.person_id !== actor.personId && !canHr(actor, s.company_id)) throw new ForbiddenException();
    const fileId = signed ? s.signed_file_id : s.file_id;
    if (!fileId) throw new NotFoundException('Aún no está firmado');
    return this.storage.read(tx, fileId);
  }

  /** Envía al email de la persona un código de 6 dígitos (10 minutos, 5 intentos). */
  async sendCode(tx: Tx, actor: Actor, id: string) {
    const s = await this.load(tx, id, true);
    if (s.person_id !== actor.personId) throw new ForbiddenException('Solo la persona destinataria puede firmar');
    if (s.status !== 'pending') throw new ConflictException('Este documento ya no está pendiente de firma');
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await tx.query(
      `UPDATE signature_request SET otp_hash = $2, otp_expires_at = now() + make_interval(mins => $3), otp_attempts = 0 WHERE id = $1`,
      [id, sha256(`${id}:${code}`), OTP_MINUTES],
    );
    const u = await tx.one('SELECT email FROM app_user WHERE id = $1', [actor.userId]);
    await this.notifications.queueEmail(
      tx,
      u.email,
      `Código para firmar «${s.title}»`,
      `Tu código de firma es: ${code}\n\nCaduca en ${OTP_MINUTES} minutos. Si no estás firmando un documento en OpenHR, ignora este mensaje.`,
    );
    return { sentTo: u.email.replace(/^(.).*(@.*)$/, '$1***$2'), expiresInMinutes: OTP_MINUTES };
  }

  async sign(tx: Tx, actor: Actor, id: string, code: string, meta: { ip?: string; userAgent?: string }) {
    const s = await this.load(tx, id, true);
    if (s.person_id !== actor.personId) throw new ForbiddenException('Solo la persona destinataria puede firmar');
    if (s.status !== 'pending') throw new ConflictException('Este documento ya no está pendiente de firma');
    if (!s.otp_hash || !s.otp_expires_at || new Date(s.otp_expires_at) < new Date()) {
      throw new BadRequestException('Pide un código nuevo: el anterior ha caducado');
    }
    if (s.otp_attempts >= OTP_MAX_ATTEMPTS) throw new HttpException('Demasiados intentos: pide un código nuevo', HttpStatus.TOO_MANY_REQUESTS);
    if (!safeEqual(sha256(`${id}:${code.trim()}`), s.otp_hash)) {
      await tx.query('UPDATE signature_request SET otp_attempts = otp_attempts + 1 WHERE id = $1', [id]);
      // Se devuelve sin lanzar para que el intento fallido quede guardado (la transacción se confirma).
      return { ok: false as const };
    }
    const { file, data } = await this.storage.read(tx, s.file_id);
    const who = await tx.one(
      `SELECT p.first_name || ' ' || p.last_name AS name, p.national_id, u.email FROM person p JOIN app_user u ON u.id = $2 WHERE p.id = $1`,
      [s.person_id, actor.userId],
    );
    const evidence: SignatureEvidence = {
      signer: { personId: s.person_id, userId: actor.userId, name: who.name, nationalId: who.national_id, email: who.email },
      document: { title: s.title, filename: file.filename, sha256: file.sha256 },
      signedAt: new Date().toISOString(),
      ip: meta.ip ?? null,
      userAgent: meta.userAgent?.slice(0, 300) ?? null,
      method: 'session+email_otp',
      consent: CONSENT_TEXT,
    };
    const signedPdf = await stampSignaturePage(data, evidence);
    const signedFile = await this.storage.store(tx, signedPdf, file.filename.replace(/\.pdf$/i, '') + '-firmado.pdf', 'application/pdf');
    const doc = await tx.one(
      `INSERT INTO document (tenant_id, person_id, company_id, file_id, category, title, created_by) VALUES ($1,$2,$3,$4,'signed',$5,$6) RETURNING id`,
      [tx.tenantId, s.person_id, s.company_id, signedFile.id, `${s.title} (firmado)`, actor.userId],
    );
    await tx.query(
      `UPDATE signature_request SET status = 'signed', signed_at = $2, signed_file_id = $3, document_id = $4, evidence = $5,
              otp_hash = NULL, otp_expires_at = NULL WHERE id = $1`,
      [id, evidence.signedAt, signedFile.id, doc.id, JSON.stringify({ ...evidence, signedFileSha256: signedFile.sha256 })],
    );
    await this.notifications.notifyUsers(tx, [s.requested_by], {
      type: 'signature.signed',
      title: `${who.name} ha firmado «${s.title}»`,
      link: '/firmas',
      email: false,
    });
    await audit(tx, 'signature.signed', 'signature_request', id, { original: file.sha256, signed: signedFile.sha256 });
    return { ok: true as const, documentId: doc.id as string, sha256: signedFile.sha256 };
  }

  async decline(tx: Tx, actor: Actor, id: string, reason: string) {
    const s = await this.load(tx, id, true);
    if (s.person_id !== actor.personId) throw new ForbiddenException();
    if (s.status !== 'pending') throw new ConflictException('Este documento ya no está pendiente de firma');
    await tx.query(`UPDATE signature_request SET status = 'declined', decline_reason = $2, otp_hash = NULL WHERE id = $1`, [id, reason]);
    await this.notifications.notifyUsers(tx, [s.requested_by], { type: 'signature.declined', title: `Se ha rechazado la firma de «${s.title}»`, body: reason, link: '/firmas' });
    await audit(tx, 'signature.declined', 'signature_request', id, { reason });
    return { ok: true };
  }

  async cancel(tx: Tx, actor: Actor, id: string) {
    const s = await this.load(tx, id, true);
    assertHr(actor, s.company_id);
    if (s.status !== 'pending') throw new ConflictException('Solo se pueden anular solicitudes pendientes');
    await tx.query(`UPDATE signature_request SET status = 'cancelled', otp_hash = NULL WHERE id = $1`, [id]);
    await audit(tx, 'signature.cancelled', 'signature_request', id);
    return { ok: true };
  }

  async evidence(tx: Tx, actor: Actor, id: string) {
    const s = await this.load(tx, id);
    if (s.person_id !== actor.personId && !canHr(actor, s.company_id)) throw new ForbiddenException();
    return { status: s.status, evidence: s.evidence };
  }
}
