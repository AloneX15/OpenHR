'use client';

import Link from 'next/link';
import { ClockWidget } from '@/components/ClockWidget';
import { absenceTone, EventRow } from '@/components/Events';
import { Icon, IconName } from '@/components/icons';
import { Badge, Card, EmptyState, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import { dateTime, dayLabel, longDate, STATUS_LABEL, todayIso } from '@/lib/format';
import { useSession } from '@/lib/session';

function greeting(hour: number) {
  return hour < 6 ? 'Buenas noches' : hour < 13 ? 'Buenos días' : hour < 21 ? 'Buenas tardes' : 'Buenas noches';
}

function Attention({ href, icon, title, detail }: { href: string; icon: IconName; title: string; detail: string }) {
  return (
    <Link href={href} className="row-link">
      <span className="row-icon">
        <Icon name={icon} size={18} />
      </span>
      <span className="row-main">
        <strong>{title}</strong>
        <small>{detail}</small>
      </span>
      <Icon name="chevronRight" size={18} />
    </Link>
  );
}

export default function HomePage() {
  const { me } = useSession();
  const today = todayIso();
  const year = today.slice(0, 4);
  const canApprove = me.isManager || me.isHr;
  const notes = useLoad(() => api.get<any[]>('/notifications'));
  const news = useLoad(() => api.get<any[]>('/announcements'));
  const todo = useLoad(async () => {
    const [policies, signatures, approvals] = await Promise.all([
      api.get<any[]>('/policies'),
      api.get<any[]>('/signatures/mine'),
      canApprove ? api.get<any[]>('/absences/pending') : Promise.resolve([]),
    ]);
    return {
      policies: policies.filter((p) => p.requires_acceptance && !p.accepted_at).length,
      signatures: signatures.filter((s) => s.status === 'pending').length,
      approvals,
    };
  });
  const balance = useLoad(() => (me.employments[0] ? api.get(`/absences/balance/${me.employments[0].id}?year=${year}`) : Promise.resolve(null)));
  // Lo próximo: mis ausencias que vienen y los festivos de mis sociedades.
  const upcoming = useLoad(async () => {
    const [mine, holidays] = await Promise.all([
      me.employments.length ? api.get<any[]>('/absences/mine') : Promise.resolve([]),
      api.get<any[]>(`/org/holidays?year=${year}`).catch(() => []),
    ]);
    const companies = new Set(me.employments.map((e) => e.company_id));
    const events = [
      ...mine
        .filter((a) => a.end_date >= today && (a.status === 'approved' || a.status === 'pending'))
        .map((a) => ({ key: `a${a.id}`, date: a.start_date < today ? today : a.start_date, title: a.type_name, detail: `${Number(a.days)} día(s) · ${STATUS_LABEL[a.status]}`, tone: absenceTone(a.type_name), pending: a.status === 'pending' })),
      ...holidays
        .filter((h) => h.date >= today && (!h.company_id || companies.has(h.company_id)))
        .map((h) => ({ key: `h${h.id}`, date: h.date, title: h.name, detail: 'Festivo', tone: 'rose', pending: false })),
    ];
    const seen = new Set<string>();
    return events
      .sort((a, b) => a.date.localeCompare(b.date))
      .filter((e) => !seen.has(e.date + e.title) && seen.add(e.date + e.title))
      .slice(0, 5);
  });

  const markAll = async () => {
    await api.post('/notifications/read-all');
    await notes.reload();
  };
  const unread = notes.data?.filter((n) => !n.read_at).length ?? 0;
  const t = todo.data;
  const nothing = t && !t.policies && !t.signatures && !t.approvals.length;
  const name = me.firstName ?? '';
  const used = balance.data ? Number(balance.data.approved) : 0;
  const held = balance.data ? Number(balance.data.pending) : 0;
  const total = balance.data ? Math.max(1, used + held + Number(balance.data.available)) : 1;

  return (
    <>
      <header className="hero">
        <span className="avatar avatar-lg" aria-hidden>
          {(name || me.email).slice(0, 1).toUpperCase()}
        </span>
        <div>
          <h1>
            {greeting(new Date().getHours())}
            {name ? `, ${name}` : ''}
          </h1>
          <p className="muted">
            {dayLabel(today).split(',')[0]}, {longDate(today)}
          </p>
        </div>
      </header>

      <div className="home-grid">
        <div className="stack home-main">
          <Card title="Requiere tu atención">
            {!t ? (
              <p className="muted">Cargando…</p>
            ) : nothing ? (
              <EmptyState icon="party" title="Todo al día">
                No tienes nada pendiente de firmar, aceptar ni aprobar.
              </EmptyState>
            ) : (
              <div className="stack" style={{ gap: 8 }}>
                {t.signatures > 0 && <Attention href="/firmas" icon="sign" title={`${t.signatures} documento(s) para firmar`} detail="Léelos y fírmalos con el código que te llega por email." />}
                {t.policies > 0 && <Attention href="/politicas" icon="policies" title={`${t.policies} política(s) por aceptar`} detail="Hay normas internas que necesitan tu confirmación." />}
                {t.approvals.length > 0 && (
                  <Attention
                    href="/ausencias?tab=aprobar"
                    icon="vacation"
                    title={`${t.approvals.length} ausencia(s) por aprobar`}
                    detail={t.approvals
                      .slice(0, 3)
                      .map((p) => p.person_name)
                      .join(', ')}
                  />
                )}
              </div>
            )}
          </Card>

          {news.data && news.data.length > 0 && (
            <Card title="Anuncios" actions={<Link href="/anuncios">Ver todos</Link>}>
              <ul className="list">
                {news.data.slice(0, 3).map((a) => (
                  <li key={a.id}>
                    <div className="spread">
                      <strong>{a.title}</strong>
                      {!a.read && <Badge tone="warning">Nuevo</Badge>}
                    </div>
                    <div className="small muted">
                      {a.body.slice(0, 180)}
                      {a.body.length > 180 ? '…' : ''}
                    </div>
                  </li>
                ))}
              </ul>
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
              <EmptyState icon="bell" title="Sin notificaciones">
                Aquí verás los avisos de ausencias, nóminas y firmas.
              </EmptyState>
            )}
          </Card>
        </div>

        {me.employments.length > 0 && (
          <div className="home-clock">
            <Card title="Fichaje" actions={<Link href="/horario">Mi control horario</Link>}>
              <ClockWidget me={me} />
            </Card>
          </div>
        )}

        <div className="stack home-side">
          {balance.data && (
            <Card title={`Vacaciones ${year}`} actions={<Link href="/ausencias">Solicitar</Link>}>
              <div className="spread" style={{ alignItems: 'flex-end', marginBottom: 10 }}>
                <div className="stat">
                  <span className="stat-value">{balance.data.available}</span>
                  <span className="stat-label">días disponibles</span>
                </div>
                <span className="small muted" style={{ textAlign: 'right' }}>
                  {used} disfrutados o aprobados
                  <br />
                  {held} pendientes de aprobar
                </span>
              </div>
              <div className="balance-bar" role="img" aria-label={`${used} usados y ${held} pendientes de ${total}`}>
                <span className="used" style={{ width: `${(used / total) * 100}%` }} />
                <span className="held" style={{ width: `${(held / total) * 100}%` }} />
              </div>
            </Card>
          )}

          <Card title="Próximamente">
            {upcoming.data?.length ? (
              <div className="stack" style={{ gap: 8 }}>
                {upcoming.data.map((e) => (
                  <EventRow key={e.key} date={e.date} title={e.title} detail={e.detail} tone={e.tone} pending={e.pending} />
                ))}
              </div>
            ) : (
              <EmptyState icon="calendar" title="Nada a la vista">
                No tienes ausencias ni festivos próximos.
              </EmptyState>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
