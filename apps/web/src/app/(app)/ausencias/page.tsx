'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Badge, Card, Collapse, Empty, EmptyState, ErrorBox, Notice, PageHeader, Select, Stepper, Tabs, useAction, useLoad } from '@/components/ui';
import { absenceTone, EventRow } from '@/components/Events';
import { IconButton } from '@/components/icons';
import { BalanceBar, YearCalendar } from '@/components/YearCalendar';
import { api } from '@/lib/api';
import { addDays, dayLabel, monthBounds, STATUS_LABEL, todayIso } from '@/lib/format';
import { useSession } from '@/lib/session';
import { ApprovalSteps, Delegations } from '@/components/Approvals';
import { RequestModal } from '@/components/RequestModal';

type Tab = 'mias' | 'aprobar' | 'equipo' | 'delegaciones';
const STATUS_TONE: Record<string, any> = { pending: 'warning', approved: 'success', rejected: 'danger', cancelled: 'neutral' };

function AbsencesContent() {
  const { me } = useSession();
  const canApprove = me.isManager || me.isHr;
  const initial = (useSearchParams().get('tab') as Tab) || 'mias';
  const [tab, setTab] = useState<Tab>(canApprove ? initial : 'mias');
  const tabs: { id: Tab; label: string }[] = [{ id: 'mias', label: 'Mis ausencias' }];
  if (canApprove)
    tabs.push({ id: 'aprobar', label: 'Por aprobar' }, { id: 'equipo', label: 'Calendario del equipo' }, { id: 'delegaciones', label: 'Delegaciones' });

  return (
    <>
      <PageHeader title="Ausencias" subtitle="Vacaciones, permisos y bajas." />
      <Tabs value={tab} onChange={setTab} tabs={tabs} />
      {tab === 'mias' && <MyAbsences />}
      {tab === 'aprobar' && <Approvals />}
      {tab === 'equipo' && <TeamCalendar />}
      {tab === 'delegaciones' && <Delegations />}
    </>
  );
}

function rangeLabel(r: { start_date: string; end_date: string; days: string | number }) {
  const span = r.end_date === r.start_date ? dayLabel(r.start_date) : `${dayLabel(r.start_date)} → ${dayLabel(r.end_date)}`;
  return `${span} · ${Number(r.days)} día(s)`;
}

function MyAbsences() {
  const { me } = useSession();
  const today = todayIso();
  const thisYear = Number(today.slice(0, 4));
  const [year, setYear] = useState(thisYear);
  const [employmentId, setEmploymentId] = useState(me.employments[0]?.id ?? '');
  const mine = useLoad(() => api.get<any[]>('/absences/mine'));
  const balance = useLoad(() => (employmentId ? api.get(`/absences/balance/${employmentId}?year=${year}`) : Promise.resolve(null)), [employmentId, year]);
  const holidays = useLoad(() => api.get<any[]>(`/org/holidays?year=${year}`).catch(() => []), [year]);
  // Fecha con la que se abre la solicitud (null = cerrada).
  const [creating, setCreating] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [showPast, setShowPast] = useState(false);
  const action = useAction();

  if (!me.employments.length) return <EmptyState icon="vacation" title="Sin relación laboral activa">Cuando RR. HH. te dé de alta en una sociedad podrás pedir ausencias aquí.</EmptyState>;
  const reloadAll = () => Promise.all([mine.reload(), balance.reload()]);
  const companyId = me.employments.find((e) => e.id === employmentId)?.company_id;
  const myHolidays = (holidays.data ?? []).filter((h) => !h.company_id || h.company_id === companyId);
  const all = mine.data ?? [];
  const live = (r: any) => r.status === 'approved' || r.status === 'pending';
  const upcoming = all.filter((r) => r.end_date >= today && live(r)).sort((a, b) => a.start_date.localeCompare(b.start_date));
  const past = all.filter((r) => !(r.end_date >= today && live(r)));
  const types = Array.from(new Set(all.filter((r) => live(r) && r.start_date.slice(0, 4) <= String(year) && r.end_date.slice(0, 4) >= String(year)).map((r) => r.type_name as string)));
  const b = balance.data;

  const row = (r: any) => (
    <EventRow
      key={r.id}
      date={r.start_date}
      tone={absenceTone(r.type_name)}
      pending={r.status === 'pending'}
      title={r.type_name}
      detail={
        <>
          {rangeLabel(r)}
          {me.employments.length > 1 && ` · ${r.company_name}`}
          {r.decision_comment && ` · «${r.decision_comment}»`}
          {r.status === 'pending' && <ApprovalSteps steps={r.steps} />}
        </>
      }
      action={
        <>
          <Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge>
          {(r.status === 'pending' || (r.status === 'approved' && r.start_date > today)) && (
            <button className="btn btn-sm btn-danger" disabled={action.busy} onClick={() => confirm('¿Anular esta solicitud?') && action.run(async () => (await api.post(`/absences/${r.id}/cancel`), reloadAll()))}>
              Anular
            </button>
          )}
        </>
      }
    />
  );

  return (
    <div className="stack">
      <div className="spread">
        {me.employments.length > 1 ? (
          <Select label="Sociedad" icon="organization" value={employmentId} onChange={setEmploymentId} options={me.employments.map((e) => ({ value: e.id, label: e.company_name, hint: e.job_title ?? undefined }))} />
        ) : (
          <span className="muted">Pulsa un día del calendario para pedirlo, o usa el botón.</span>
        )}
        <IconButton icon="plus" className="btn btn-primary" onClick={() => setCreating(addDays(today, 1))}>
          Solicitar ausencia
        </IconButton>
      </div>
      {sent && <Notice tone="success">{sent}</Notice>}
      <ErrorBox error={mine.error || action.error} />

      <div className="split split-aside-first">
        <div className="stack">
          <Card title={`Vacaciones ${year}`}>
            {b ? (
              <>
                <div className="stat-row" style={{ marginBottom: 12 }}>
                  <div className="stat">
                    <span className="stat-value">{b.available}</span>
                    <span className="stat-label">disponibles</span>
                  </div>
                  <div className="stat">
                    <span className="stat-value">{b.approved}</span>
                    <span className="stat-label">aprobadas</span>
                  </div>
                  <div className="stat">
                    <span className="stat-value">{b.pending}</span>
                    <span className="stat-label">pendientes</span>
                  </div>
                </div>
                <BalanceBar used={Number(b.approved)} held={Number(b.pending)} available={Number(b.available)} />
                <p className="muted small" style={{ margin: '10px 0 0' }}>
                  Te corresponden {b.entitled} días laborables en {year}
                  {Number(b.adjustments) ? `, más ${b.adjustments} de ajustes` : ''}.
                </p>
              </>
            ) : (
              <p className="muted">Cargando…</p>
            )}
          </Card>

          <Card title="Próximas ausencias">
            {upcoming.length ? (
              <div className="stack" style={{ gap: 8 }}>
                {upcoming.map(row)}
              </div>
            ) : (
              <EmptyState icon="calendarPlus" title="Nada previsto">
                Todavía no tienes ausencias por delante.
              </EmptyState>
            )}
          </Card>

          {past.length > 0 && (
            <Card
              title="Anteriores"
              actions={
                past.length > 3 && (
                  <button className="btn btn-ghost btn-sm" aria-expanded={showPast} onClick={() => setShowPast(!showPast)}>
                    {showPast ? 'Ver menos' : `Ver ${past.length - 3} más`}
                  </button>
                )
              }
            >
              <div className="stack" style={{ gap: 8 }}>
                {past.slice(0, 3).map(row)}
              </div>
              <Collapse open={showPast}>
                <div className="stack" style={{ gap: 8, paddingTop: 8 }}>
                  {past.slice(3).map(row)}
                </div>
              </Collapse>
            </Card>
          )}
        </div>

        <Card title="Mi año" actions={<Stepper label={year} onPrev={() => setYear(year - 1)} onNext={() => setYear(year + 1)} prevLabel="Año anterior" nextLabel="Año siguiente" />}>
          <div className="legend" style={{ marginBottom: 18 }}>
            {types.map((t) => (
              <span key={t} className={`badge badge-dot tone-${absenceTone(t)}`}>
                {t}
              </span>
            ))}
            <span className="badge badge-dot tone-rose" style={{ ['--c' as any]: 'var(--danger)' }}>
              Festivo
            </span>
            <span className="badge">Con borde: pendiente de aprobar</span>
          </div>
          <YearCalendar year={year} absences={all} holidays={myHolidays} onPickDay={(d) => setCreating(d)} />
        </Card>
      </div>

      {creating && (
        <RequestModal
          employmentId={employmentId}
          initialDate={creating}
          onClose={() => setCreating(null)}
          onDone={(message) => {
            setSent(message ?? null);
            void reloadAll();
          }}
        />
      )}
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
                  <td>
                    {r.type_name}
                    <ApprovalSteps steps={r.steps} />
                  </td>
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
    <Card title="Ausencias del equipo" actions={<input type="month" aria-label="Mes" value={period} onChange={(e) => e.target.value && setPeriod(e.target.value)} style={{ width: 'auto' }} />}>
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
