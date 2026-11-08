'use client';

import Link from 'next/link';
import { ClockWidget } from '@/components/ClockWidget';
import { Badge, Card, Empty, PageHeader, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import { dateTime, longDate, todayIso } from '@/lib/format';
import { useSession } from '@/lib/session';

export default function HomePage() {
  const { me } = useSession();
  const notes = useLoad(() => api.get<any[]>('/notifications'));
  const pending = useLoad(() => (me.isManager || me.isHr ? api.get<any[]>('/absences/pending') : Promise.resolve([])));
  const balance = useLoad(() =>
    me.employments[0] ? api.get(`/absences/balance/${me.employments[0].id}?year=${todayIso().slice(0, 4)}`) : Promise.resolve(null),
  );

  const markAll = async () => {
    await api.post('/notifications/read-all');
    await notes.reload();
  };
  const unread = notes.data?.filter((n) => !n.read_at).length ?? 0;

  return (
    <>
      <PageHeader title={`Hola, ${me.firstName ?? ''}`.trim()} subtitle={longDate(new Date())} />
      <div className="grid grid-2">
        <Card title="Fichaje">
          <ClockWidget me={me} />
        </Card>
        <div className="stack">
          {balance.data && (
            <Card title="Vacaciones" actions={<Link href="/ausencias">Solicitar</Link>}>
              <div className="grid grid-3">
                <div className="stat">
                  <span className="stat-value">{balance.data.available}</span>
                  <span className="stat-label">días disponibles</span>
                </div>
                <div className="stat">
                  <span className="stat-value">{balance.data.approved}</span>
                  <span className="stat-label">disfrutados o aprobados</span>
                </div>
                <div className="stat">
                  <span className="stat-value">{balance.data.pending}</span>
                  <span className="stat-label">pendientes de aprobar</span>
                </div>
              </div>
            </Card>
          )}
          {(me.isManager || me.isHr) && (
            <Card title="Pendiente de tu aprobación" actions={<Link href="/ausencias?tab=aprobar">Ver todo</Link>}>
              {pending.data?.length ? (
                <ul className="list">
                  {pending.data.slice(0, 5).map((p) => (
                    <li key={p.id} className="spread">
                      <span>
                        <strong>{p.person_name}</strong> · {p.type_name}
                        <br />
                        <span className="muted small">
                          {p.start_date} → {p.end_date} · {Number(p.days)} día(s)
                        </span>
                      </span>
                      <Badge tone="warning">Pendiente</Badge>
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty>No tienes nada pendiente.</Empty>
              )}
            </Card>
          )}
          <Card
            title={
              <>
                Notificaciones {unread > 0 && <Badge tone="info">{unread}</Badge>}
              </>
            }
            actions={
              unread > 0 && (
                <button className="btn btn-ghost btn-sm" onClick={markAll}>
                  Marcar como leídas
                </button>
              )
            }
          >
            {notes.data?.length ? (
              <ul className="list">
                {notes.data.slice(0, 8).map((n) => (
                  <li key={n.id} style={{ opacity: n.read_at ? 0.65 : 1 }}>
                    {n.link ? <Link href={n.link}>{n.title}</Link> : <strong>{n.title}</strong>}
                    {n.body && <div className="small muted">{n.body}</div>}
                    <div className="small muted">{dateTime(n.created_at)}</div>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>Sin notificaciones.</Empty>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
