'use client';

import Link from 'next/link';
import { FormEvent, useState } from 'react';
import { IconButton } from '@/components/icons';
import { Badge, Card, Empty, ErrorBox, Field, Modal, PageHeader, Tabs, useAction, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useSession } from '@/lib/session';

const TICKET_STATUS: Record<string, { label: string; tone: any }> = {
  open: { label: 'Abierta', tone: 'warning' },
  in_progress: { label: 'En curso', tone: 'info' },
  waiting: { label: 'Esperando respuesta', tone: 'warning' },
  resolved: { label: 'Resuelta', tone: 'success' },
  closed: { label: 'Cerrada', tone: 'neutral' },
};

export default function TicketsPage() {
  const { me } = useSession();
  const [tab, setTab] = useState<'mias' | 'bandeja'>(me.isHr ? 'bandeja' : 'mias');
  return (
    <>
      <PageHeader title="Consultas a RR. HH." subtitle="Pregunta sobre tu nómina, contrato, certificados o cualquier otra cosa." />
      {me.isHr && (
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'bandeja', label: 'Bandeja de RR. HH.' },
            { id: 'mias', label: 'Mis consultas' },
          ]}
        />
      )}
      {tab === 'mias' ? <Mine /> : <Queue />}
    </>
  );
}

function TicketTable({ rows, showRequester }: { rows: any[]; showRequester?: boolean }) {
  return (
    <table>
      <thead>
        <tr>
          <th>Consulta</th>
          {showRequester && <th>Persona</th>}
          <th>Estado</th>
          <th>Actualizada</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((t) => (
          <tr key={t.id}>
            <td>
              <Link href={`/consultas/${t.id}`}>
                #{t.number} · {t.subject}
              </Link>
              <div className="small muted">
                {t.category_name}
                {t.priority === 'high' && ' · prioridad alta'}
              </div>
            </td>
            {showRequester && (
              <td>
                {t.requester_name}
                <div className="small muted">
                  {t.company_name}
                  {t.assignee_name ? ` · lleva ${t.assignee_name}` : ' · sin asignar'}
                </div>
              </td>
            )}
            <td>
              <Badge tone={TICKET_STATUS[t.status].tone}>{TICKET_STATUS[t.status].label}</Badge>
            </td>
            <td className="small">{dateTime(t.updated_at)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Mine() {
  const { data, error, reload } = useLoad(() => api.get<any[]>('/tickets/mine'));
  const [creating, setCreating] = useState(false);
  return (
    <Card
      actions={
        <IconButton icon="plus" className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
          Nueva consulta
        </IconButton>
      }
    >
      <ErrorBox error={error} />
      {data?.length ? <TicketTable rows={data} /> : <Empty>No has hecho ninguna consulta.</Empty>}
      {creating && <NewTicket onClose={() => setCreating(false)} onDone={reload} />}
    </Card>
  );
}

function Queue() {
  const [status, setStatus] = useState('active');
  const [mine, setMine] = useState(false);
  const { data, error } = useLoad(() => api.get<any[]>(`/tickets?status=${status}&mine=${mine}`), [status, mine]);
  return (
    <Card>
      <div className="row" style={{ marginBottom: 12 }}>
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Estado">
          <option value="active">Pendientes</option>
          {Object.entries(TICKET_STATUS).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </select>
        <label className="check" style={{ margin: 0 }}>
          <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Solo las mías
        </label>
      </div>
      <ErrorBox error={error} />
      {data?.length ? <TicketTable rows={data} showRequester /> : <Empty>No hay consultas en esta vista.</Empty>}
    </Card>
  );
}

function NewTicket({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<void> }) {
  const { me } = useSession();
  const cats = useLoad(() => api.get<any[]>('/tickets/categories'));
  const companies = [...new Map(me.employments.map((e) => [e.company_id, e.company_name])).entries()];
  const [f, setF] = useState({ companyId: companies[0]?.[0] ?? '', categoryId: '', subject: '', body: '' });
  const [file, setFile] = useState<File | null>(null);
  const { busy, error, run } = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const form = new FormData();
      Object.entries(f).forEach(([k, v]) => v && form.set(k, v));
      if (file) form.set('file', file);
      await api.upload('/tickets', form);
      await onDone();
      onClose();
    });
  };
  return (
    <Modal title="Nueva consulta" onClose={onClose}>
      <form onSubmit={submit}>
        <ErrorBox error={error || cats.error} />
        {companies.length > 1 && (
          <Field label="Sociedad">
            <select value={f.companyId} onChange={(e) => setF({ ...f, companyId: e.target.value })}>
              {companies.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Tema">
          <select required value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value })}>
            <option value="">Elige…</option>
            {cats.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Asunto">
          <input required maxLength={200} value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} />
        </Field>
        <Field label="Explícalo">
          <textarea required rows={5} maxLength={10000} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} />
        </Field>
        <Field label="Adjunto (opcional)" hint="Foto, PDF o texto, hasta 10 MB.">
          <input type="file" accept="image/*,application/pdf,text/plain" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </Field>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-primary" disabled={busy}>
            Enviar
          </button>
        </div>
      </form>
    </Modal>
  );
}
