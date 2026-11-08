'use client';

import { FormEvent, useState } from 'react';
import { IconButton } from '@/components/icons';
import { Badge, Card, Empty, ErrorBox, Field, Modal, Notice, PageHeader, useAction, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import { addDays, dayLabel, timeIn, todayIso, weekStart } from '@/lib/format';
import { useSession } from '@/lib/session';

interface Template {
  id: string;
  company_id: string;
  name: string;
  start_time: string;
  end_time: string;
  break_minutes: number;
  color: string;
  active: boolean;
}

const RULE_LABEL: Record<string, string> = {
  rest_between_shifts: 'Descanso entre jornadas',
  daily_max: 'Jornada máxima diaria',
  weekly_rest: 'Descanso semanal',
  overlap: 'Turnos solapados',
};

export default function ShiftsPage() {
  const { me } = useSession();
  const [monday, setMonday] = useState(weekStart(addDays(todayIso(), 7)));
  const sunday = addDays(monday, 6);
  const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  const plan = useLoad(() => api.get(`/shifts?from=${monday}&to=${sunday}`), [monday]);
  const templates = useLoad(() => api.get<Template[]>('/shifts/templates'));
  const action = useAction();
  const [managing, setManaging] = useState(false);
  const [published, setPublished] = useState<string | null>(null);

  const shiftOf = (employmentId: string, date: string) => plan.data?.shifts.find((s: any) => s.employment_id === employmentId && s.date === date);
  const violationsOf = (employmentId: string, date: string) =>
    (plan.data?.violations ?? []).filter((v: any) => v.employmentId === employmentId && (v.date === date || (v.rule === 'weekly_rest' && date === monday)));
  const drafts = (plan.data?.shifts ?? []).filter((s: any) => !s.published_at).length;

  const setCell = (employmentId: string, date: string, value: string) =>
    action.run(async () => {
      const item =
        value === '' ? { employmentId, date, clear: true } : value === 'off' ? { employmentId, date, dayOff: true } : { employmentId, date, templateId: value };
      await api.put('/shifts', { items: [item] });
      setPublished(null);
      await plan.reload();
    });

  const copyPreviousWeek = () =>
    action.run(async () => {
      const prev = await api.get(`/shifts?from=${addDays(monday, -7)}&to=${addDays(monday, -1)}`);
      const items = prev.shifts.map((s: any) => ({
        employmentId: s.employment_id,
        date: addDays(s.date, 7),
        ...(s.is_day_off ? { dayOff: true } : s.shift_template_id ? { templateId: s.shift_template_id } : { start: timeIn(s.start_at), end: timeIn(s.end_at), breakMinutes: s.break_minutes }),
      }));
      if (!items.length) throw new Error('La semana anterior no tiene turnos');
      await api.put('/shifts', { items });
      await plan.reload();
    });

  const publish = () =>
    action.run(async () => {
      const r = await api.post('/shifts/publish', { from: monday, to: sunday });
      setPublished(`Publicados ${r.published} turnos de ${r.people} persona(s). Les hemos avisado.`);
      await plan.reload();
    });

  const companyTemplates = (companyId: string) => (templates.data ?? []).filter((t) => t.company_id === companyId && t.active);

  return (
    <>
      <PageHeader
        title="Turnos"
        subtitle="Planifica la semana. Los cambios quedan en borrador hasta que publicas; entonces cada persona recibe un aviso."
        actions={
          <>
            {me.isHr && (
              <button className="btn" onClick={() => setManaging(true)}>
                Plantillas de turno
              </button>
            )}
            <button className="btn" disabled={action.busy} onClick={copyPreviousWeek}>
              Copiar semana anterior
            </button>
            <IconButton icon="check" className="btn btn-primary" disabled={action.busy || drafts === 0} onClick={publish}>
              Publicar {drafts > 0 ? `(${drafts})` : ''}
            </IconButton>
          </>
        }
      />
      <ErrorBox error={plan.error || templates.error || action.error} />
      {published && <Notice tone="success">{published}</Notice>}
      <Card
        title={`Semana del ${dayLabel(monday)} al ${dayLabel(sunday)}`}
        actions={
          <div className="row">
            <button className="btn btn-sm" onClick={() => setMonday(addDays(monday, -7))} aria-label="Semana anterior">
              ←
            </button>
            <button className="btn btn-sm" onClick={() => setMonday(weekStart(todayIso()))}>
              Esta semana
            </button>
            <button className="btn btn-sm" onClick={() => setMonday(addDays(monday, 7))} aria-label="Semana siguiente">
              →
            </button>
          </div>
        }
      >
        {plan.data?.violations?.length > 0 && (
          <Notice tone="warning">
            Hay {plan.data.violations.length} incumplimiento(s) de las reglas de descanso. Puedes publicar igualmente, pero revisa si vuestro convenio lo
            permite.
          </Notice>
        )}
        {!templates.data?.length && me.isHr && <Notice>Primero crea las plantillas de turno (mañana, tarde, noche…).</Notice>}
        {plan.data?.people?.length ? (
          <div className="table-wrap">
            <table className="planner">
              <thead>
                <tr>
                  <th>Persona</th>
                  {days.map((d) => (
                    <th key={d}>{dayLabel(d)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {plan.data.people.map((p: any) => (
                  <tr key={p.id}>
                    <td>
                      {p.last_name}, {p.first_name}
                      {p.job_title && <div className="small muted">{p.job_title}</div>}
                    </td>
                    {days.map((d) => {
                      const s = shiftOf(p.id, d);
                      const v = violationsOf(p.id, d);
                      const value = !s ? '' : s.is_day_off ? 'off' : (s.shift_template_id ?? 'custom');
                      return (
                        <td key={d} className={`shift-cell ${s && !s.published_at ? 'draft' : ''}`}>
                          <select
                            aria-label={`Turno de ${p.first_name} el ${dayLabel(d)}`}
                            value={value}
                            disabled={action.busy}
                            onChange={(e) => setCell(p.id, d, e.target.value)}
                            className={s?.color ? `shift-${s.color}` : s?.is_day_off ? 'shift-off' : ''}
                          >
                            <option value="">—</option>
                            <option value="off">Libre</option>
                            {companyTemplates(p.company_id).map((t) => (
                              <option key={t.id} value={t.id}>
                                {t.name} {t.start_time.slice(0, 5)}–{t.end_time.slice(0, 5)}
                              </option>
                            ))}
                            {value === 'custom' && <option value="custom">{`${timeIn(s.start_at)}–${timeIn(s.end_at)}`}</option>}
                          </select>
                          {s && !s.published_at && <span className="small muted">Borrador</span>}
                          {v.map((x: any) => (
                            <div key={x.rule} className="small text-danger" title={x.message}>
                              ⚠ {RULE_LABEL[x.rule]}
                            </div>
                          ))}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No tienes personas a tu cargo para planificar.</Empty>
        )}
        <p className="muted small" style={{ marginTop: 12 }}>
          Reglas comprobadas (Estatuto de los Trabajadores, ajustables por sociedad): 12 h de descanso entre jornadas, 9 h de trabajo efectivo al día y día
          y medio de descanso semanal (acumulable en 14 días). Sin turno asignado se aplica la jornada semanal de la persona.
        </p>
      </Card>
      {plan.data?.violations?.length > 0 && (
        <Card title="Incumplimientos">
          <ul className="list small">
            {plan.data.violations.map((v: any, i: number) => {
              const p = plan.data.people.find((x: any) => x.id === v.employmentId);
              return (
                <li key={i}>
                  <Badge tone="warning">{RULE_LABEL[v.rule]}</Badge> {p ? `${p.first_name} ${p.last_name}` : ''} · {dayLabel(v.date)}: {v.message}
                </li>
              );
            })}
          </ul>
        </Card>
      )}
      {managing && <TemplatesModal templates={templates.data ?? []} onClose={() => setManaging(false)} onDone={templates.reload} />}
    </>
  );
}

function TemplatesModal({ templates, onClose, onDone }: { templates: Template[]; onClose: () => void; onDone: () => Promise<void> }) {
  const companies = useLoad(() => api.get<any[]>('/org/companies'));
  const [f, setF] = useState({ companyId: '', name: '', start: '08:00', end: '16:00', breakMinutes: 30, color: 'sky' });
  const { busy, error, run } = useAction();
  const companyId = f.companyId || companies.data?.[0]?.id || '';
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api.post('/shifts/templates', { ...f, companyId });
      setF({ ...f, name: '' });
      await onDone();
    });
  };
  return (
    <Modal title="Plantillas de turno" onClose={onClose}>
      <ErrorBox error={error} />
      <ul className="list small">
        {templates.map((t) => (
          <li key={t.id} className="spread" style={{ opacity: t.active ? 1 : 0.5 }}>
            <span>
              <span className={`swatch shift-${t.color}`} /> <strong>{t.name}</strong> {t.start_time.slice(0, 5)}–{t.end_time.slice(0, 5)} · pausa {t.break_minutes} min
            </span>
            <button className="btn btn-sm" disabled={busy} onClick={() => run(async () => (await api.patch(`/shifts/templates/${t.id}`, { active: !t.active }), onDone()))}>
              {t.active ? 'Desactivar' : 'Activar'}
            </button>
          </li>
        ))}
      </ul>
      <form onSubmit={submit} style={{ marginTop: 12 }}>
        <h3>Nueva plantilla</h3>
        <div className="form-grid">
          <Field label="Sociedad">
            <select value={companyId} onChange={(e) => setF({ ...f, companyId: e.target.value })}>
              {companies.data?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Nombre">
            <input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Mañana" />
          </Field>
          <Field label="Entrada">
            <input type="time" required value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} />
          </Field>
          <Field label="Salida" hint="Si es anterior a la entrada, acaba al día siguiente.">
            <input type="time" required value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} />
          </Field>
          <Field label="Pausa (minutos)">
            <input type="number" min={0} max={240} value={f.breakMinutes} onChange={(e) => setF({ ...f, breakMinutes: Number(e.target.value) })} />
          </Field>
          <Field label="Color">
            <select value={f.color} onChange={(e) => setF({ ...f, color: e.target.value })}>
              {['sky', 'navy', 'teal', 'amber', 'violet', 'rose', 'slate'].map((c) => (
                <option key={c} value={c}>
                  {{ sky: 'Celeste', navy: 'Marino', teal: 'Verde azulado', amber: 'Ámbar', violet: 'Violeta', rose: 'Rosa', slate: 'Gris' }[c]}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cerrar
          </button>
          <button className="btn btn-primary" disabled={busy}>
            Crear plantilla
          </button>
        </div>
      </form>
    </Modal>
  );
}
