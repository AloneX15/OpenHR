'use client';

import { FormEvent, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { Badge, Card, Empty, ErrorBox, Field, Notice, useAction, useLoad } from './ui';

const STATUS: Record<string, { label: string; tone: any }> = {
  running: { label: 'En curso', tone: 'info' },
  done: { label: 'Terminada', tone: 'success' },
  failed: { label: 'Con error', tone: 'danger' },
};

/** Organización → migración desde Factorial (solo administración). */
export function FactorialMigration() {
  const jobs = useLoad(() => api.get<any[]>('/migration/jobs'));
  const [f, setF] = useState({ apiKey: '', environment: 'production', shiftsFrom: '', includeLeaves: true, includeSalaries: false });
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<any | null>(null);
  const action = useAction();

  useEffect(() => {
    if (!jobId) return;
    let alive = true;
    const tick = async () => {
      const j = await api.get(`/migration/jobs/${jobId}`).catch(() => null);
      if (!alive || !j) return;
      setJob(j);
      if (j.status === 'running') setTimeout(tick, 1500);
      else void jobs.reload();
    };
    void tick();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  const launch = (dryRun: boolean) => (e?: FormEvent) => {
    e?.preventDefault();
    if (!dryRun && !confirm('Se crearán sociedades, centros, personas y, si lo marcas, ausencias y fichajes. Se puede repetir sin duplicar. ¿Continuar?')) return;
    void action.run(async () => {
      setJob(null);
      const r = await api.post('/migration/factorial', { ...f, shiftsFrom: f.shiftsFrom || undefined, dryRun });
      setJobId(r.jobId);
    });
  };

  return (
    <div className="grid grid-2">
      <Card title="Migrar desde Factorial">
        <p className="muted">
          Trae sociedades, centros, equipos, personas (con su responsable, puesto y jornada), ausencias aprobadas y, si quieres, fichajes y salarios, usando
          la API de Factorial. Empieza con una simulación. Puedes repetirla: no duplica nada y actualiza bajas y puestos.
        </p>
        <Notice>
          Crea la clave en Factorial (con una cuenta de administración: Ajustes → Claves de API) y bórrala al terminar. OpenHR no la guarda.
        </Notice>
        <ErrorBox error={action.error} />
        <form onSubmit={launch(true)}>
          <Field label="Clave de API de Factorial">
            <input type="password" required autoComplete="off" value={f.apiKey} onChange={(e) => setF({ ...f, apiKey: e.target.value })} />
          </Field>
          <div className="form-grid">
            <Field label="Entorno">
              <select value={f.environment} onChange={(e) => setF({ ...f, environment: e.target.value })}>
                <option value="production">Producción</option>
                <option value="demo">Demo de Factorial</option>
              </select>
            </Field>
            <Field label="Fichajes desde (opcional)" hint="Vacío: no se importan fichajes.">
              <input type="date" value={f.shiftsFrom} onChange={(e) => setF({ ...f, shiftsFrom: e.target.value })} />
            </Field>
          </div>
          <label className="check">
            <input type="checkbox" checked={f.includeLeaves} onChange={(e) => setF({ ...f, includeLeaves: e.target.checked })} /> Ausencias aprobadas
          </label>
          <label className="check">
            <input type="checkbox" checked={f.includeSalaries} onChange={(e) => setF({ ...f, includeSalaries: e.target.checked })} /> Salarios de los contratos (para el registro retributivo)
          </label>
          <div className="row">
            <button className="btn" disabled={action.busy || job?.status === 'running'}>
              1. Simular
            </button>
            <button type="button" className="btn btn-primary" disabled={action.busy || job?.status === 'running' || !f.apiKey} onClick={() => launch(false)()}>
              2. Migrar
            </button>
          </div>
        </form>
      </Card>
      <Card title="Resultado">
        {job ? (
          <>
            <p>
              {job.dry_run ? 'Simulación' : 'Migración'} <Badge tone={STATUS[job.status].tone}>{STATUS[job.status].label}</Badge>
            </p>
            {job.error && <ErrorBox error={job.error} />}
            <ul className="list small">
              {Object.entries(job.counts ?? {}).map(([k, v]) => (
                <li key={k} className="spread">
                  <span>{k}</span>
                  <strong>{String(v)}</strong>
                </li>
              ))}
            </ul>
            <pre className="small log">{(job.log ?? []).join('\n')}</pre>
          </>
        ) : jobs.data?.length ? (
          <ul className="list small">
            {jobs.data.map((j) => (
              <li key={j.id}>
                <button className="btn btn-ghost btn-sm" onClick={() => setJobId(j.id)}>
                  {dateTime(j.started_at)} · {j.dry_run ? 'simulación' : 'migración'}
                </button>{' '}
                <Badge tone={STATUS[j.status].tone}>{STATUS[j.status].label}</Badge>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>Aún no has lanzado ninguna migración.</Empty>
        )}
      </Card>
    </div>
  );
}
