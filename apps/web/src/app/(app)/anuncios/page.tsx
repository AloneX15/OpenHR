'use client';

import { FormEvent, useState } from 'react';
import { IconButton } from '@/components/icons';
import { Badge, Card, Empty, ErrorBox, Field, Modal, PageHeader, useAction, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useSession } from '@/lib/session';

export default function AnnouncementsPage() {
  const { me } = useSession();
  const [archived, setArchived] = useState(false);
  const { data, error, reload } = useLoad(() => api.get<any[]>(`/announcements?archived=${archived}`), [archived]);
  const [creating, setCreating] = useState(false);
  const action = useAction();

  const markRead = (id: string) => action.run(async () => (await api.post(`/announcements/${id}/read`), reload()));

  return (
    <>
      <PageHeader
        title="Anuncios"
        subtitle="Novedades de la empresa."
        actions={
          me.isHr && (
            <>
              <label className="check" style={{ margin: 0 }}>
                <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Ver archivados
              </label>
              <IconButton icon="plus" className="btn btn-primary" onClick={() => setCreating(true)}>
                Nuevo anuncio
              </IconButton>
            </>
          )
        }
      />
      <ErrorBox error={error || action.error} />
      {data?.length ? (
        <div className="stack">
          {data.map((a) => (
            <Card
              key={a.id}
              className={a.read ? '' : 'unread'}
              title={
                <>
                  {a.pinned && <Badge tone="info">Fijado</Badge>} {a.title} {!a.read && <Badge tone="warning">Nuevo</Badge>} {a.archived && <Badge>Archivado</Badge>}
                </>
              }
              actions={
                <div className="row">
                  {!a.read && (
                    <button className="btn btn-sm" disabled={action.busy} onClick={() => markRead(a.id)}>
                      Marcar como leído
                    </button>
                  )}
                  {me.isHr && (
                    <button
                      className="btn btn-sm btn-ghost"
                      disabled={action.busy}
                      onClick={() => action.run(async () => (await api.patch(`/announcements/${a.id}`, { archived: !a.archived }), reload()))}
                    >
                      {a.archived ? 'Restaurar' : 'Archivar'}
                    </button>
                  )}
                </div>
              }
            >
              <p className="announcement-body">{a.body}</p>
              <p className="small muted">
                {a.author} · {dateTime(a.published_at)} · {a.company_name ?? 'Todo el grupo'}
                {me.isHr && ` · leído por ${a.reads}`}
              </p>
            </Card>
          ))}
        </div>
      ) : (
        <Empty>No hay anuncios.</Empty>
      )}
      {creating && <AnnouncementModal onClose={() => setCreating(false)} onDone={reload} />}
    </>
  );
}

function AnnouncementModal({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<void> }) {
  const { me } = useSession();
  const companies = useLoad(() => api.get<any[]>('/org/companies'));
  const canAll = me.isAdmin || me.hrCompanyIds === null;
  const [f, setF] = useState({ companyId: '', title: '', body: '', pinned: false, expiresAt: '', notify: true });
  const { busy, error, run } = useAction();
  const visible = (companies.data ?? []).filter((c) => me.hrCompanyIds === null || me.hrCompanyIds.includes(c.id));
  const companyId = f.companyId || (canAll ? '' : visible[0]?.id ?? '');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api.post('/announcements', { ...f, companyId: companyId || null, expiresAt: f.expiresAt || undefined });
      await onDone();
      onClose();
    });
  };
  return (
    <Modal title="Nuevo anuncio" onClose={onClose}>
      <form onSubmit={submit}>
        <ErrorBox error={error} />
        <Field label="Para">
          <select value={companyId} onChange={(e) => setF({ ...f, companyId: e.target.value })}>
            {canAll && <option value="">Todo el grupo</option>}
            {visible.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Título">
          <input required maxLength={200} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
        </Field>
        <Field label="Texto">
          <textarea required rows={6} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} />
        </Field>
        <Field label="Caduca (opcional)">
          <input type="date" value={f.expiresAt} onChange={(e) => setF({ ...f, expiresAt: e.target.value })} />
        </Field>
        <label className="check">
          <input type="checkbox" checked={f.pinned} onChange={(e) => setF({ ...f, pinned: e.target.checked })} /> Fijar arriba
        </label>
        <label className="check">
          <input type="checkbox" checked={f.notify} onChange={(e) => setF({ ...f, notify: e.target.checked })} /> Avisar también por email
        </label>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-primary" disabled={busy}>
            Publicar
          </button>
        </div>
      </form>
    </Modal>
  );
}
