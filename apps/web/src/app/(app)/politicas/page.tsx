'use client';

import { FormEvent, useState } from 'react';
import { IconButton } from '@/components/icons';
import { Badge, Card, Empty, ErrorBox, Field, Modal, PageHeader, useAction, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useSession } from '@/lib/session';

export default function PoliciesPage() {
  const { me } = useSession();
  const { data, error, reload } = useLoad(() => api.get<any[]>('/policies'));
  const [reading, setReading] = useState<any | null>(null);
  const [publishing, setPublishing] = useState<any | null>(null);
  const [tracking, setTracking] = useState<any | null>(null);
  const pending = (data ?? []).filter((p) => p.requires_acceptance && !p.accepted_at).length;
  return (
    <>
      <PageHeader
        title="Políticas"
        subtitle={pending ? `Tienes ${pending} política(s) pendiente(s) de aceptar.` : 'Normas internas de la empresa.'}
        actions={
          me.isHr && (
            <IconButton icon="upload" className="btn btn-primary" onClick={() => setPublishing({})}>
              Publicar política
            </IconButton>
          )
        }
      />
      <ErrorBox error={error} />
      <Card>
        {data?.length ? (
          <table>
            <thead>
              <tr>
                <th>Política</th>
                <th>Ámbito</th>
                <th>Publicada</th>
                <th>Estado</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.map((p) => (
                <tr key={p.id}>
                  <td>
                    {p.title} <span className="small muted">v{p.version}</span>
                    {p.description && <div className="small muted">{p.description}</div>}
                  </td>
                  <td>{p.company_name ?? 'Todo el grupo'}</td>
                  <td>{dateTime(p.published_at)}</td>
                  <td>
                    {!p.requires_acceptance ? (
                      <Badge>Informativa</Badge>
                    ) : p.accepted_at ? (
                      <Badge tone="success">Aceptada el {dateTime(p.accepted_at)}</Badge>
                    ) : (
                      <Badge tone="warning">Pendiente</Badge>
                    )}
                  </td>
                  <td className="num">
                    <div className="row" style={{ justifyContent: 'flex-end' }}>
                      <button className="btn btn-sm" onClick={() => setReading(p)}>
                        {p.requires_acceptance && !p.accepted_at ? 'Leer y aceptar' : 'Ver'}
                      </button>
                      {me.isHr && (
                        <>
                          <button className="btn btn-sm btn-ghost" onClick={() => setTracking(p)}>
                            Seguimiento
                          </button>
                          <button className="btn btn-sm btn-ghost" onClick={() => setPublishing({ seriesId: p.series_id, title: p.title })}>
                            Nueva versión
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>No hay políticas publicadas.</Empty>
        )}
      </Card>
      {reading && <ReadModal policy={reading} onClose={() => setReading(null)} onDone={reload} />}
      {publishing && <PublishModal initial={publishing} onClose={() => setPublishing(null)} onDone={reload} />}
      {tracking && <TrackingModal policy={tracking} onClose={() => setTracking(null)} />}
    </>
  );
}

function ReadModal({ policy, onClose, onDone }: { policy: any; onClose: () => void; onDone: () => Promise<void> }) {
  const [agree, setAgree] = useState(false);
  const { busy, error, run } = useAction();
  const mustAccept = policy.requires_acceptance && !policy.accepted_at;
  return (
    <Modal title={`${policy.title} (v${policy.version})`} onClose={onClose}>
      <iframe className="pdf-frame" src={`/api/policies/${policy.id}/file`} title={policy.title} />
      <ErrorBox error={error} />
      {mustAccept && (
        <>
          <label className="check" style={{ marginTop: 12 }}>
            <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /> He leído esta política y la acepto.
          </label>
          <div className="modal-actions">
            <button className="btn" onClick={onClose}>
              Más tarde
            </button>
            <button
              className="btn btn-primary"
              disabled={!agree || busy}
              onClick={() =>
                run(async () => {
                  await api.post(`/policies/${policy.id}/accept`);
                  await onDone();
                  onClose();
                })
              }
            >
              Aceptar
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

function PublishModal({ initial, onClose, onDone }: { initial: any; onClose: () => void; onDone: () => Promise<void> }) {
  const { me } = useSession();
  const companies = useLoad(() => api.get<any[]>('/org/companies'));
  const canAll = me.isAdmin || me.hrCompanyIds === null;
  const visible = (companies.data ?? []).filter((c) => me.hrCompanyIds === null || me.hrCompanyIds.includes(c.id));
  const [f, setF] = useState({ companyId: '', title: initial.title ?? '', description: '', requiresAcceptance: true });
  const [file, setFile] = useState<File | null>(null);
  const { busy, error, run } = useAction();
  const companyId = f.companyId || (canAll ? '' : visible[0]?.id ?? '');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    void run(async () => {
      const form = new FormData();
      if (initial.seriesId) form.set('seriesId', initial.seriesId);
      else if (companyId) form.set('companyId', companyId);
      form.set('title', f.title);
      if (f.description) form.set('description', f.description);
      form.set('requiresAcceptance', String(f.requiresAcceptance));
      form.set('file', file);
      await api.upload('/policies', form);
      await onDone();
      onClose();
    });
  };
  return (
    <Modal title={initial.seriesId ? `Nueva versión de «${initial.title}»` : 'Publicar política'} onClose={onClose}>
      <form onSubmit={submit}>
        <ErrorBox error={error} />
        {initial.seriesId ? (
          <p className="muted">La versión anterior se archiva y todo el mundo tendrá que aceptar la nueva.</p>
        ) : (
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
        )}
        <Field label="Título">
          <input required value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Política de desconexión digital" />
        </Field>
        <Field label="Descripción (opcional)">
          <input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </Field>
        <Field label="PDF">
          <input type="file" accept="application/pdf" required onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </Field>
        <label className="check">
          <input type="checkbox" checked={f.requiresAcceptance} onChange={(e) => setF({ ...f, requiresAcceptance: e.target.checked })} /> Requiere aceptación
        </label>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-primary" disabled={busy || !file}>
            Publicar
          </button>
        </div>
      </form>
    </Modal>
  );
}

function TrackingModal({ policy, onClose }: { policy: any; onClose: () => void }) {
  const { data, error } = useLoad(() => api.get<any[]>(`/policies/${policy.id}/acceptances`), [policy.id]);
  const accepted = (data ?? []).filter((r) => r.accepted_at).length;
  return (
    <Modal title={`Seguimiento: ${policy.title} v${policy.version}`} onClose={onClose}>
      <ErrorBox error={error} />
      <p>
        {accepted} de {data?.length ?? 0} personas la han aceptado.
      </p>
      <ul className="list small">
        {(data ?? []).map((r) => (
          <li key={r.person_id} className="spread">
            <span>
              {r.name} <span className="muted">· {r.company_name}</span>
            </span>
            {r.accepted_at ? <Badge tone="success">{dateTime(r.accepted_at)}</Badge> : <Badge tone="warning">Pendiente</Badge>}
          </li>
        ))}
      </ul>
    </Modal>
  );
}
