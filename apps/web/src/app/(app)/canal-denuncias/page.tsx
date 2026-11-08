'use client';

import { FormEvent, useState } from 'react';
import { Badge, Card, Empty, ErrorBox, Field, Modal, Notice, PageHeader, useAction, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';

const STATUS: Record<string, { label: string; tone: any }> = {
  received: { label: 'Recibida', tone: 'warning' },
  acknowledged: { label: 'Acuse enviado', tone: 'info' },
  investigating: { label: 'En investigación', tone: 'info' },
  resolved: { label: 'Resuelta', tone: 'success' },
  dismissed: { label: 'Archivada', tone: 'neutral' },
};

/** Gestión del canal de denuncias: solo la persona Responsable del Sistema. */
export default function WhistleblowingHandlerPage() {
  const { data, error, reload } = useLoad(() => api.get<any[]>('/whistleblowing/reports'));
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <PageHeader title="Canal de denuncias" subtitle="Acusa recibo en 7 días y responde en 3 meses (ampliables a 6 en casos complejos)." />
      <ErrorBox error={error} />
      <Card>
        {data?.length ? (
          <table>
            <thead>
              <tr>
                <th>Asunto</th>
                <th>Recibida</th>
                <th>Plazos</th>
                <th>Estado</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.id}>
                  <td>
                    {r.subject}
                    <div className="small muted">
                      {r.category}
                      {r.anonymous ? ' · anónima' : ''}
                    </div>
                  </td>
                  <td>{dateTime(r.receivedAt)}</td>
                  <td className="small">
                    Acuse: {dateTime(r.ackDue)}
                    <br />
                    Respuesta: {dateTime(r.resolutionDue)}
                    {r.overdue && (
                      <div>
                        <Badge tone="danger">Plazo vencido</Badge>
                      </div>
                    )}
                  </td>
                  <td>
                    <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>
                  </td>
                  <td className="num">
                    <button className="btn btn-sm" onClick={() => setOpen(r.id)}>
                      Abrir
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>No hay comunicaciones.</Empty>
        )}
      </Card>
      {open && (
        <ReportModal
          id={open}
          onClose={() => {
            setOpen(null);
            void reload();
          }}
        />
      )}
    </>
  );
}

function ReportModal({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, error, reload } = useLoad(() => api.get(`/whistleblowing/reports/${id}`), [id]);
  const [reply, setReply] = useState('');
  const [status, setStatus] = useState('');
  const [resolution, setResolution] = useState('');
  const [extend, setExtend] = useState(false);
  const action = useAction();
  const send = (e: FormEvent) => {
    e.preventDefault();
    void action.run(async () => {
      await api.post(`/whistleblowing/reports/${id}/messages`, { body: reply });
      setReply('');
      await reload();
    });
  };
  if (!data) return null;
  return (
    <Modal title={data.subject} onClose={onClose}>
      <ErrorBox error={error || action.error} />
      <p className="small muted">
        {data.category} · {dateTime(data.receivedAt)} · {data.anonymous ? 'Anónima' : `Contacto: ${data.contact}`}
      </p>
      <p className="announcement-body">{data.description}</p>
      <h3>Conversación</h3>
      {data.messages.length ? (
        <ul className="list small">
          {data.messages.map((m: any, i: number) => (
            <li key={i}>
              <strong>{m.author === 'handler' ? 'Responsable' : 'Informante'}</strong> <span className="muted">{dateTime(m.createdAt)}</span>
              <div className="announcement-body">{m.body}</div>
            </li>
          ))}
        </ul>
      ) : (
        <Notice tone="warning">Aún no has respondido. Tu primera respuesta cuenta como acuse de recibo.</Notice>
      )}
      {!['resolved', 'dismissed'].includes(data.status) && (
        <form onSubmit={send}>
          <Field label="Responder al informante">
            <textarea required value={reply} onChange={(e) => setReply(e.target.value)} />
          </Field>
          <button className="btn btn-primary btn-sm" disabled={action.busy}>
            Enviar
          </button>
        </form>
      )}
      <h3 style={{ marginTop: 16 }}>Estado</h3>
      <div className="form-grid">
        <Field label="Nuevo estado">
          <select value={status || data.status} onChange={(e) => setStatus(e.target.value)}>
            {Object.entries(STATUS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {['resolved', 'dismissed'].includes(status) && (
        <Field label="Resolución (la verá el informante)">
          <textarea required value={resolution} onChange={(e) => setResolution(e.target.value)} />
        </Field>
      )}
      <label className="check">
        <input type="checkbox" checked={extend} onChange={(e) => setExtend(e.target.checked)} /> Ampliar el plazo de respuesta a 6 meses (caso complejo)
      </label>
      <div className="modal-actions">
        <button
          className="btn btn-primary"
          disabled={action.busy || (!status && !extend)}
          onClick={() =>
            action.run(async () => {
              await api.post(`/whistleblowing/reports/${id}/status`, { status: status || data.status, resolution: resolution || undefined, extendResolution: extend });
              await reload();
            })
          }
        >
          Guardar estado
        </button>
      </div>
    </Modal>
  );
}
