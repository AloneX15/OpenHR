'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FormEvent, useState } from 'react';
import { Badge, Card, Empty, ErrorBox, Field, Modal, PageHeader, Tabs, useAction, useLoad } from '@/components/ui';
import { api, download } from '@/lib/api';
import { CATEGORY_LABEL, dateTime, todayIso } from '@/lib/format';
import { useSession } from '@/lib/session';

type Tab = 'mios' | 'nominas';

export default function DocumentsPage() {
  const { me } = useSession();
  const [tab, setTab] = useState<Tab>('mios');
  return (
    <>
      <PageHeader title="Documentos" subtitle="Tus nóminas, contratos y certificados." />
      {me.isHr && (
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'mios', label: 'Mis documentos' },
            { id: 'nominas', label: 'Reparto de nóminas' },
          ]}
        />
      )}
      {tab === 'mios' ? <MyDocuments /> : <PayslipBatches />}
    </>
  );
}

function MyDocuments() {
  const { data, error, reload } = useLoad(() => api.get<any[]>('/documents/mine'));
  const action = useAction();
  return (
    <Card>
      <ErrorBox error={error || action.error} />
      {data?.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Documento</th>
                <th>Tipo</th>
                <th>Publicado</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.id}>
                  <td>
                    {d.title} {!d.first_read_at && <Badge tone="info">Nuevo</Badge>}
                  </td>
                  <td>{CATEGORY_LABEL[d.category]}</td>
                  <td>{dateTime(d.published_at)}</td>
                  <td className="num">
                    <button className="btn btn-sm" disabled={action.busy} onClick={() => action.run(async () => (await download(`/documents/${d.id}/download`), reload()))}>
                      Descargar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>Aún no tienes documentos.</Empty>
      )}
    </Card>
  );
}

function PayslipBatches() {
  const { data, error } = useLoad(() => api.get<any[]>('/payslips/batches'));
  const [uploading, setUploading] = useState(false);
  return (
    <Card
      title="Lotes de nóminas"
      actions={
        <button className="btn btn-primary" onClick={() => setUploading(true)}>
          Subir PDF de nóminas
        </button>
      }
    >
      <p className="muted">
        Sube el PDF que te envía la gestoría con todas las nóminas de una sociedad. OpenHR propone a quién va cada página buscando su DNI/NIE, pero
        nada se publica hasta que revises todas las páginas.
      </p>
      <ErrorBox error={error} />
      {data?.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Sociedad</th>
                <th>Periodo</th>
                <th className="num">Páginas</th>
                <th>Estado</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.map((b) => (
                <tr key={b.id}>
                  <td>{b.company_name}</td>
                  <td>{b.period}</td>
                  <td className="num">{b.page_count}</td>
                  <td>
                    {b.status === 'review' ? (
                      <Badge tone="warning">{b.pending_pages} por revisar</Badge>
                    ) : b.status === 'published' ? (
                      <Badge tone="success">Publicado</Badge>
                    ) : (
                      <Badge>Descartado</Badge>
                    )}
                  </td>
                  <td className="num">
                    <Link className="btn btn-sm" href={`/documentos/lotes/${b.id}`}>
                      {b.status === 'review' ? 'Revisar' : 'Ver'}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>Todavía no has subido nóminas.</Empty>
      )}
      {uploading && <UploadBatchModal onClose={() => setUploading(false)} />}
    </Card>
  );
}

function UploadBatchModal({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const companies = useLoad(() => api.get<any[]>('/org/companies'));
  const [companyId, setCompanyId] = useState('');
  const today = todayIso();
  const prev = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 2, 1)).toISOString().slice(0, 7);
  const [period, setPeriod] = useState(prev);
  const [file, setFile] = useState<File | null>(null);
  const { busy, error, run } = useAction();
  const company = companyId || companies.data?.[0]?.id || '';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    void run(async () => {
      const form = new FormData();
      form.set('companyId', company);
      form.set('period', period);
      form.set('file', file);
      const r = await api.upload('/payslips/batches', form);
      router.push(`/documentos/lotes/${r.id}`);
    });
  };
  return (
    <Modal title="Subir nóminas" onClose={onClose}>
      <form onSubmit={submit}>
        <ErrorBox error={error} />
        <Field label="Sociedad">
          <select value={company} onChange={(e) => setCompanyId(e.target.value)}>
            {companies.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.tax_id})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Mes">
          <input type="month" required value={period} onChange={(e) => setPeriod(e.target.value)} />
        </Field>
        <Field label="PDF con todas las nóminas">
          <input type="file" accept="application/pdf" required onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </Field>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-primary" disabled={busy || !file}>
            {busy ? 'Analizando…' : 'Subir y analizar'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
