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
  const news = useLoad(() => api.get<any[]>('/announcements'));
  const todo = useLoad(async () => {
    const [policies, signatures] = await Promise.all([api.get<any[]>('/policies'), api.get<any[]>('/signatures/mine')]);
    return {
      policies: policies.filter((p) => p.requires_acceptance && !p.accepted_at).length,
      signatures: signatures.filter((s) => s.status === 'pending').length,
    };
  });
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
          {todo.data && (todo.data.policies > 0 || todo.data.signatures > 0) && (
            <Card title="Pendiente de ti">
              <ul className="list">
                {todo.data.signatures > 0 && (
                  <li>
                    <Link href="/firmas">{todo.data.signatures} documento(s) para firmar</Link>
                  </li>
                )}
                {todo.data.policies > 0 && (
                  <li>
                    <Link href="/politicas">{todo.data.policies} política(s) por aceptar</Link>
                  </li>
                )}
              </ul>
            </Card>
          )}
          {news.data && news.data.length > 0 && (
            <Card title="Anuncios" actions={<Link href="/anuncios">Ver todos</Link>}>
              <ul className="list">
                {news.data.slice(0, 3).map((a) => (
                  <li key={a.id}>
                    <strong>{a.title}</strong> {!a.read && <Badge tone="warning">Nuevo</Badge>}
                    <div className="small muted">{a.body.slice(0, 160)}</div>
                  </li>
                ))}
              </ul>
            </Card>
          )}
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
