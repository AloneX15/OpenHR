'use client';

import { useEffect, useState } from 'react';
import { api, newIdempotencyKey } from '@/lib/api';
import { hhmm, timeIn, todayIso } from '@/lib/format';
import { Me } from '@/lib/session';
import { currentPosition, enqueue, flush, isNetworkError, queued } from '@/lib/offline-clock';
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

  const [offlineState, setOfflineState] = useState<State | null>(null);
  const [pending, setPending] = useState(0);

  // Al cargar y al volver la conexión, se envían los fichajes guardados sin conexión.
  useEffect(() => {
    const sync = async () => {
      setPending(queued().length);
      if (!queued().length || !navigator.onLine) return;
      const r = await flush();
      setPending(queued().length);
      if (r.sent) {
        setOfflineState(null);
        await reload();
      }
    };
    void sync();
    window.addEventListener('online', sync);
    return () => window.removeEventListener('online', sync);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clock = (kind: 'in' | 'out' | 'break_start' | 'break_end') =>
    action.run(async () => {
      const at = new Date().toISOString();
      const idempotencyKey = newIdempotencyKey();
      const location = employment.geo_policy !== 'off' ? await currentPosition() : undefined;
      try {
        await api.post('/time/clock', { employmentId: employment.id, kind, idempotencyKey, deviceTime: at, location });
        await reload();
      } catch (e) {
        if (!isNetworkError(e)) throw e;
        // Sin conexión: se guarda con su hora y se envía en cuanto vuelva.
        enqueue({ employmentId: employment.id, kind, offlineAt: at, idempotencyKey });
        setPending(queued().length);
        setOfflineState(kind === 'in' || kind === 'break_end' ? 'working' : kind === 'break_start' ? 'break' : 'out');
      }
    });

  const state: State = offlineState ?? data?.status?.state ?? 'out';
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
      <ErrorBox error={action.error || (pending ? null : error)} />
      {pending > 0 && (
        <p className="small" style={{ color: 'var(--warning)' }}>
          Sin conexión: {pending} fichaje(s) guardado(s) en este dispositivo. Se enviarán solos al recuperar la conexión.
        </p>
      )}
      {employment.geo_policy !== 'off' && <p className="muted small">Tu centro registra la ubicación al fichar.</p>}
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
