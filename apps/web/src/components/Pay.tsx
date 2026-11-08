'use client';

import { FormEvent, Fragment, useState } from 'react';
import { api, download } from '@/lib/api';
import { dayLabel, todayIso } from '@/lib/format';
import { IconButton } from './icons';
import { Badge, Card, Empty, ErrorBox, Field, Notice, useAction, useLoad } from './ui';

const eur = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n);
const pct = (n: number | null) => (n === null ? '—' : `${n.toLocaleString('es-ES', { maximumFractionDigits: 1 })} %`);

/** Retribución de una relación laboral (solo RR. HH.). */
export function CompensationCard({ employmentId }: { employmentId: string }) {
  const { data, error, reload } = useLoad(() => api.get<any[]>(`/pay/compensation/${employmentId}`), [employmentId]);
  const [f, setF] = useState({ effectiveFrom: todayIso(), baseAnnual: '', complementsAnnual: '', extraSalaryAnnual: '', note: '' });
  const action = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void action.run(async () => {
      await api.post('/pay/compensation', {
        employmentId,
        effectiveFrom: f.effectiveFrom,
        baseAnnual: Number(f.baseAnnual),
        complementsAnnual: Number(f.complementsAnnual || 0),
        extraSalaryAnnual: Number(f.extraSalaryAnnual || 0),
        note: f.note || undefined,
      });
      setF({ ...f, baseAnnual: '', complementsAnnual: '', extraSalaryAnnual: '', note: '' });
      await reload();
    });
  };
  return (
    <div className="stack">
      <Card title="Retribución anual">
        <p className="muted">Importes brutos anuales a la jornada real de la persona. Solo los ve RR. HH. y se usan para el registro retributivo.</p>
        <ErrorBox error={error || action.error} />
        {data?.length ? (
          <table>
            <thead>
              <tr>
                <th>Desde</th>
                <th className="num">Salario base</th>
                <th className="num">Complementos</th>
                <th className="num">Extrasalarial</th>
                <th className="num">Total</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.map((c) => (
                <tr key={c.id}>
                  <td>
                    {dayLabel(c.effective_from)} {c.effective_from.slice(0, 4)}
                    {c.note && <div className="small muted">{c.note}</div>}
                  </td>
                  <td className="num">{eur(c.base_annual)}</td>
                  <td className="num">{eur(c.complements_annual)}</td>
                  <td className="num">{eur(c.extra_salary_annual)}</td>
                  <td className="num">
                    <strong>{eur(c.base_annual + c.complements_annual + c.extra_salary_annual)}</strong>
                  </td>
                  <td className="num">
                    <button
                      className="btn btn-sm btn-ghost"
                      disabled={action.busy}
                      onClick={() => confirm('¿Eliminar este registro?') && action.run(async () => (await api.del(`/pay/compensation/${c.id}`), reload()))}
                    >
                      Eliminar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>Sin retribución registrada.</Empty>
        )}
      </Card>
      <Card title="Registrar cambio de retribución">
        <form onSubmit={submit}>
          <div className="form-grid">
            <Field label="Vigente desde">
              <input type="date" required value={f.effectiveFrom} onChange={(e) => setF({ ...f, effectiveFrom: e.target.value })} />
            </Field>
            <Field label="Salario base anual (€)">
              <input type="number" min={0} step="0.01" required value={f.baseAnnual} onChange={(e) => setF({ ...f, baseAnnual: e.target.value })} />
            </Field>
            <Field label="Complementos salariales (€)">
              <input type="number" min={0} step="0.01" value={f.complementsAnnual} onChange={(e) => setF({ ...f, complementsAnnual: e.target.value })} />
            </Field>
            <Field label="Percepciones extrasalariales (€)">
              <input type="number" min={0} step="0.01" value={f.extraSalaryAnnual} onChange={(e) => setF({ ...f, extraSalaryAnnual: e.target.value })} />
            </Field>
          </div>
          <Field label="Nota (opcional)">
            <input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="Revisión salarial anual" />
          </Field>
          <button className="btn btn-primary" disabled={action.busy}>
            Guardar
          </button>
        </form>
      </Card>
    </div>
  );
}

const CONCEPTS: [string, string][] = [
  ['base', 'Salario base'],
  ['complements', 'Complementos salariales'],
  ['extraSalary', 'Percepciones extrasalariales'],
  ['total', 'Total'],
];

/** Informes → registro retributivo. */
export function PayRegisterCard({ companyId }: { companyId: string }) {
  const [year, setYear] = useState(Number(todayIso().slice(0, 4)));
  const [groupBy, setGroupBy] = useState<'professional_group' | 'job_title'>('professional_group');
  const q = `companyId=${companyId}&year=${year}&groupBy=${groupBy}`;
  const { data, error } = useLoad(() => (companyId ? api.get(`/pay/register?${q}`) : Promise.resolve(null)), [q]);
  const action = useAction();
  return (
    <Card
      title="Registro retributivo"
      actions={
        <div className="row">
          <input aria-label="Año" type="number" min={2000} max={2100} value={year} onChange={(e) => setYear(Number(e.target.value))} style={{ width: 90 }} />
          <select aria-label="Agrupar por" value={groupBy} onChange={(e) => setGroupBy(e.target.value as any)} style={{ width: 'auto' }}>
            <option value="professional_group">Por grupo profesional</option>
            <option value="job_title">Por puesto</option>
          </select>
          <IconButton icon="download" className="btn btn-sm" disabled={action.busy || !companyId} onClick={() => action.run(() => download(`/pay/register.csv?${q}`))}>
            CSV
          </IconButton>
        </div>
      }
    >
      <p className="muted">
        Medias y medianas de las retribuciones por sexo (art. 28.2 ET y RD 902/2020), anualizadas y equiparadas a jornada completa. Las brechas de al
        menos el 25 % se marcan: en empresas de 50 o más personas hay que justificarlas.
      </p>
      <ErrorBox error={error || action.error} />
      {data && (
        <>
          {data.withoutCompensation > 0 && <Notice tone="warning">{data.withoutCompensation} persona(s) no tienen retribución registrada y no aparecen.</Notice>}
          {data.fiftyOrMore && <Notice>La sociedad tiene 50 o más personas: además del registro, necesita auditoría retributiva en su plan de igualdad.</Notice>}
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Grupo</th>
                  <th>Concepto</th>
                  <th className="num">Mujeres (n)</th>
                  <th className="num">Media</th>
                  <th className="num">Mediana</th>
                  <th className="num">Hombres (n)</th>
                  <th className="num">Media</th>
                  <th className="num">Mediana</th>
                </tr>
              </thead>
              <tbody>
                {[...data.groups, data.overall].map((g: any) => (
                  <Fragment key={g.group}>
                    {CONCEPTS.map(([c, label], i) => (
                      <tr key={c} className={c === 'total' ? 'total-row' : ''}>
                        <td>
                          {i === 0 && (
                            <>
                              <strong>{g.group}</strong>
                              {g.flagged && (
                                <div>
                                  <Badge tone="danger">Brecha ≥ 25 %</Badge>
                                </div>
                              )}
                              <div className="small muted">
                                Brecha: media {pct(g.gapMeanPct)} · mediana {pct(g.gapMedianPct)}
                              </div>
                            </>
                          )}
                        </td>
                        <td>{label}</td>
                        <td className="num">{g.women[c].n}</td>
                        <td className="num">{eur(g.women[c].mean)}</td>
                        <td className="num">{eur(g.women[c].median)}</td>
                        <td className="num">{g.men[c].n}</td>
                        <td className="num">{eur(g.men[c].mean)}</td>
                        <td className="num">{eur(g.men[c].median)}</td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small">
            {data.people} persona(s) incluidas. Jornada completa de referencia: {data.fullTimeWeeklyMinutes / 60} h/semana. Las personas sin sexo
            registrado o con «otro» no entran en la comparación por sexo.
          </p>
        </>
      )}
    </Card>
  );
}
