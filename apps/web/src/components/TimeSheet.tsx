'use client';

import { FormEvent, useState } from 'react';
import { api, download } from '@/lib/api';
import { addDays, dayLabel, KIND_LABEL, monthBounds, shortHm, timeIn, todayIso, weekStart } from '@/lib/format';
import { useStagger } from '@/lib/motion';
import { daySegments } from './ClockWidget';
import { absenceTone } from './Events';
import { Icon, IconButton } from './icons';
import { Badge, Collapse, ErrorBox, Field, Menu, MenuItem, Modal, Notice, Segmented, Stepper, useAction, useLoad } from './ui';

type View = 'week' | 'month';

const weekdayFmt = new Intl.DateTimeFormat('es-ES', { weekday: 'long', timeZone: 'UTC' });
const dayMonthFmt = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const monthFmt = new Intl.DateTimeFormat('es-ES', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const utc = (date: string) => new Date(`${date}T12:00:00Z`);

export function TimeSheet({ employmentId, canEdit, canExport = true }: { employmentId: string; canEdit: boolean; canExport?: boolean }) {
  const [view, setView] = useState<View>('week');
  const [anchor, setAnchor] = useState(todayIso());
  const today = todayIso();
  const range =
    view === 'week'
      ? { from: weekStart(anchor), to: addDays(weekStart(anchor), 6) }
      : monthBounds(anchor.slice(0, 7));
  const { data, error, reload } = useLoad(
    () => api.get(`/time/employments/${employmentId}?from=${range.from}&to=${range.to}`),
    [employmentId, range.from, range.to],
  );
  const [adding, setAdding] = useState<string | null>(null);
  const [voiding, setVoiding] = useState<any | null>(null);
  const [verify, setVerify] = useState<any | null>(null);
  const exportAction = useAction();
  const stats = useStagger<HTMLDivElement>(`${range.from}/${view}`);

  const move = (dir: number) => {
    if (view === 'week') setAnchor(addDays(anchor, dir * 7));
    else {
      const [y, m] = anchor.split('-').map(Number);
      const d = new Date(Date.UTC(y, m - 1 + dir, 1));
      setAnchor(d.toISOString().slice(0, 10));
    }
  };

  const days: any[] = data?.days ?? [];
  // El balance solo cuenta hasta hoy: los días que aún no han llegado no «deben» horas.
  const totals = days.reduce(
    (acc, d) => ({
      worked: acc.worked + d.workedMinutes,
      expected: acc.expected + d.expectedMinutes,
      // Hoy solo suma si ya se ha superado la jornada: a media mañana no se «deben» horas.
      due: acc.due + (d.date < today ? d.expectedMinutes : d.date === today ? Math.min(d.expectedMinutes, d.workedMinutes) : 0),
      breaks: acc.breaks + (d.breakMinutes ?? 0),
    }),
    { worked: 0, expected: 0, due: 0, breaks: 0 },
  );
  const balance = totals.worked - totals.due;
  const byDay = new Map<string, any[]>();
  for (const e of data?.entries ?? []) byDay.set(e.localDate, [...(byDay.get(e.localDate) ?? []), e]);
  const tz = data?.timezone ?? 'Europe/Madrid';
  const periodLabel = view === 'week' ? `${dayMonthFmt.format(utc(range.from))} – ${dayMonthFmt.format(utc(range.to))}` : monthFmt.format(utc(range.from));

  const actions: MenuItem[] = [];
  if (canEdit) actions.push({ label: 'Añadir fichaje olvidado', icon: 'plus', onSelect: () => setAdding(today) });
  if (canExport)
    actions.push({
      label: 'Descargar registro (CSV)',
      icon: 'download',
      disabled: exportAction.busy,
      onSelect: () => void exportAction.run(() => download(`/exports/time-register?employmentId=${employmentId}&from=${range.from}&to=${range.to}`)),
    });
  actions.push({ label: 'Comprobar integridad', icon: 'security', onSelect: async () => setVerify(await api.get(`/time/employments/${employmentId}/verify`)) });

  return (
    <section className="card card-flush">
      <div className="card-head">
        <h2>Hoja de fichajes</h2>
        <div className="row">
          <Segmented<View> label="Periodo" value={view} onChange={setView} options={[{ id: 'week', label: 'Semana' }, { id: 'month', label: 'Mes' }]} />
          <Stepper label={periodLabel} onPrev={() => move(-1)} onNext={() => move(1)} prevLabel={view === 'week' ? 'Semana anterior' : 'Mes anterior'} nextLabel={view === 'week' ? 'Semana siguiente' : 'Mes siguiente'} />
          <button className="btn" onClick={() => setAnchor(today)} disabled={today >= range.from && today <= range.to}>
            Hoy
          </button>
          <Menu label="Más acciones" items={actions} className="btn-icon bordered">
            <Icon name="more" size={18} />
          </Menu>
        </div>
      </div>

      <div style={{ padding: '0 20px 16px' }}>
        <ErrorBox error={error || exportAction.error} />
        {verify &&
          (verify.ok ? (
            <Notice tone="success">Registro íntegro: {verify.count} eventos encadenados sin alteraciones.</Notice>
          ) : (
            <ErrorBox error={`Integridad comprometida en el evento ${verify.seq ?? ''}: ${verify.problem}`} />
          ))}
        <div className="grid grid-4" ref={stats} style={{ gap: 12 }}>
          <div className="stat-card tone-sky">
            <div className="stat">
              <span className="stat-value">{shortHm(totals.worked)}</span>
              <span className="stat-label">trabajado</span>
            </div>
          </div>
          <div className="stat-card tone-navy">
            <div className="stat">
              <span className="stat-value">{shortHm(totals.expected)}</span>
              <span className="stat-label">jornada teórica</span>
            </div>
          </div>
          <div className={`stat-card ${balance < 0 ? 'tone-warning' : 'tone-success'}`}>
            <div className="stat">
              <span className={`stat-value ${balance < 0 ? 'is-negative' : balance > 0 ? 'is-positive' : ''}`}>
                {balance > 0 ? '+' : ''}
                {shortHm(balance)}
              </span>
              <span className="stat-label">balance hasta hoy</span>
            </div>
          </div>
          <div className="stat-card tone-amber">
            <div className="stat">
              <span className="stat-value">{shortHm(totals.breaks)}</span>
              <span className="stat-label">en pausas</span>
            </div>
          </div>
        </div>
      </div>

      <div className="ts">
        <div className="ts-head" aria-hidden>
          <span>Día</span>
          <span>Trabajado / teórico</span>
          <span>Balance</span>
          <span>Pausas</span>
          <span>Notas</span>
          <span />
        </div>
        {days.map((d) => (
          <DayRow key={d.date} day={d} entries={byDay.get(d.date) ?? []} tz={tz} today={today} canEdit={canEdit} onAdd={() => setAdding(d.date)} onVoid={setVoiding} />
        ))}
      </div>
      <p className="muted small" style={{ padding: '12px 20px 16px', margin: 0, maxWidth: 'none' }}>
        Pulsa un día para ver sus fichajes. El lápiz marca uno añadido a mano. Los fichajes no se borran: al corregir uno queda anulado y tachado, con su motivo, y se conserva en el registro.
      </p>
      {adding && <AddEntryModal employmentId={employmentId} date={adding} onClose={() => setAdding(null)} onDone={reload} />}
      {voiding && <VoidModal entry={voiding} tz={tz} onClose={() => setVoiding(null)} onDone={reload} />}
    </section>
  );
}

function DayRow({ day: d, entries, tz, today, canEdit, onAdd, onVoid }: { day: any; entries: any[]; tz: string; today: string; canEdit: boolean; onAdd: () => void; onVoid: (entry: any) => void }) {
  const [open, setOpen] = useState(d.date === today);
  const quiet = d.expectedMinutes === 0 && d.workedMinutes === 0 && !entries.length;
  const future = d.date > today;
  const diff = d.workedMinutes - d.expectedMinutes;
  // El día en curso no muestra horas «en contra» hasta que termina.
  const showDiff = !future && (d.expectedMinutes > 0 || d.workedMinutes > 0) && !(d.date === today && diff < 0);
  const segments = daySegments(d.segments ?? []);
  const scale = Math.max(d.expectedMinutes, d.workedMinutes) + (d.breakMinutes ?? 0);
  const rest = Math.max(0, d.expectedMinutes - d.workedMinutes);
  const balanceText = showDiff ? `${diff > 0 ? '+' : ''}${shortHm(diff)}` : '—';
  const cls = ['ts-item'];
  if (quiet) cls.push('is-quiet');
  if (d.date === today) cls.push('is-today');

  return (
    <div className={cls.join(' ')}>
      <button type="button" className="ts-row" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="ts-day">
          <b>{dayMonthFmt.format(utc(d.date))}</b>
          <small>{weekdayFmt.format(utc(d.date))}</small>
        </span>
        <span className="ts-hours">
          <span>
            <b>{shortHm(d.workedMinutes)}</b> <span className="muted">/ {shortHm(d.expectedMinutes)} h</span>
            {showDiff && diff !== 0 && <span className={`ts-label ${diff < 0 ? 'is-negative' : 'is-positive'}`}> · {balanceText}</span>}
          </span>
          {scale > 0 && (
            <span className="daybar daybar-sm" aria-hidden>
              {segments.map((s, i) => (
                <span key={i} className={s.kind === 'work' ? 'seg-work' : 'seg-break'} style={{ flex: `${s.minutes} 0 0` }} />
              ))}
              {rest > 0 && <span style={{ flex: `${rest} 0 0` }} />}
            </span>
          )}
        </span>
        <span className={`ts-num ${showDiff && diff < 0 ? 'is-negative' : showDiff && diff > 0 ? 'is-positive' : 'muted'}`}>{balanceText}</span>
        <span className="ts-num muted">{d.breakMinutes ? shortHm(d.breakMinutes) : '—'}</span>
        <span className="ts-notes">
          {d.open && <Badge tone="success">En curso</Badge>}
          {d.shift && <Badge tone="info">{d.shift.isDayOff ? 'Libre' : `${d.shift.name ?? 'Turno'} ${timeIn(d.shift.startAt, tz)}–${timeIn(d.shift.endAt, tz)}`}</Badge>}
          {d.holiday && <Badge tone="danger">{d.holiday}</Badge>}
          {d.absence && <span className={`badge badge-dot tone-${absenceTone(d.absence.name)}`}>{d.absence.name}</span>}
          {d.incidents.length > 0 && <Badge tone="warning">{d.incidents.length === 1 ? '1 incidencia' : `${d.incidents.length} incidencias`}</Badge>}
        </span>
        <span className="ts-chev">
          <Icon name="chevronDown" size={16} />
        </span>
      </button>
      <Collapse open={open} className="ts-detail">
        <div className="ts-detail-inner">
          {d.incidents.map((i: string) => (
            <div key={i} className="small is-negative">
              {i}
            </div>
          ))}
          <div className="ts-entries">
            {entries.length === 0 && <span className="muted small">{future ? 'Aún no ha llegado este día.' : 'Sin fichajes este día.'}</span>}
            {entries.map((e: any) => (
              <span
                key={e.id}
                className={e.voided ? 'badge strike' : `badge ${e.kind === 'in' ? 'badge-success' : e.kind === 'out' ? 'badge-info' : 'badge-warning'}`}
                title={[
                  KIND_LABEL[e.kind],
                  e.source === 'manual' ? `Añadido a mano por ${e.createdBy}: ${e.reason}` : 'Fichado en tiempo real',
                  e.voided ? `Anulado por ${e.voided.by}: ${e.voided.reason}` : '',
                ]
                  .filter(Boolean)
                  .join('\n')}
              >
                {KIND_LABEL[e.kind]} · {timeIn(e.occurredAt, tz)}
                {e.source === 'manual' && <Icon name="edit" size={12} className="entry-mark" />}
                {canEdit && !e.voided && <IconButton icon="close" size={14} className="btn-icon entry-action" onClick={() => onVoid(e)} aria-label={`Anular ${KIND_LABEL[e.kind].toLowerCase()} de las ${timeIn(e.occurredAt, tz)}`} />}
              </span>
            ))}
            {canEdit && !future && (
              <IconButton icon="plus" className="btn btn-sm" onClick={onAdd}>
                Añadir fichaje
              </IconButton>
            )}
          </div>
        </div>
      </Collapse>
    </div>
  );
}

function AddEntryModal({ employmentId, date, onClose, onDone }: { employmentId: string; date: string; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ kind: 'in', date, time: '09:00', reason: '' });
  const { busy, error, run } = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api.post('/time/entries', { employmentId, ...f });
      onDone();
      onClose();
    });
  };
  return (
    <Modal title="Añadir fichaje olvidado" onClose={onClose}>
      <form onSubmit={submit}>
        <ErrorBox error={error} />
        <div className="form-grid">
          <Field label="Tipo">
            <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
              {Object.entries(KIND_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Fecha">
            <input type="date" required max={todayIso()} value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
          </Field>
          <Field label="Hora">
            <input type="time" required value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} />
          </Field>
        </div>
        <Field label="Motivo" hint="Queda registrado junto al fichaje y lo ve tu responsable.">
          <input required minLength={3} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="Olvidé fichar al llegar" />
        </Field>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-primary" disabled={busy}>
            Guardar
          </button>
        </div>
      </form>
    </Modal>
  );
}

function VoidModal({ entry, tz, onClose, onDone }: { entry: any; tz: string; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const { busy, error, run } = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api.post(`/time/entries/${entry.id}/void`, { reason });
      onDone();
      onClose();
    });
  };
  return (
    <Modal title="Anular fichaje" onClose={onClose}>
      <form onSubmit={submit}>
        <p>
          Vas a anular la <strong>{KIND_LABEL[entry.kind].toLowerCase()}</strong> de las <strong>{timeIn(entry.occurredAt, tz)}</strong> del{' '}
          {dayLabel(entry.localDate)}. Seguirá visible en el registro, tachada.
        </p>
        <ErrorBox error={error} />
        <Field label="Motivo">
          <input required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
        </Field>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-primary" disabled={busy}>
            Anular fichaje
          </button>
        </div>
      </form>
    </Modal>
  );
}

