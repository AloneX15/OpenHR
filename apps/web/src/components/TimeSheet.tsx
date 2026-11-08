'use client';

import { FormEvent, Fragment, useState } from 'react';
import { api, download } from '@/lib/api';
import { addDays, dayLabel, KIND_LABEL, monthBounds, shortHm, timeIn, todayIso, weekStart } from '@/lib/format';
import { Icon, IconButton } from './icons';
import { Badge, Card, ErrorBox, Field, Modal, Notice, Tabs, useAction, useLoad } from './ui';

type View = 'week' | 'month';

export function TimeSheet({ employmentId, canEdit, canExport = true }: { employmentId: string; canEdit: boolean; canExport?: boolean }) {
  const [view, setView] = useState<View>('week');
  const [anchor, setAnchor] = useState(todayIso());
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

  const move = (dir: number) => {
    if (view === 'week') setAnchor(addDays(anchor, dir * 7));
    else {
      const [y, m] = anchor.split('-').map(Number);
      const d = new Date(Date.UTC(y, m - 1 + dir, 1));
      setAnchor(d.toISOString().slice(0, 10));
    }
  };

  const totals = (data?.days ?? []).reduce(
    (acc: any, d: any) => ({ worked: acc.worked + d.workedMinutes, expected: acc.expected + d.expectedMinutes }),
    { worked: 0, expected: 0 },
  );
  const byDay = new Map<string, any[]>();
  for (const e of data?.entries ?? []) byDay.set(e.localDate, [...(byDay.get(e.localDate) ?? []), e]);
  const tz = data?.timezone ?? 'Europe/Madrid';

  return (
    <Card
      title={view === 'week' ? `Semana del ${dayLabel(range.from)} al ${dayLabel(range.to)}` : new Intl.DateTimeFormat('es-ES', { month: 'long', year: 'numeric' }).format(new Date(`${range.from}T12:00:00Z`))}
      actions={
        <div className="row">
          <button className="btn btn-sm" onClick={() => move(-1)} aria-label="Anterior">
            ←
          </button>
          <button className="btn btn-sm" onClick={() => setAnchor(todayIso())}>
            Hoy
          </button>
          <button className="btn btn-sm" onClick={() => move(1)} aria-label="Siguiente">
            →
          </button>
        </div>
      }
    >
      <div className="spread" style={{ marginBottom: 12 }}>
        <Tabs<View> value={view} onChange={setView} tabs={[{ id: 'week', label: 'Semana' }, { id: 'month', label: 'Mes' }]} />
        <div className="row">
          {canEdit && (
            <IconButton icon="plus" className="btn btn-sm" onClick={() => setAdding(todayIso())}>
              Añadir fichaje olvidado
            </IconButton>
          )}
          {canExport && (
            <IconButton
              icon="download"
              className="btn btn-sm"
              disabled={exportAction.busy}
              onClick={() => exportAction.run(() => download(`/exports/time-register?employmentId=${employmentId}&from=${range.from}&to=${range.to}`))}
            >
              Descargar registro
            </IconButton>
          )}
          <IconButton icon="security" className="btn btn-sm btn-ghost" onClick={async () => setVerify(await api.get(`/time/employments/${employmentId}/verify`))}>
            Comprobar integridad
          </IconButton>
        </div>
      </div>
      <ErrorBox error={error || exportAction.error} />
      {verify &&
        (verify.ok ? (
          <Notice tone="success">Registro íntegro: {verify.count} eventos encadenados sin alteraciones.</Notice>
        ) : (
          <ErrorBox error={`Integridad comprometida en el evento ${verify.seq ?? ''}: ${verify.problem}`} />
        ))}
      <div className="row" style={{ gap: 24, marginBottom: 8 }}>
        <div className="stat">
          <span className="stat-value">{shortHm(totals.worked)}</span>
          <span className="stat-label">trabajado</span>
        </div>
        <div className="stat">
          <span className="stat-value">{shortHm(totals.expected)}</span>
          <span className="stat-label">jornada teórica</span>
        </div>
        <div className="stat">
          <span className="stat-value" style={{ color: totals.worked - totals.expected < 0 ? 'var(--warning)' : undefined }}>
            {shortHm(totals.worked - totals.expected)}
          </span>
          <span className="stat-label">diferencia</span>
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Día</th>
              <th>Fichajes</th>
              <th className="num">Trabajado</th>
              <th className="num">Teórico</th>
              <th>Notas</th>
            </tr>
          </thead>
          <tbody>
            {(data?.days ?? []).map((d: any) => {
              const entries = byDay.get(d.date) ?? [];
              const quiet = d.expectedMinutes === 0 && d.workedMinutes === 0 && !entries.length;
              return (
                <tr key={d.date} className={quiet ? 'weekend' : ''}>
                  <td style={{ whiteSpace: 'nowrap' }}>{dayLabel(d.date)}</td>
                  <td>
                    <div className="row" style={{ gap: 6 }}>
                      {entries.map((e: any) => (
                        <Fragment key={e.id}>
                          <span
                            className={e.voided ? 'badge strike' : `badge ${e.kind === 'in' ? 'badge-success' : e.kind === 'out' ? 'badge-info' : ''}`}
                            title={[
                              KIND_LABEL[e.kind],
                              e.source === 'manual' ? `Añadido a mano por ${e.createdBy}: ${e.reason}` : 'Fichado en tiempo real',
                              e.voided ? `Anulado por ${e.voided.by}: ${e.voided.reason}` : '',
                            ]
                              .filter(Boolean)
                              .join('\n')}
                          >
                            {KIND_LABEL[e.kind].split(' ')[0]} {timeIn(e.occurredAt, tz)}
                            {e.source === 'manual' && <Icon name="edit" size={12} className="entry-mark" />}
                            {canEdit && !e.voided && (
                              <IconButton icon="close" size={14} className="btn-icon entry-action" onClick={() => setVoiding(e)} aria-label="Anular fichaje" />
                            )}
                          </span>
                        </Fragment>
                      ))}
                      {canEdit && !quiet && d.date <= todayIso() && (
                        <IconButton icon="plus" size={16} className="btn-icon" title="Añadir fichaje" aria-label="Añadir fichaje" onClick={() => setAdding(d.date)} />
                      )}
                    </div>
                  </td>
                  <td className="num">{d.workedMinutes ? shortHm(d.workedMinutes) : '—'}</td>
                  <td className="num">{d.expectedMinutes ? shortHm(d.expectedMinutes) : '—'}</td>
                  <td className="small">
                    {d.holiday && <Badge>{d.holiday}</Badge>} {d.absence && <Badge tone="info">{d.absence.name}</Badge>}{' '}
                    {d.open && <Badge tone="success">En curso</Badge>}
                    {d.incidents.map((i: string) => (
                      <div key={i} style={{ color: 'var(--warning)' }}>
                        {i}
                      </div>
                    ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="muted small" style={{ marginTop: 12 }}>
        El lápiz marca un fichaje añadido a mano. Los fichajes no se borran: al corregir uno queda anulado y tachado, con su motivo, y se conserva en el registro.
      </p>
      {adding && <AddEntryModal employmentId={employmentId} date={adding} onClose={() => setAdding(null)} onDone={reload} />}
      {voiding && <VoidModal entry={voiding} tz={tz} onClose={() => setVoiding(null)} onDone={reload} />}
    </Card>
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

