'use client';

import { FormEvent, useState } from 'react';
import { api } from '@/lib/api';
import { dayLabel, shortHm, todayIso } from '@/lib/format';
import { Badge, Card, ErrorBox, Field, Modal, useAction, useLoad } from './ui';

const KIND_LABEL: Record<string, string> = { opening: 'Saldo inicial', paid: 'Pagadas en nómina', adjustment: 'Ajuste' };

/** Bolsa de horas y exceso de jornada del año de una relación laboral. */
export function HourBankCard({ employmentId, canAdjust }: { employmentId: string; canAdjust: boolean }) {
  const year = Number(todayIso().slice(0, 4));
  const { data, error, reload } = useLoad(() => api.get(`/time/employments/${employmentId}/hour-bank?year=${year}`), [employmentId]);
  const [adjusting, setAdjusting] = useState(false);
  if (!data) return error ? <ErrorBox error={error} /> : null;
  const overLimit = data.surplusYear > data.overtimeLimit;
  return (
    <Card
      title="Bolsa de horas"
      actions={
        canAdjust &&
        data.enabled && (
          <button className="btn btn-sm" onClick={() => setAdjusting(true)}>
            Registrar movimiento
          </button>
        )
      }
    >
      <div className="grid grid-3">
        <div className="stat">
          <span className="stat-value" style={{ color: (data.balance ?? 0) < 0 ? 'var(--warning)' : undefined }}>
            {data.enabled ? shortHm(data.balance) : '—'}
          </span>
          <span className="stat-label">{data.enabled ? `saldo desde ${dayLabel(data.since)}` : 'bolsa no activada'}</span>
        </div>
        <div className="stat">
          <span className="stat-value">{shortHm(data.surplusYear)}</span>
          <span className="stat-label">exceso sobre jornada en {year}</span>
        </div>
        <div className="stat">
          <span className="stat-value">{shortHm(data.overtimeLimit)}</span>
          <span className="stat-label">límite anual de horas extra</span>
        </div>
      </div>
      {overLimit && <p className="small text-danger">Atención: el exceso del año supera el límite de horas extraordinarias si no se compensa con descanso.</p>}
      <p className="muted small" style={{ marginTop: 8 }}>
        El saldo suma lo trabajado por encima de la jornada y resta lo que falta; los días de «Compensación de horas» lo consumen.
      </p>
      {data.adjustments?.length > 0 && (
        <ul className="list small">
          {data.adjustments.slice(0, 5).map((a: any) => (
            <li key={a.id}>
              <Badge tone={a.minutes > 0 ? 'success' : 'warning'}>{shortHm(a.minutes)}</Badge> {KIND_LABEL[a.kind]} · {dayLabel(a.date)} · {a.reason}
            </li>
          ))}
        </ul>
      )}
      {adjusting && <AdjustModal employmentId={employmentId} onClose={() => setAdjusting(false)} onDone={reload} />}
    </Card>
  );
}

function AdjustModal({ employmentId, onClose, onDone }: { employmentId: string; onClose: () => void; onDone: () => Promise<void> }) {
  const [f, setF] = useState({ hours: 1, sign: '-1', kind: 'paid', date: todayIso(), reason: '' });
  const { busy, error, run } = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api.post('/time/hour-bank/adjustments', {
        employmentId,
        date: f.date,
        kind: f.kind,
        reason: f.reason,
        minutes: Math.round(Number(f.hours) * 60) * Number(f.sign),
      });
      await onDone();
      onClose();
    });
  };
  return (
    <Modal title="Movimiento de la bolsa de horas" onClose={onClose}>
      <form onSubmit={submit}>
        <ErrorBox error={error} />
        <div className="form-grid">
          <Field label="Tipo">
            <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value, sign: e.target.value === 'paid' ? '-1' : f.sign })}>
              <option value="paid">Horas pagadas en nómina (restan)</option>
              <option value="opening">Saldo inicial</option>
              <option value="adjustment">Ajuste</option>
            </select>
          </Field>
          <Field label="Sentido">
            <select value={f.sign} onChange={(e) => setF({ ...f, sign: e.target.value })} disabled={f.kind === 'paid'}>
              <option value="1">Suma</option>
              <option value="-1">Resta</option>
            </select>
          </Field>
          <Field label="Horas">
            <input type="number" min={0.25} step={0.25} required value={f.hours} onChange={(e) => setF({ ...f, hours: Number(e.target.value) })} />
          </Field>
          <Field label="Fecha">
            <input type="date" required value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
          </Field>
        </div>
        <Field label="Motivo">
          <input required minLength={3} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
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
