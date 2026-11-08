'use client';

import { useRouter } from 'next/navigation';
import { FormEvent, useState } from 'react';
import { api } from '@/lib/api';
import { dateTime, dayLabel, todayIso } from '@/lib/format';
import { IconButton } from './icons';
import { Badge, Card, Empty, ErrorBox, Field, Modal, Notice, useAction, useLoad } from './ui';

export const CHECKLIST_KIND: Record<string, string> = { onboarding: 'Alta', offboarding: 'Baja', transfer: 'Traspaso' };
export const ASSIGNEE: Record<string, string> = { hr: 'RR. HH.', manager: 'Responsable', employee: 'La persona' };
const FIELD_TYPE: Record<string, string> = { text: 'Texto', number: 'Número', date: 'Fecha', boolean: 'Sí / No', select: 'Lista' };
const VISIBILITY: Record<string, string> = { hr: 'Solo RR. HH.', manager: 'RR. HH. y responsable', employee: 'También la persona' };

/** Casilla de una tarea: se marca o desmarca al pulsar. */
function TaskRow({ task, canToggle, onChange }: { task: any; canToggle: boolean; onChange: () => Promise<void> }) {
  const action = useAction();
  const overdue = !task.done_at && task.due_date && task.due_date < todayIso();
  return (
    <li className="task">
      <label className="check" style={{ margin: 0 }}>
        <input
          type="checkbox"
          checked={Boolean(task.done_at)}
          disabled={!canToggle || action.busy}
          onChange={(e) => action.run(async () => (await api.post(`/checklists/tasks/${task.id}`, { done: e.target.checked }), onChange()))}
        />
        <span className={task.done_at ? 'strike' : ''}>{task.title}</span>
      </label>
      <span className="small muted">
        {' '}
        · {ASSIGNEE[task.assignee]}
        {task.due_date && <> · {overdue ? <span className="text-danger">vence {dayLabel(task.due_date)}</span> : `vence ${dayLabel(task.due_date)}`}</>}
        {task.done_at && <> · hecho por {task.done_by_name} el {dateTime(task.done_at)}</>}
      </span>
      {task.description && <div className="small muted">{task.description}</div>}
      <ErrorBox error={action.error} />
    </li>
  );
}

/** Checklists de una persona (pestaña de su ficha). */
export function EmployeeChecklists({ employmentId, isHr, companyId }: { employmentId: string; isHr: boolean; companyId: string }) {
  const lists = useLoad(() => api.get<any[]>(`/org/employees/${employmentId}/checklists`), [employmentId]);
  const templates = useLoad(() => (isHr ? api.get<any[]>('/checklists/templates') : Promise.resolve([])));
  const [templateId, setTemplateId] = useState('');
  const action = useAction();
  const usable = (templates.data ?? []).filter((t) => t.active && (!t.company_id || t.company_id === companyId));
  return (
    <div className="stack">
      {isHr && (
        <Card title="Iniciar un checklist">
          <ErrorBox error={action.error} />
          <div className="row">
            <select aria-label="Plantilla" value={templateId} onChange={(e) => setTemplateId(e.target.value)} style={{ width: 'auto' }}>
              <option value="">Elige una plantilla…</option>
              {usable.map((t) => (
                <option key={t.id} value={t.id}>
                  {CHECKLIST_KIND[t.kind]}: {t.name}
                </option>
              ))}
            </select>
            <button
              className="btn"
              disabled={!templateId || action.busy}
              onClick={() => action.run(async () => (await api.post(`/org/employees/${employmentId}/checklists`, { templateId, referenceDate: todayIso() }), lists.reload()))}
            >
              Iniciar
            </button>
          </div>
        </Card>
      )}
      <ErrorBox error={lists.error} />
      {lists.data?.length ? (
        lists.data.map((l) => {
          const done = l.tasks.filter((t: any) => t.done_at).length;
          return (
            <Card
              key={l.id}
              title={
                <>
                  {CHECKLIST_KIND[l.kind]}: {l.name}{' '}
                  <Badge tone={l.status === 'done' ? 'success' : 'warning'}>{l.status === 'done' ? 'Completado' : `${done} de ${l.tasks.length}`}</Badge>
                </>
              }
            >
              <p className="muted small">Fecha de referencia: {dayLabel(l.reference_date)}</p>
              <ul className="list">
                {l.tasks.map((t: any) => (
                  <TaskRow key={t.id} task={t} canToggle onChange={lists.reload} />
                ))}
              </ul>
            </Card>
          );
        })
      ) : (
        <Empty>Sin checklists.</Empty>
      )}
    </div>
  );
}

/** Traspaso a otra sociedad del grupo. */
export function TransferModal({ e, onClose }: { e: any; onClose: () => void }) {
  const router = useRouter();
  const companies = useLoad(() => api.get<any[]>('/org/companies'));
  const others = (companies.data ?? []).filter((c) => c.id !== e.company_id);
  const [companyId, setCompanyId] = useState('');
  const target = companyId || others[0]?.id || '';
  const centers = useLoad(() => (target ? api.get<any[]>(`/org/work-centers?companyId=${target}`) : Promise.resolve([])), [target]);
  const [f, setF] = useState({ effectiveDate: todayIso(), workCenterId: '', jobTitle: e.job_title ?? '' });
  const { busy, error, run } = useAction();
  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    void run(async () => {
      const r = await api.post(`/org/employees/${e.id}/transfer`, {
        companyId: target,
        effectiveDate: f.effectiveDate,
        workCenterId: f.workCenterId || null,
        jobTitle: f.jobTitle || null,
      });
      router.push(`/equipo/${r.employmentId}`);
    });
  };
  return (
    <Modal title={`Traspasar a ${e.first_name} a otra sociedad`} onClose={onClose}>
      <form onSubmit={submit}>
        <p className="muted">
          Su relación laboral con {e.company_name} termina el día anterior y empieza otra en la sociedad de destino, con la misma jornada. Su registro
          horario, ausencias y documentos se conservan en cada sociedad.
        </p>
        <ErrorBox error={error} />
        {!others.length && <Notice tone="warning">No hay otra sociedad en el grupo.</Notice>}
        <div className="form-grid">
          <Field label="Sociedad de destino">
            <select value={target} onChange={(ev) => setCompanyId(ev.target.value)}>
              {others.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Fecha efectiva">
            <input type="date" required min={e.start_date} value={f.effectiveDate} onChange={(ev) => setF({ ...f, effectiveDate: ev.target.value })} />
          </Field>
          <Field label="Centro de trabajo">
            <select value={f.workCenterId} onChange={(ev) => setF({ ...f, workCenterId: ev.target.value })}>
              <option value="">—</option>
              {centers.data?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Puesto">
            <input value={f.jobTitle} onChange={(ev) => setF({ ...f, jobTitle: ev.target.value })} />
          </Field>
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-primary" disabled={busy || !target}>
            Traspasar
          </button>
        </div>
      </form>
    </Modal>
  );
}

function displayValue(f: any) {
  if (f.value === null || f.value === undefined) return '—';
  if (f.type === 'boolean') return f.value ? 'Sí' : 'No';
  if (f.type === 'date') return dayLabel(f.value);
  return String(f.value);
}

/** Campos personalizados de la ficha, con edición para RR. HH. */
export function CustomFieldsCard({ e, isHr, reload }: { e: any; isHr: boolean; reload: () => Promise<void> }) {
  const fields: any[] = e.custom_fields ?? [];
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState<Record<string, any>>(() => Object.fromEntries(fields.map((f) => [f.id, f.value ?? ''])));
  const { busy, error, run } = useAction();
  if (!fields.length) return null;
  const save = (ev: FormEvent) => {
    ev.preventDefault();
    void run(async () => {
      const person: Record<string, unknown> = {};
      const employment: Record<string, unknown> = {};
      for (const f of fields) (f.entity === 'person' ? person : employment)[f.key] = values[f.id] === '' ? null : values[f.id];
      await api.put(`/org/employees/${e.id}/custom-values`, { person, employment });
      await reload();
      setEditing(false);
    });
  };
  return (
    <Card
      title="Más datos"
      actions={
        isHr &&
        !editing && (
          <button className="btn btn-sm" onClick={() => setEditing(true)}>
            Editar
          </button>
        )
      }
    >
      {editing ? (
        <form onSubmit={save}>
          <ErrorBox error={error} />
          <div className="form-grid">
            {fields.map((f) => (
              <Field key={f.id} label={`${f.label}${f.required ? ' *' : ''}`}>
                {f.type === 'boolean' ? (
                  <select value={values[f.id] === '' ? '' : String(values[f.id])} onChange={(ev) => setValues({ ...values, [f.id]: ev.target.value === '' ? '' : ev.target.value === 'true' })}>
                    <option value="">—</option>
                    <option value="true">Sí</option>
                    <option value="false">No</option>
                  </select>
                ) : f.type === 'select' ? (
                  <select value={values[f.id]} onChange={(ev) => setValues({ ...values, [f.id]: ev.target.value })}>
                    <option value="">—</option>
                    {f.options.map((o: string) => (
                      <option key={o}>{o}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}
                    step="any"
                    value={values[f.id]}
                    onChange={(ev) => setValues({ ...values, [f.id]: f.type === 'number' && ev.target.value !== '' ? Number(ev.target.value) : ev.target.value })}
                  />
                )}
              </Field>
            ))}
          </div>
          <div className="modal-actions">
            <button type="button" className="btn" onClick={() => setEditing(false)}>
              Cancelar
            </button>
            <button className="btn btn-primary" disabled={busy}>
              Guardar
            </button>
          </div>
        </form>
      ) : (
        <table>
          <tbody>
            {fields.map((f) => (
              <tr key={f.id}>
                <th style={{ width: '40%' }}>{f.label}</th>
                <td>{displayValue(f)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

/** Organización → plantillas de checklist. */
export function ChecklistTemplatesAdmin() {
  const { data, error, reload } = useLoad(() => api.get<any[]>('/checklists/templates'));
  const [editing, setEditing] = useState<any | null>(null);
  return (
    <Card
      title="Plantillas de checklist"
      actions={
        <IconButton icon="plus" className="btn btn-primary btn-sm" onClick={() => setEditing({ kind: 'onboarding', name: '', companyId: null, active: true, items: [] })}>
          Nueva plantilla
        </IconButton>
      }
    >
      <p className="muted">
        Al dar de alta, dar de baja o traspasar a alguien se crea automáticamente el checklist de su sociedad (o el general), con tareas para RR. HH., el
        responsable o la propia persona. La fecha de cada tarea se calcula desde la fecha del alta, baja o traspaso.
      </p>
      <ErrorBox error={error} />
      {data?.length ? (
        <table>
          <thead>
            <tr>
              <th>Tipo</th>
              <th>Nombre</th>
              <th>Sociedad</th>
              <th className="num">Tareas</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data.map((t) => (
              <tr key={t.id} style={{ opacity: t.active ? 1 : 0.5 }}>
                <td>{CHECKLIST_KIND[t.kind]}</td>
                <td>{t.name}</td>
                <td>{t.company_name ?? 'Todas'}</td>
                <td className="num">{t.items.length}</td>
                <td className="num">
                  <button
                    className="btn btn-sm"
                    onClick={() =>
                      setEditing({
                        id: t.id,
                        kind: t.kind,
                        name: t.name,
                        companyId: t.company_id,
                        active: t.active,
                        items: t.items.map((i: any) => ({ title: i.title, description: i.description ?? '', assignee: i.assignee, dueOffsetDays: i.due_offset_days })),
                      })
                    }
                  >
                    Editar
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>Sin plantillas.</Empty>
      )}
      {editing && <TemplateModal initial={editing} onClose={() => setEditing(null)} onDone={reload} />}
    </Card>
  );
}

function TemplateModal({ initial, onClose, onDone }: { initial: any; onClose: () => void; onDone: () => Promise<void> }) {
  const companies = useLoad(() => api.get<any[]>('/org/companies'));
  const [t, setT] = useState(initial);
  const { busy, error, run } = useAction();
  const setItem = (i: number, patch: any) => setT({ ...t, items: t.items.map((x: any, j: number) => (j === i ? { ...x, ...patch } : x)) });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const body = {
        companyId: t.companyId || null,
        kind: t.kind,
        name: t.name,
        active: t.active,
        items: t.items.map((i: any) => ({ ...i, description: i.description || undefined, dueOffsetDays: Number(i.dueOffsetDays) || 0 })),
      };
      if (t.id) await api.put(`/checklists/templates/${t.id}`, body);
      else await api.post('/checklists/templates', body);
      await onDone();
      onClose();
    });
  };
  return (
    <Modal title={t.id ? 'Editar plantilla' : 'Nueva plantilla'} onClose={onClose}>
      <form onSubmit={submit}>
        <ErrorBox error={error} />
        <div className="form-grid">
          <Field label="Tipo">
            <select value={t.kind} onChange={(e) => setT({ ...t, kind: e.target.value })}>
              {Object.entries(CHECKLIST_KIND).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Sociedad">
            <select value={t.companyId ?? ''} onChange={(e) => setT({ ...t, companyId: e.target.value || null })}>
              <option value="">Todas</option>
              {companies.data?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Nombre">
          <input required value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} placeholder="Bienvenida a la empresa" />
        </Field>
        <label className="check">
          <input type="checkbox" checked={t.active} onChange={(e) => setT({ ...t, active: e.target.checked })} /> Activa
        </label>
        <h3>Tareas</h3>
        {t.items.map((it: any, i: number) => (
          <div key={i} className="template-item">
            <input aria-label="Tarea" required value={it.title} onChange={(e) => setItem(i, { title: e.target.value })} placeholder="Entregar el portátil" />
            <select aria-label="Responsable de la tarea" value={it.assignee} onChange={(e) => setItem(i, { assignee: e.target.value })}>
              {Object.entries(ASSIGNEE).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
            <input aria-label="Días respecto a la fecha" type="number" value={it.dueOffsetDays} onChange={(e) => setItem(i, { dueOffsetDays: e.target.value })} title="Días respecto a la fecha (negativo = antes)" />
            <IconButton icon="close" className="btn-icon" aria-label="Quitar tarea" onClick={() => setT({ ...t, items: t.items.filter((_: any, j: number) => j !== i) })} />
          </div>
        ))}
        <button type="button" className="btn btn-sm" onClick={() => setT({ ...t, items: [...t.items, { title: '', assignee: 'hr', dueOffsetDays: 0, description: '' }] })}>
          Añadir tarea
        </button>
        <p className="muted small">El número es el día de la tarea respecto a la fecha del alta, baja o traspaso (negativo = antes).</p>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-primary" disabled={busy || !t.items.length}>
            Guardar
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Organización → campos personalizados. */
export function CustomFieldsAdmin({ isAdmin }: { isAdmin: boolean }) {
  const { data, error, reload } = useLoad(() => api.get<any[]>('/org/custom-fields'));
  const [editing, setEditing] = useState<any | null>(null);
  return (
    <Card
      title="Campos personalizados"
      actions={
        isAdmin && (
          <IconButton
            icon="plus"
            className="btn btn-primary btn-sm"
            onClick={() => setEditing({ entity: 'person', key: '', label: '', type: 'text', options: [], required: false, visibility: 'hr', position: 0, active: true })}
          >
            Nuevo campo
          </IconButton>
        )
      }
    >
      <p className="muted">Datos propios de vuestra organización (talla de uniforme, matrícula, coste por hora…). Elige quién puede verlos.</p>
      <ErrorBox error={error} />
      {data?.length ? (
        <table>
          <thead>
            <tr>
              <th>Campo</th>
              <th>De</th>
              <th>Tipo</th>
              <th>Visible para</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data.map((f) => (
              <tr key={f.id} style={{ opacity: f.active ? 1 : 0.5 }}>
                <td>
                  {f.label} <span className="mono muted">{f.key}</span> {f.required && <Badge>Obligatorio</Badge>}
                </td>
                <td>{f.entity === 'person' ? 'Persona' : 'Relación laboral'}</td>
                <td>{FIELD_TYPE[f.type]}</td>
                <td>{VISIBILITY[f.visibility]}</td>
                <td className="num">
                  {isAdmin && (
                    <button className="btn btn-sm" onClick={() => setEditing({ ...f })}>
                      Editar
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>Sin campos personalizados.</Empty>
      )}
      {editing && <FieldModal initial={editing} onClose={() => setEditing(null)} onDone={reload} />}
    </Card>
  );
}

function FieldModal({ initial, onClose, onDone }: { initial: any; onClose: () => void; onDone: () => Promise<void> }) {
  const [f, setF] = useState({ ...initial, optionsText: (initial.options ?? []).join('\n') });
  const { busy, error, run } = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const body = {
        entity: f.entity,
        key: f.key,
        label: f.label,
        type: f.type,
        options: f.type === 'select' ? f.optionsText.split('\n').map((s: string) => s.trim()).filter(Boolean) : [],
        required: f.required,
        visibility: f.visibility,
        position: Number(f.position) || 0,
        active: f.active,
      };
      if (f.id) await api.patch(`/org/custom-fields/${f.id}`, body);
      else await api.post('/org/custom-fields', body);
      await onDone();
      onClose();
    });
  };
  return (
    <Modal title={f.id ? 'Editar campo' : 'Nuevo campo'} onClose={onClose}>
      <form onSubmit={submit}>
        <ErrorBox error={error} />
        <div className="form-grid">
          <Field label="Nombre visible">
            <input required value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder="Talla de uniforme" />
          </Field>
          <Field label="Clave" hint="Minúsculas y guiones bajos. No se puede cambiar.">
            <input required pattern="[a-z][a-z0-9_]{1,40}" disabled={Boolean(f.id)} value={f.key} onChange={(e) => setF({ ...f, key: e.target.value })} placeholder="talla_uniforme" />
          </Field>
          <Field label="Pertenece a">
            <select disabled={Boolean(f.id)} value={f.entity} onChange={(e) => setF({ ...f, entity: e.target.value })}>
              <option value="person">La persona (igual en todas sus sociedades)</option>
              <option value="employment">La relación laboral (por sociedad)</option>
            </select>
          </Field>
          <Field label="Tipo">
            <select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
              {Object.entries(FIELD_TYPE).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Visible para">
            <select value={f.visibility} onChange={(e) => setF({ ...f, visibility: e.target.value })}>
              {Object.entries(VISIBILITY).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Orden">
            <input type="number" value={f.position} onChange={(e) => setF({ ...f, position: e.target.value })} />
          </Field>
        </div>
        {f.type === 'select' && (
          <Field label="Opciones (una por línea)">
            <textarea value={f.optionsText} onChange={(e) => setF({ ...f, optionsText: e.target.value })} />
          </Field>
        )}
        <label className="check">
          <input type="checkbox" checked={f.required} onChange={(e) => setF({ ...f, required: e.target.checked })} /> Obligatorio
        </label>
        <label className="check">
          <input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Activo
        </label>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-primary" disabled={busy}>
            Guardar
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Página «Tareas»: lo que me toca de los checklists abiertos. */
export function MyTasks() {
  const { data, error, reload } = useLoad(() => api.get<any[]>('/checklists/tasks'));
  const groups = new Map<string, any[]>();
  for (const t of data ?? []) groups.set(t.checklist_id, [...(groups.get(t.checklist_id) ?? []), t]);
  return (
    <>
      <ErrorBox error={error} />
      {groups.size ? (
        <div className="stack">
          {[...groups.values()].map((tasks) => (
            <Card key={tasks[0].checklist_id} title={`${CHECKLIST_KIND[tasks[0].kind]}: ${tasks[0].person_name}`}>
              <p className="muted small">
                {tasks[0].checklist_name} · {tasks[0].company_name}
              </p>
              <ul className="list">
                {tasks.map((t) => (
                  <TaskRow key={t.id} task={t} canToggle onChange={reload} />
                ))}
              </ul>
            </Card>
          ))}
        </div>
      ) : (
        <Empty>No tienes tareas pendientes.</Empty>
      )}
    </>
  );
}
