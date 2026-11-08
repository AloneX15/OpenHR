'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { FormEvent, useState } from 'react';
import { Badge, Card, ErrorBox, Field, PageHeader, useAction, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';

const STATUS: Record<string, { label: string; tone: any }> = {
  open: { label: 'Abierta', tone: 'warning' },
  in_progress: { label: 'En curso', tone: 'info' },
  waiting: { label: 'Esperando respuesta', tone: 'warning' },
  resolved: { label: 'Resuelta', tone: 'success' },
  closed: { label: 'Cerrada', tone: 'neutral' },
};

/** Una consulta: conversación, respuesta y, para RR. HH., estado y responsable. */
export default function TicketPage() {
  const { id } = useParams<{ id: string }>();
  const { data: t, error, reload } = useLoad(() => api.get<any>(`/tickets/${id}`), [id]);
  const [body, setBody] = useState('');
  const [internal, setInternal] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const action = useAction();
  const assignees = useLoad(() => (t?.canManage ? api.get<any[]>(`/tickets/${id}/assignees`) : Promise.resolve([])), [t?.canManage]);

  const send = (e: FormEvent) => {
    e.preventDefault();
    void action.run(async () => {
      const form = new FormData();
      form.set('body', body);
      form.set('internal', String(internal));
      if (file) form.set('file', file);
      await api.upload(`/tickets/${id}/messages`, form);
      setBody('');
      setFile(null);
      setInternal(false);
      await reload();
    });
  };
  const patch = (changes: Record<string, unknown>) => action.run(async () => (await api.patch(`/tickets/${id}`, changes), reload()));

  if (error) return <ErrorBox error={error} />;
  if (!t) return null;
  return (
    <>
      <PageHeader
        title={`#${t.number} · ${t.subject}`}
        subtitle={
          <>
            {t.category_name} · {t.requester_name} · {t.company_name} <Badge tone={STATUS[t.status].tone}>{STATUS[t.status].label}</Badge>
          </>
        }
        actions={
          <Link className="btn btn-sm" href="/consultas">
            Volver
          </Link>
        }
      />
      <ErrorBox error={action.error} />
      {t.canManage && (
        <Card>
          <div className="row">
            <label className="small">
              Estado{' '}
              <select value={t.status} onChange={(e) => patch({ status: e.target.value })}>
                {Object.entries(STATUS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="small">
              Lleva{' '}
              <select value={t.assignee_user_id ?? ''} onChange={(e) => patch({ assigneeUserId: e.target.value || null })}>
                <option value="">Sin asignar</option>
                {assignees.data?.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="small">
              Prioridad{' '}
              <select value={t.priority} onChange={(e) => patch({ priority: e.target.value })}>
                <option value="normal">Normal</option>
                <option value="high">Alta</option>
              </select>
            </label>
          </div>
        </Card>
      )}
      <div className="stack" style={{ marginTop: 16 }}>
        {t.messages.map((m: any) => (
          <Card key={m.id} className={m.internal ? 'ticket-msg internal' : m.from_hr ? 'ticket-msg hr' : 'ticket-msg'}>
            <div className="small muted">
              {m.author_name} · {dateTime(m.created_at)} {m.internal && <Badge>Nota interna</Badge>}
            </div>
            <p style={{ whiteSpace: 'pre-wrap', margin: '8px 0 0' }}>{m.body}</p>
            {m.has_file && (
              <a className="btn btn-sm" style={{ marginTop: 8 }} href={`/api/tickets/${id}/messages/${m.id}/file`} target="_blank" rel="noreferrer">
                {m.filename ?? 'Adjunto'}
              </a>
            )}
          </Card>
        ))}
      </div>
      {t.status !== 'closed' ? (
        <Card title="Responder" className="ticket-reply">
          <form onSubmit={send}>
            <Field label="Mensaje">
              <textarea required rows={4} maxLength={10000} value={body} onChange={(e) => setBody(e.target.value)} />
            </Field>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <input type="file" accept="image/*,application/pdf,text/plain" onChange={(e) => setFile(e.target.files?.[0] ?? null)} aria-label="Adjunto" />
              <div className="row">
                {t.canManage && (
                  <label className="check" style={{ margin: 0 }}>
                    <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> Nota interna (no la ve la persona)
                  </label>
                )}
                {!t.canManage && t.status === 'resolved' && (
                  <button type="button" className="btn btn-ghost" onClick={() => patch({ status: 'closed' })}>
                    Cerrar consulta
                  </button>
                )}
                <button className="btn btn-primary" disabled={action.busy}>
                  Enviar
                </button>
              </div>
            </div>
          </form>
        </Card>
      ) : (
        <p className="muted" style={{ marginTop: 16 }}>
          Esta consulta está cerrada. Si necesitas algo más, abre una nueva.
        </p>
      )}
    </>
  );
}
