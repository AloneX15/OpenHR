'use client';

import { useEffect, useState } from 'react';
import { api, newIdempotencyKey } from '@/lib/api';
import { hhmm, shortHm, timeIn, todayIso } from '@/lib/format';
import { useGrow } from '@/lib/motion';
import { Me } from '@/lib/session';
import { currentPosition, enqueue, flush, isNetworkError, queued } from '@/lib/offline-clock';
import { Icon, IconButton } from './icons';
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

function EmploymentClock({ employment, showCompany, onChange }: { employment: Me['employments'][number]; showCompany: boolean; onChange?: () => void }) {
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
        onChange?.();
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
  const grow = useGrow<HTMLDivElement>(data?.loadedAt);

  // Barra del día: tramos trabajados y pausas entre ellos, sobre la jornada prevista.
  const segments = daySegments(data?.day?.segments ?? [], extra);
  const breaks = segments.filter((s) => s.kind === 'break').reduce((n, s) => n + s.minutes, 0);
  const remaining = Math.max(0, expected - worked);
  const scale = Math.max(expected, worked) + breaks;
  const label = state === 'working' ? 'Trabajando' : state === 'break' ? 'En pausa' : 'Fuera de jornada';

  return (
    <div className="clock" ref={grow}>
      {showCompany && <p className="eyebrow" style={{ margin: 0 }}>{employment.company_name}</p>}
      <div className="clock-top">
        <span className="clock-state">
          <span className={`dot dot-${state}`} />
          {label}
          {data?.status?.since && state !== 'out' && <span className="muted small"> desde las {timeIn(data.status.since, employment.timezone)}</span>}
        </span>
        <span className="muted small num-tab" title="Hora del centro de trabajo">
          {timeIn(now, employment.timezone)}
        </span>
      </div>
      <div className="clock-time" aria-label={`Hoy llevas ${hhmm(worked)}`}>
        {shortHm(worked)}
        <small>h hoy</small>
      </div>
      <div className="daybar" role="img" aria-label={expected ? `${hhmm(worked)} de ${hhmm(expected)}` : hhmm(worked)}>
        {segments.map((s, i) => (
          <span key={i} data-grow className={s.kind === 'work' ? 'seg-work' : 'seg-break'} style={{ flex: `${s.minutes} 0 0` }} title={s.kind === 'work' ? `Trabajo: ${hhmm(s.minutes)}` : `Pausa: ${hhmm(s.minutes)}`} />
        ))}
        {scale > 0 && remaining > 0 && <span style={{ flex: `${remaining} 0 0` }} />}
      </div>
      <div className="clock-meta">
        <span>{data?.day?.firstIn ? `Entrada ${data.day.firstIn}` : data?.day?.holiday ? `Festivo: ${data.day.holiday}` : 'Aún no has fichado hoy'}</span>
        <span>
          {expected === 0 ? 'Sin jornada prevista' : remaining > 0 ? `Quedan ${shortHm(remaining)} de ${shortHm(expected)}` : `Jornada cumplida (+${shortHm(worked - expected)})`}
        </span>
      </div>
      <ErrorBox error={action.error || (pending ? null : error)} />
      {pending > 0 && (
        <p className="small is-negative" style={{ margin: 0 }}>
          Sin conexión: {pending} fichaje(s) guardado(s) en este dispositivo. Se enviarán solos al recuperar la conexión.
        </p>
      )}
      <div className="clock-actions">
        {state === 'out' && (
          <IconButton icon="play" size={20} className="btn btn-success btn-lg" disabled={action.busy} onClick={() => clock('in')}>
            Fichar entrada
          </IconButton>
        )}
        {state === 'working' && (
          <>
            <IconButton icon="coffee" size={20} className="btn btn-lg" disabled={action.busy} onClick={() => clock('break_start')}>
              Pausa
            </IconButton>
            <IconButton icon="logout" size={20} className="btn btn-primary btn-lg" disabled={action.busy} onClick={() => clock('out')}>
              Fichar salida
            </IconButton>
          </>
        )}
        {state === 'break' && (
          <>
            <IconButton icon="play" size={20} className="btn btn-success btn-lg" disabled={action.busy} onClick={() => clock('break_end')}>
              Volver de la pausa
            </IconButton>
            <IconButton icon="logout" size={20} className="btn btn-lg" disabled={action.busy} onClick={() => clock('out')}>
              Fichar salida
            </IconButton>
          </>
        )}
      </div>
      {employment.geo_policy !== 'off' && (
        <p className="muted small" style={{ margin: 0 }}>
          <Icon name="pin" size={14} /> Tu centro registra la ubicación al fichar.
        </p>
      )}
    </div>
  );
}

/** Convierte los tramos «HH:MM-HH:MM» del día en trabajo y pausas (los huecos entre tramos). */
export function daySegments(raw: string[], extraMinutes = 0): { kind: 'work' | 'break'; minutes: number }[] {
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const out: { kind: 'work' | 'break'; minutes: number }[] = [];
  let lastEnd: number | null = null;
  for (const seg of raw) {
    const [a, b] = seg.split('-');
    if (!a || !b) continue;
    const start = toMin(a);
    const end = toMin(b);
    if (lastEnd !== null && start > lastEnd) out.push({ kind: 'break', minutes: start - lastEnd });
    if (end > start) out.push({ kind: 'work', minutes: end - start });
    lastEnd = end;
  }
  if (extraMinutes > 0) {
    const last = out[out.length - 1];
    if (last?.kind === 'work') last.minutes += extraMinutes;
    else out.push({ kind: 'work', minutes: extraMinutes });
  }
  return out;
}

export function ClockWidget({ me, onChange }: { me: Me; onChange?: () => void }) {
  if (!me.employments.length) return <p className="muted">No tienes ninguna relación laboral activa, así que no necesitas fichar.</p>;
  return (
    <div className="stack">
      {me.employments.map((e) => (
        <EmploymentClock key={e.id} employment={e} showCompany={me.employments.length > 1} onChange={onChange} />
      ))}
    </div>
  );
}
