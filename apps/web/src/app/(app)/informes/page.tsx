'use client';

import { useState } from 'react';
import { Card, Empty, ErrorBox, Field, Notice, PageHeader, useAction, useLoad } from '@/components/ui';
import { api, download } from '@/lib/api';
import { dateTime, monthBounds, todayIso } from '@/lib/format';

export default function ReportsPage() {
  const companies = useLoad(() => api.get<any[]>('/org/companies'));
  const [companyId, setCompanyId] = useState('');
  const company = companyId || companies.data?.[0]?.id || '';
  const thisMonth = todayIso().slice(0, 7);
  const [range, setRange] = useState(monthBounds(thisMonth));
  const [period, setPeriod] = useState(thisMonth);
  const seals = useLoad(() => (company ? api.get<any[]>(`/time/seals?companyId=${company}`) : Promise.resolve([])), [company]);
  const action = useAction();
  const [sealed, setSealed] = useState<any | null>(null);

  return (
    <>
      <PageHeader
        title="Informes"
        subtitle="Exportaciones para la Inspección de Trabajo, la representación legal y la gestoría."
        actions={
          <select value={company} onChange={(e) => setCompanyId(e.target.value)}>
            {companies.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.tax_id})
              </option>
            ))}
          </select>
        }
      />
      <ErrorBox error={action.error || companies.error} />
      <div className="grid grid-2">
        <Card title="Registro de jornada">
          <p className="muted">
            Inicio y fin de cada jornada por persona y día, con pausas, jornada teórica y correcciones identificadas (art. 34.9 del Estatuto de los
            Trabajadores). Hay que conservarlo cuatro años.
          </p>
          <div className="form-grid">
            <Field label="Desde">
              <input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
            </Field>
            <Field label="Hasta">
              <input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
            </Field>
          </div>
          <button
            className="btn btn-primary"
            disabled={action.busy || !company}
            onClick={() => action.run(() => download(`/exports/time-register?companyId=${company}&from=${range.from}&to=${range.to}`))}
          >
            Descargar CSV
          </button>
        </Card>
        <Card title="Variables de nómina">
          <p className="muted">
            Por persona y mes: días de alta, horas teóricas y trabajadas, diferencia y días de cada tipo de ausencia. Es lo que necesita la gestoría
            para cerrar la nómina.
          </p>
          <Field label="Mes">
            <input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} />
          </Field>
          <button
            className="btn btn-primary"
            disabled={action.busy || !company}
            onClick={() => action.run(() => download(`/exports/payroll-variables?companyId=${company}&period=${period}`))}
          >
            Descargar CSV
          </button>
        </Card>
        <Card
          title="Sellos del registro de jornada"
          actions={
            <button
              className="btn btn-sm"
              disabled={action.busy || !company}
              onClick={() =>
                action.run(async () => {
                  setSealed(await api.post('/time/seal', { companyId: company }));
                  await seals.reload();
                })
              }
            >
              Sellar ahora
            </button>
          }
        >
          <p className="muted">
            Un sello es una huella de todos los fichajes hasta ese momento que se envía por email a RR. HH. Si alguien manipulara la base de datos, la
            huella dejaría de coincidir. Recomendado: sellar al cerrar cada mes.
          </p>
          {sealed && (
            <Notice tone="success">
              Sello enviado. Huella: <span className="mono">{sealed.digest}</span>
            </Notice>
          )}
          {seals.data?.length ? (
            <ul className="list small">
              {seals.data.map((s) => (
                <li key={s.id}>
                  {dateTime(s.sealed_at)} · <span className="mono">{s.digest.slice(0, 24)}…</span>
                  <div className="muted">Enviado a {s.sent_to?.join(', ') || 'nadie'}</div>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>Aún no hay sellos.</Empty>
          )}
        </Card>
      </div>
    </>
  );
}
