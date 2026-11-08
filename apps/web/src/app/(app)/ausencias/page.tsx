'use client';

import { useSearchParams } from 'next/navigation';
import { FormEvent, Suspense, useState } from 'react';
import { Badge, Card, Empty, ErrorBox, Field, Modal, PageHeader, Tabs, useAction, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import { addDays, dayLabel, monthBounds, STATUS_LABEL, todayIso } from '@/lib/format';
import { useSession } from '@/lib/session';
import { RequestModal } from '@/components/RequestModal';

type Tab = 'mias' | 'aprobar' | 'equipo';
const STATUS_TONE: Record<string, any> = { pending: 'warning', approved: 'success', rejected: 'danger', cancelled: 'neutral' };

function AbsencesContent() {
  const { me } = useSession();
  const canApprove = me.isManager || me.isHr;
  const initial = (useSearchParams().get('tab') as Tab) || 'mias';
  const [tab, setTab] = useState<Tab>(canApprove ? initial : 'mias');
  const tabs: { id: Tab; label: string }[] = [{ id: 'mias', label: 'Mis ausencias' }];
  if (canApprove) tabs.push({ id: 'aprobar', label: 'Por aprobar' }, { id: 'equipo', label: 'Calendario del equipo' });

  return (
    <>
      <PageHeader title="Ausencias" subtitle="Vacaciones, permisos y bajas." />
      <Tabs value={tab} onChange={setTab} tabs={tabs} />
      {tab === 'mias' && <MyAbsences />}
      {tab === 'aprobar' && <Approvals />}
      {tab === 'equipo' && <TeamCalendar />}
    </>
  );
}

function MyAbsences() {
  const { me } = useSession();
  const year = Number(todayIso().slice(0, 4));
  const [employmentId, setEmploymentId] = useState(me.employments[0]?.id ?? '');
  const mine = useLoad(() => api.get<any[]>('/absences/mine'));
  const balance = useLoad(() => (employmentId ? api.get(`/absences/balance/${employmentId}?year=${year}`) : Promise.resolve(null)), [employmentId]);
  const [creating, setCreating] = useState(false);
  const action = useAction();

  if (!me.employments.length) return <Empty>No tienes ninguna relación laboral activa.</Empty>;
  const reloadAll = () => Promise.all([mine.reload(), balance.reload()]);

  return (
    <div className="stack">
      <div className="grid grid-2">
        <Card title={`Vacaciones ${year}`}>
          {balance.data && (
            <>
              <div className="grid grid-3">
                <div className="stat">
                  <span className="stat-value">{balance.data.available}</span>
                  <span className="stat-label">disponibles</span>
                </div>
                <div className="stat">
                  <span className="stat-value">{balance.data.approved}</span>
                  <span className="stat-label">aprobadas</span>
                </div>
                <div className="stat">
                  <span className="stat-value">{balance.data.pending}</span>
                  <span className="stat-label">pendientes</span>
                </div>
              </div>
              <p className="muted small" style={{ marginTop: 10 }}>
                Te corresponden {balance.data.entitled} días laborables este año
                {balance.data.adjustments ? `, más ${balance.data.adjustments} de ajustes` : ''}.
              </p>
            </>
          )}
        </Card>
        <Card title="Nueva solicitud">
          <p className="muted">Pide vacaciones, un permiso o comunica una baja. Tu responsable recibirá un aviso.</p>
          <div className="row">
            {me.employments.length > 1 && (
              <select value={employmentId} onChange={(e) => setEmploymentId(e.target.value)} style={{ width: 'auto' }}>
                {me.employments.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.company_name}
                  </option>
                ))}
              </select>
            )}
            <button className="btn btn-primary" onClick={() => setCreating(true)}>
              Solicitar ausencia
            </button>
          </div>
        </Card>
      </div>
      <Card title="Mis solicitudes">
        <ErrorBox error={mine.error || action.error} />
        {mine.data?.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Tipo</th>
                  <th>Fechas</th>
                  <th className="num">Días</th>
                  <th>Estado</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {mine.data.map((r) => (
                  <tr key={r.id}>
                    <td>
                      {r.type_name}
                      {me.employments.length > 1 && <div className="small muted">{r.company_name}</div>}
                    </td>
                    <td>
                      {dayLabel(r.start_date)}
                      {r.end_date !== r.start_date && <> → {dayLabel(r.end_date)}</>}
                    </td>
                    <td className="num">{Number(r.days)}</td>
                    <td>
                      <Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge>
                      {r.decision_comment && <div className="small muted">«{r.decision_comment}»</div>}
                    </td>
                    <td className="num">
                      {(r.status === 'pending' || (r.status === 'approved' && r.start_date > todayIso())) && (
                        <button
                          className="btn btn-sm btn-danger"
                          disabled={action.busy}
                          onClick={() => confirm('¿Anular esta solicitud?') && action.run(async () => (await api.post(`/absences/${r.id}/cancel`), reloadAll()))}
                        >
                          Anular
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>Todavía no has pedido ninguna ausencia.</Empty>
        )}
      </Card>
      {creating && <RequestModal employmentId={employmentId} onClose={() => setCreating(false)} onDone={reloadAll} />}
    </div>
  );
}

function Approvals() {
  const { data, error, reload } = useLoad(() => api.get<any[]>('/absences/pending'));
  const action = useAction();
  const decide = (id: string, approve: boolean) =>
    action.run(async () => {
      const comment = approve ? undefined : prompt('Motivo del rechazo (opcional)') ?? undefined;
      await api.post(`/absences/${id}/${approve ? 'approve' : 'reject'}`, { comment });
      await reload();
    });
  return (
    <Card title="Solicitudes pendientes">
      <ErrorBox error={error || action.error} />
      {data?.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Persona</th>
                <th>Tipo</th>
                <th>Fechas</th>
                <th className="num">Días</th>
                <th>Comentario</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.id}>
                  <td>
                    {r.person_name}
                    <div className="small muted">{r.company_name}</div>
                  </td>
                  <td>{r.type_name}</td>
                  <td>
                    {dayLabel(r.start_date)} → {dayLabel(r.end_date)}
                  </td>
                  <td className="num">{Number(r.days)}</td>
                  <td className="small">{r.comment}</td>
                  <td>
                    <div className="row" style={{ justifyContent: 'flex-end' }}>
                      <button className="btn btn-sm btn-success" disabled={action.busy} onClick={() => decide(r.id, true)}>
                        Aprobar
                      </button>
                      <button className="btn btn-sm btn-danger" disabled={action.busy} onClick={() => decide(r.id, false)}>
                        Rechazar
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>No hay solicitudes pendientes.</Empty>
      )}
    </Card>
  );
}

function TeamCalendar() {
  const [period, setPeriod] = useState(todayIso().slice(0, 7));
  const { from, to } = monthBounds(period);
  const { data, error } = useLoad(() => api.get<any[]>(`/absences/team?from=${from}&to=${to}`), [from, to]);
  return (
    <Card title="Ausencias del equipo" actions={<input type="month" value={period} onChange={(e) => e.target.value && setPeriod(e.target.value)} style={{ width: 'auto' }} />}>
      <ErrorBox error={error} />
      {data?.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Persona</th>
                <th>Tipo</th>
                <th>Fechas</th>
                <th>Estado</th>
              </tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.id}>
                  <td>{r.person_name}</td>
                  <td>{r.type_name}</td>
                  <td>
                    {dayLabel(r.start_date)} → {dayLabel(r.end_date)}
                  </td>
                  <td>
                    <Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>Nadie del equipo tiene ausencias este mes.</Empty>
      )}
    </Card>
  );
}

export default function AbsencesPage() {
  return (
    <Suspense>
      <AbsencesContent />
    </Suspense>
  );
}
