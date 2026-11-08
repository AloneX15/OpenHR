'use client';

import { FormEvent, useState } from 'react';
import { api } from '@/lib/api';
import { dayLabel, todayIso } from '@/lib/format';
import { IconButton } from './icons';
import { Badge, Card, Empty, ErrorBox, Field, Modal, useAction, useLoad } from './ui';

export const STEP_KIND_LABEL: Record<string, string> = {
  manager: 'Responsable directo',
  manager_of_manager: 'Responsable del responsable',
  hr: 'RR. HH.',
  admin: 'Administración',
  user: 'Persona concreta',
};

const STEP_STATUS: Record<string, { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' | 'info' }> = {
  waiting: { label: 'En espera', tone: 'neutral' },
  pending: { label: 'Pendiente', tone: 'warning' },
  approved: { label: 'Aprobado', tone: 'success' },
  rejected: { label: 'Rechazado', tone: 'danger' },
  skipped: { label: 'Saltado', tone: 'neutral' },
  cancelled: { label: 'Anulado', tone: 'neutral' },
};

/** Línea compacta con el estado de cada paso de aprobación de una solicitud. */
export function ApprovalSteps({ steps }: { steps?: any[] }) {
  if (!steps?.length || steps.length < 2) {
    const s = steps?.[0];
    if (!s || s.status !== 'approved' || s.decided_as !== 'delegate') return null;
  }
  return (
    <div className="steps small">
      {steps!.map((s) => (
        <span key={s.step_index} title={s.comment ?? ''}>
          <Badge tone={STEP_STATUS[s.status].tone}>
            {s.step_index + 1}. {STEP_KIND_LABEL[s.kind]}: {STEP_STATUS[s.status].label}
          </Badge>
          {s.decided_by_name && (
            <span className="muted">
              {' '}
              ({s.decided_by_name}
              {s.decided_as === 'delegate' ? ', por delegación' : s.decided_as === 'hr' ? ', como RR. HH.' : ''})
            </span>
          )}
          {s.status === 'pending' && s.approver_names?.length > 0 && <span className="muted"> ({s.approver_names.join(', ')})</span>}
        </span>
      ))}
    </div>
  );
}

/** Delegaciones de aprobación: quién aprueba por mí mientras no estoy. */
export function Delegations() {
  const { data, error, reload } = useLoad(() => api.get<any[]>('/approvals/delegations'));
  const [creating, setCreating] = useState(false);
  const action = useAction();
  return (
    <Card
      title="Delegaciones"
      actions={
        <IconButton icon="plus" className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
          Delegar mis aprobaciones
        </IconButton>
      }
    >
      <p className="muted">
        Mientras estés fuera, otra persona puede aprobar en tu lugar. Queda registrado que aprobó por delegación.
      </p>
      <ErrorBox error={error || action.error} />
      {data?.length ? (
        <table>
          <thead>
            <tr>
              <th>De</th>
              <th>En</th>
              <th>Fechas</th>
              <th>Motivo</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.id}>
                <td>{d.from_name}</td>
                <td>{d.to_name}</td>
                <td>
                  {dayLabel(d.start_date)} → {dayLabel(d.end_date)}
                </td>
                <td className="small">{d.reason}</td>
                <td className="num">
                  <button
                    className="btn btn-sm btn-danger"
                    disabled={action.busy}
                    onClick={() => confirm('¿Quitar esta delegación?') && action.run(async () => (await api.del(`/approvals/delegations/${d.id}`), reload()))}
                  >
                    Quitar
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>No hay delegaciones activas.</Empty>
      )}
      {creating && <DelegationModal onClose={() => setCreating(false)} onDone={reload} />}
    </Card>
  );
}

function DelegationModal({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<void> }) {
  const candidates = useLoad(() => api.get<any[]>('/approvals/candidates'));
  const [f, setF] = useState({ toUserId: '', startDate: todayIso(), endDate: todayIso(), reason: '' });
  const { busy, error, run } = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api.post('/approvals/delegations', { ...f, reason: f.reason || undefined });
      await onDone();
      onClose();
    });
  };
  return (
    <Modal title="Delegar mis aprobaciones" onClose={onClose}>
      <form onSubmit={submit}>
        <ErrorBox error={error || candidates.error} />
        <Field label="Persona que aprobará por mí">
          <select required value={f.toUserId} onChange={(e) => setF({ ...f, toUserId: e.target.value })}>
            <option value="" disabled>
              Elige…
            </option>
            {candidates.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="form-grid">
          <Field label="Desde">
            <input type="date" required value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} />
          </Field>
          <Field label="Hasta (incluido)">
            <input type="date" required min={f.startDate} value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} />
          </Field>
        </div>
        <Field label="Motivo (opcional)">
          <input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="Vacaciones" />
        </Field>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-primary" disabled={busy}>
            Delegar
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Configuración de circuitos de aprobación (Organización). */
export function ApprovalFlows({ isAdmin }: { isAdmin: boolean }) {
  const flows = useLoad(() => api.get<any[]>('/approvals/flows'));
  const candidates = useLoad(() => api.get<any[]>('/approvals/candidates'));
  const [editing, setEditing] = useState<any | null>(null);
  const action = useAction();
  const userName = (id: string) => candidates.data?.find((c) => c.id === id)?.name ?? 'Persona';
  return (
    <Card
      title="Circuitos de aprobación de ausencias"
      actions={
        <IconButton icon="plus" className="btn btn-primary btn-sm" onClick={() => setEditing({ companyId: null, absenceTypeId: null, steps: [{ kind: 'manager' }] })}>
          Nuevo circuito
        </IconButton>
      }
    >
      <p className="muted">
        Sin circuito, aprueba el responsable directo (y, si no tiene, RR. HH.). Se aplica el circuito más específico: sociedad y tipo, sociedad, tipo o
        general. Las ausencias con datos de salud las aprueba siempre RR. HH.
      </p>
      <ErrorBox error={flows.error || action.error} />
      {flows.data?.length ? (
        <table>
          <thead>
            <tr>
              <th>Sociedad</th>
              <th>Tipo de ausencia</th>
              <th>Pasos</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {flows.data.map((f) => (
              <tr key={f.id}>
                <td>{f.company_name ?? 'Todas'}</td>
                <td>{f.absence_type_name ?? 'Todos'}</td>
                <td className="small">
                  {f.steps.map((s: any, i: number) => (
                    <span key={i}>
                      {i > 0 && ' → '}
                      {s.kind === 'user' ? userName(s.userId) : STEP_KIND_LABEL[s.kind]}
                    </span>
                  ))}
                </td>
                <td className="num">
                  <div className="row" style={{ justifyContent: 'flex-end' }}>
                    <button className="btn btn-sm" onClick={() => setEditing({ companyId: f.company_id, absenceTypeId: f.absence_type_id, steps: f.steps })}>
                      Editar
                    </button>
                    {(isAdmin || f.company_id) && (
                      <button
                        className="btn btn-sm btn-danger"
                        disabled={action.busy}
                        onClick={() => confirm('¿Eliminar este circuito?') && action.run(async () => (await api.del(`/approvals/flows/${f.id}`), flows.reload()))}
                      >
                        Eliminar
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>Sin circuitos: aprueba el responsable directo.</Empty>
      )}
      {editing && <FlowModal initial={editing} isAdmin={isAdmin} candidates={candidates.data ?? []} onClose={() => setEditing(null)} onDone={flows.reload} />}
    </Card>
  );
}

function FlowModal({ initial, isAdmin, candidates, onClose, onDone }: { initial: any; isAdmin: boolean; candidates: any[]; onClose: () => void; onDone: () => Promise<void> }) {
  const companies = useLoad(() => api.get<any[]>('/org/companies'));
  const types = useLoad(() => api.get<any[]>('/org/absence-types'));
  const [companyId, setCompanyId] = useState<string>(initial.companyId ?? '');
  const [absenceTypeId, setAbsenceTypeId] = useState<string>(initial.absenceTypeId ?? '');
  const [steps, setSteps] = useState<any[]>(initial.steps);
  const { busy, error, run } = useAction();
  const setStep = (i: number, v: any) => setSteps(steps.map((s, j) => (j === i ? v : s)));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api.put('/approvals/flows', { companyId: companyId || null, absenceTypeId: absenceTypeId || null, steps });
      await onDone();
      onClose();
    });
  };
  return (
    <Modal title="Circuito de aprobación" onClose={onClose}>
      <form onSubmit={submit}>
        <ErrorBox error={error} />
        <div className="form-grid">
          <Field label="Sociedad">
            <select value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
              {isAdmin && <option value="">Todas</option>}
              {companies.data?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Tipo de ausencia">
            <select value={absenceTypeId} onChange={(e) => setAbsenceTypeId(e.target.value)}>
              <option value="">Todos</option>
              {types.data
                ?.filter((t) => !t.sensitive)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
            </select>
          </Field>
        </div>
        <h3>Pasos, en orden</h3>
        {steps.map((s, i) => (
          <div key={i} className="row" style={{ marginBottom: 8 }}>
            <span className="muted">{i + 1}.</span>
            <select
              aria-label={`Paso ${i + 1}`}
              value={s.kind}
              onChange={(e) => setStep(i, e.target.value === 'user' ? { kind: 'user', userId: candidates[0]?.id } : { kind: e.target.value })}
              style={{ width: 'auto' }}
            >
              {Object.entries(STEP_KIND_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
            {s.kind === 'user' && (
              <select aria-label="Persona" value={s.userId} onChange={(e) => setStep(i, { kind: 'user', userId: e.target.value })} style={{ width: 'auto' }}>
                {candidates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
            {steps.length > 1 && (
              <IconButton icon="close" className="btn-icon" aria-label="Quitar paso" onClick={() => setSteps(steps.filter((_, j) => j !== i))} />
            )}
          </div>
        ))}
        {steps.length < 5 && (
          <button type="button" className="btn btn-sm" onClick={() => setSteps([...steps, { kind: 'hr' }])}>
            Añadir paso
          </button>
        )}
        <p className="muted small" style={{ marginTop: 8 }}>
          Si un paso no tiene a nadie (por ejemplo, la persona no tiene responsable), se salta. RR. HH. puede aprobar en cualquier paso y resolver la
          solicitud completa.
        </p>
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
