'use client';

import { useEffect, useState } from 'react';
import { api, newIdempotencyKey } from '@/lib/api';
import { hhmm, timeIn, todayIso } from '@/lib/format';
import { Me } from '@/lib/session';
import { IconButton } from './icons';
import { ErrorBox, useAction, useLoad } from './ui';

type State = 'out' | 'working' | 'break';

function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

function EmploymentClock({ employment, showCompany }: { employment: Me['employments'][number]; showCompany: boolean }) {
  const now = useNow();
  const today = todayIso();
  const { data, error, reload } = useLoad(async () => {
    const [status, range] = await Promise.all([
      api.get<{ employmentId: string; state: State; since: string | null }[]>('/time/status'),
      api.get(`/time/employments/${employment.id}?from=${today}&to=${today}`),
    ]);
    return { status: status.find((s) => s.employmentId === employment.id), day: range.days[0], loadedAt: Date.now() };
  }, [employment.id]);
  const action = useAction();

  const clock = (kind: 'in' | 'out' | 'break_start' | 'break_end') =>
    action.run(async () => {
      await api.post('/time/clock', { employmentId: employment.id, kind, idempotencyKey: newIdempotencyKey(), deviceTime: new Date().toISOString() });
      await reload();
    });

  const state: State = data?.status?.state ?? 'out';
  // Minutos de hoy: lo calculado por el servidor más lo transcurrido desde que se cargó.
  const extra = state === 'working' && data ? (now.getTime() - data.loadedAt) / 60000 : 0;
  const worked = (data?.day?.workedMinutes ?? 0) + extra;
  const expected = data?.day?.expectedMinutes ?? 0;

  return (
    <div className="clock">
      {showCompany && <p className="muted small">{employment.company_name}</p>}
      <div className="clock-time">{timeIn(now, employment.timezone)}</div>
      <div className="clock-state">
        <span className={`dot dot-${state}`} />
        {state === 'working' ? 'Trabajando' : state === 'break' ? 'En pausa' : 'Fuera de jornada'}
        {data?.status?.since && state !== 'out' && <span className="muted"> desde las {timeIn(data.status.since, employment.timezone)}</span>}
      </div>
      <ErrorBox error={error || action.error} />
      <div className="clock-actions">
        {state === 'out' && (
          <IconButton icon="timer" size={20} className="btn btn-success btn-lg" disabled={action.busy} onClick={() => clock('in')}>
            Fichar entrada
          </IconButton>
        )}
        {state === 'working' && (
          <>
            <IconButton icon="clock" size={20} className="btn btn-lg" disabled={action.busy} onClick={() => clock('break_start')}>
              Pausa
            </IconButton>
            <IconButton icon="logout" size={20} className="btn btn-primary btn-lg" disabled={action.busy} onClick={() => clock('out')}>
              Fichar salida
            </IconButton>
          </>
        )}
        {state === 'break' && (
          <>
            <IconButton icon="timer" size={20} className="btn btn-success btn-lg" disabled={action.busy} onClick={() => clock('break_end')}>
              Volver de la pausa
            </IconButton>
            <IconButton icon="logout" size={20} className="btn btn-lg" disabled={action.busy} onClick={() => clock('out')}>
              Fichar salida
            </IconButton>
          </>
        )}
      </div>
      <p className="muted small" style={{ marginTop: 14 }}>
        Hoy: <strong>{hhmm(worked)}</strong>
        {expected > 0 ? ` de ${hhmm(expected)}` : data?.day?.holiday ? ` · festivo (${data.day.holiday})` : ''}
      </p>
    </div>
  );
}

export function ClockWidget({ me }: { me: Me }) {
  if (!me.employments.length) return <p className="muted">No tienes ninguna relación laboral activa, así que no necesitas fichar.</p>;
  return (
    <div className="stack">
      {me.employments.map((e) => (
        <EmploymentClock key={e.id} employment={e} showCompany={me.employments.length > 1} />
      ))}
    </div>
  );
}
