'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Badge, Card, Empty, ErrorBox, PageHeader, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import { timeIn } from '@/lib/format';

const STATE: Record<string, { label: string; tone: any }> = {
  working: { label: 'Trabajando', tone: 'success' },
  break: { label: 'En pausa', tone: 'warning' },
  out: { label: 'Fuera', tone: 'neutral' },
};

export default function TeamPage() {
  const [q, setQ] = useState('');
  const [inactive, setInactive] = useState(false);
  const now = useLoad(() => api.get<any[]>('/time/team'));
  const people = useLoad(() => api.get<any[]>(`/org/employees?q=${encodeURIComponent(q)}&includeInactive=${inactive}`), [q, inactive]);
  const stateOf = new Map((now.data ?? []).map((s) => [s.employmentId, s]));
  const working = (now.data ?? []).filter((s) => s.state !== 'out').length;

  return (
    <>
      <PageHeader title="Equipo" subtitle={now.data ? `${working} de ${now.data.length} personas trabajando ahora mismo` : undefined} />
      <Card
        title="Personas"
        actions={
          <div className="row">
            <input type="search" aria-label="Buscar personas" placeholder="Buscar por nombre, DNI o email" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 260 }} />
            <label className="check" style={{ margin: 0 }}>
              <input type="checkbox" checked={inactive} onChange={(e) => setInactive(e.target.checked)} /> Incluir bajas
            </label>
          </div>
        }
      >
        <ErrorBox error={people.error || now.error} />
        {people.data?.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Nombre</th>
                  <th>Sociedad</th>
                  <th>Puesto</th>
                  <th>Responsable</th>
                  <th>Ahora</th>
                </tr>
              </thead>
              <tbody>
                {people.data.map((p) => {
                  const s = stateOf.get(p.id);
                  return (
                    <tr key={p.id}>
                      <td>
                        <Link href={`/equipo/${p.id}`}>
                          {p.last_name}, {p.first_name}
                        </Link>
                        {p.end_date && <div className="small muted">Baja: {p.end_date}</div>}
                      </td>
                      <td>
                        {p.company_name}
                        {p.work_center_name && <div className="small muted">{p.work_center_name}</div>}
                      </td>
                      <td>{p.job_title ?? '—'}</td>
                      <td>{p.manager_name ?? '—'}</td>
                      <td>
                        {s ? (
                          <>
                            <Badge tone={STATE[s.state].tone}>{STATE[s.state].label}</Badge>
                            {s.since && <span className="small muted"> desde {timeIn(s.since)}</span>}
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No hay personas que mostrar.</Empty>
        )}
      </Card>
    </>
  );
}
