import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Actor, assertAdmin, assertHr, audit, EmploymentAccess } from '../common/access';
import { Tx } from '../db/db.service';

export type FieldType = 'text' | 'number' | 'date' | 'boolean' | 'select';
export type Entity = 'person' | 'employment';

export interface CustomField {
  id: string;
  entity: Entity;
  key: string;
  label: string;
  type: FieldType;
  options: string[];
  required: boolean;
  visibility: 'hr' | 'manager' | 'employee';
  position: number;
  active: boolean;
}

/**
 * Valida y normaliza los valores de campos personalizados de una entidad. Devuelve el
 * objeto a guardar o lanza 400 con todos los errores. Las claves desconocidas se ignoran.
 */
export function validateCustomValues(fields: CustomField[], current: Record<string, unknown>, input: Record<string, unknown>) {
  const out: Record<string, unknown> = { ...current };
  const errors: string[] = [];
  for (const f of fields.filter((x) => x.active)) {
    if (!(f.key in input)) {
      if (f.required && (out[f.key] === undefined || out[f.key] === null || out[f.key] === '')) errors.push(`«${f.label}» es obligatorio`);
      continue;
    }
    const v = input[f.key];
    if (v === null || v === '') {
      if (f.required) errors.push(`«${f.label}» es obligatorio`);
      delete out[f.key];
      continue;
    }
    switch (f.type) {
      case 'text':
        if (typeof v !== 'string' || v.length > 2000) errors.push(`«${f.label}» debe ser un texto`);
        else out[f.key] = v.trim();
        break;
      case 'number': {
        const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
        if (!Number.isFinite(n)) errors.push(`«${f.label}» debe ser un número`);
        else out[f.key] = n;
        break;
      }
      case 'date':
        if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) errors.push(`«${f.label}» debe ser una fecha AAAA-MM-DD`);
        else out[f.key] = v;
        break;
      case 'boolean':
        if (typeof v !== 'boolean') errors.push(`«${f.label}» debe ser sí o no`);
        else out[f.key] = v;
        break;
      case 'select':
        if (typeof v !== 'string' || !f.options.includes(v)) errors.push(`«${f.label}» debe ser una de: ${f.options.join(', ')}`);
        else out[f.key] = v;
        break;
    }
  }
  if (errors.length) throw new BadRequestException({ message: 'Campos personalizados no válidos', issues: errors.map((message) => ({ path: '', message })) });
  return out;
}

/** Campos visibles según la relación con la persona. */
export function visibleFields(fields: CustomField[], access: EmploymentAccess): CustomField[] {
  return fields.filter(
    (f) => f.active && (access === 'hr' || (access === 'manager' && f.visibility !== 'hr') || (access === 'self' && f.visibility === 'employee')),
  );
}

@Injectable()
export class CustomFieldsService {
  list(tx: Tx): Promise<CustomField[]> {
    return tx.query('SELECT id, entity, key, label, type, options, required, visibility, position, active FROM custom_field ORDER BY entity, position, label');
  }

  async save(tx: Tx, actor: Actor, id: string | null, input: Omit<CustomField, 'id'>) {
    assertAdmin(actor);
    if (input.type === 'select' && input.options.length < 2) throw new BadRequestException('Una lista necesita al menos dos opciones');
    if (id) {
      const ex = await tx.maybeOne('SELECT entity, key FROM custom_field WHERE id = $1', [id]);
      if (!ex) throw new NotFoundException();
      // La clave y la entidad no cambian: se perderían los valores ya guardados.
      await tx.query(
        `UPDATE custom_field SET label = $2, type = $3, options = $4, required = $5, visibility = $6, position = $7, active = $8 WHERE id = $1`,
        [id, input.label, input.type, JSON.stringify(input.options), input.required, input.visibility, input.position, input.active],
      );
    } else {
      id = (
        await tx.one(
          `INSERT INTO custom_field (tenant_id, entity, key, label, type, options, required, visibility, position, active)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [tx.tenantId, input.entity, input.key, input.label, input.type, JSON.stringify(input.options), input.required, input.visibility, input.position, input.active],
        )
      ).id;
    }
    await audit(tx, 'custom_field.saved', 'custom_field', id, input);
    return { id };
  }

  async setValues(tx: Tx, actor: Actor, employmentId: string, input: { person?: Record<string, unknown>; employment?: Record<string, unknown> }) {
    const emp = await tx.maybeOne('SELECT company_id, person_id, custom_values FROM employment WHERE id = $1', [employmentId]);
    if (!emp) throw new NotFoundException();
    assertHr(actor, emp.company_id);
    const fields = await this.list(tx);
    if (input.person) {
      const p = await tx.one('SELECT custom_values FROM person WHERE id = $1', [emp.person_id]);
      const values = validateCustomValues(fields.filter((f) => f.entity === 'person'), p.custom_values, input.person);
      await tx.query('UPDATE person SET custom_values = $2 WHERE id = $1', [emp.person_id, JSON.stringify(values)]);
    }
    if (input.employment) {
      const values = validateCustomValues(fields.filter((f) => f.entity === 'employment'), emp.custom_values, input.employment);
      await tx.query('UPDATE employment SET custom_values = $2 WHERE id = $1', [employmentId, JSON.stringify(values)]);
    }
    await audit(tx, 'employee.custom_values_updated', 'employment', employmentId, { keys: [...Object.keys(input.person ?? {}), ...Object.keys(input.employment ?? {})] });
    return { ok: true };
  }
}
