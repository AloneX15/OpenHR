'use client';

import { FormEvent, useState } from 'react';
import { api } from '@/lib/api';
import { addDays, todayIso } from '@/lib/format';
import { ErrorBox, Field, Modal, useAction, useLoad } from './ui';

export function RequestModal({ employmentId, onClose, onDone, title = 'Solicitar ausencia' }: { employmentId: string; onClose: () => void; onDone: () => void; title?: string }) {
  const types = useLoad(() => api.get<any[]>('/org/absence-types'));
  const [f, setF] = useState({ absenceTypeId: '', startDate: addDays(todayIso(), 1), endDate: addDays(todayIso(), 1), comment: '' });
  const { busy, error, run } = useAction();
  const active = types.data?.filter((t) => t.active) ?? [];
  const typeId = f.absenceTypeId || active[0]?.id || '';
  const selected = active.find((t) => t.id === typeId);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await api.post('/absences', { ...f, absenceTypeId: typeId, employmentId, comment: f.comment || undefined });
      alert(r.status === 'approved' ? `Registrada (${r.days} día/s).` : `Solicitud enviada (${r.days} día/s). Te avisaremos cuando se resuelva.`);
      onDone();
      onClose();
    });
  };
  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={submit}>
        <ErrorBox error={error || types.error} />
        <Field label="Tipo">
          <select value={typeId} onChange={(e) => setF({ ...f, absenceTypeId: e.target.value })}>
            {active.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="form-grid">
          <Field label="Desde">
            <input type="date" required value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value, endDate: e.target.value > f.endDate ? e.target.value : f.endDate })} />
          </Field>
          <Field label="Hasta (incluido)">
            <input type="date" required min={f.startDate} value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} />
          </Field>
        </div>
        <Field label="Comentario (opcional)" hint={selected?.sensitive ? 'Tu responsable solo verá que estás ausente; el motivo lo ve RR. HH.' : undefined}>
          <textarea value={f.comment} onChange={(e) => setF({ ...f, comment: e.target.value })} />
        </Field>
        <p className="muted small">
          {selected?.day_unit === 'calendar' ? 'Se cuentan días naturales.' : 'Se cuentan días laborables según tu jornada y los festivos.'}{' '}
          {selected && !selected.requires_approval && 'Este tipo no necesita aprobación.'}
        </p>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-primary" disabled={busy || !typeId}>
            Enviar
          </button>
        </div>
      </form>
    </Modal>
  );
}

