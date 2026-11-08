'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { Badge, Card, ErrorBox, Notice, PageHeader, useAction, useLoad } from '@/components/ui';
import { api } from '@/lib/api';

export default function BatchPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const batch = useLoad(() => api.get(`/payslips/batches/${id}`), [id]);
  const b = batch.data;
  const people = useLoad(
    () => (b ? api.get<any[]>(`/org/employees?companyId=${b.company_id}&includeInactive=true`) : Promise.resolve([])),
    [b?.company_id],
  );
  const [preview, setPreview] = useState<number | null>(null);
  const action = useAction();
  const editable = b?.status === 'review';

  const review = (pageId: string, status: string, personId?: string | null) =>
    action.run(async () => {
      await api.post(`/payslips/batches/${id}/pages/${pageId}`, { status, personId });
      await batch.reload();
    });

  if (!b) return <ErrorBox error={batch.error} />;
  const pending = b.pages.filter((p: any) => p.review_status === 'pending').length;
  const withSuggestion = b.pages.filter((p: any) => p.review_status === 'pending' && p.suggested_person_id).length;
  const uniquePeople = new Map<string, any>();
  for (const p of people.data ?? []) if (p.national_id || p.first_name) uniquePeople.set(p.person_id, p);

  return (
    <>
      <PageHeader
        title={`Nóminas ${b.period} · ${b.company_name}`}
        subtitle={<Link href="/documentos">← Volver a documentos</Link>}
        actions={
          editable && (
            <>
              {withSuggestion > 0 && (
                <button className="btn" disabled={action.busy} onClick={() => action.run(async () => (await api.post(`/payslips/batches/${id}/confirm-suggestions`), batch.reload()))}>
                  Confirmar {withSuggestion} sugerencia(s)
                </button>
              )}
              <button
                className="btn btn-primary"
                disabled={action.busy || pending > 0}
                title={pending ? 'Revisa todas las páginas antes de publicar' : ''}
                onClick={() =>
                  confirm('Se publicarán las nóminas y cada persona recibirá un aviso. ¿Continuar?') &&
                  action.run(async () => {
                    const r = await api.post(`/payslips/batches/${id}/publish`);
                    alert(`Publicadas las nóminas de ${r.people} persona(s).`);
                    await batch.reload();
                  })
                }
              >
                Publicar
              </button>
              <button
                className="btn btn-danger"
                disabled={action.busy}
                onClick={() => confirm('¿Descartar este lote?') && action.run(async () => (await api.post(`/payslips/batches/${id}/discard`), router.push('/documentos')))}
              >
                Descartar
              </button>
            </>
          )
        }
      />
      <ErrorBox error={action.error} />
      {editable ? (
        <Notice tone={pending ? 'warning' : 'success'}>
          {pending
            ? `Quedan ${pending} de ${b.page_count} páginas por revisar. Comprueba cada sugerencia: una nómina enviada a quien no corresponde es una brecha de datos.`
            : 'Todas las páginas están revisadas. Ya puedes publicar.'}
        </Notice>
      ) : (
        <Notice tone="success">Lote {b.status === 'published' ? 'publicado' : 'descartado'}.</Notice>
      )}
      <div className="grid grid-2">
        <Card title="Páginas">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="num">Pág.</th>
                  <th>DNI detectado</th>
                  <th>Asignar a</th>
                  <th>Estado</th>
                </tr>
              </thead>
              <tbody>
                {b.pages.map((p: any) => (
                  <tr key={p.id} style={{ background: preview === p.page_number ? 'var(--primary-soft)' : undefined }}>
                    <td className="num">
                      <button className="btn btn-sm btn-ghost" onClick={() => setPreview(p.page_number)}>
                        {p.page_number}
                      </button>
                    </td>
                    <td className="small mono">{p.detected_ids.join(', ') || '—'}</td>
                    <td>
                      {editable ? (
                        <select
                          value={p.person_id ?? p.suggested_person_id ?? ''}
                          onChange={(e) => review(p.id, e.target.value ? 'confirmed' : 'pending', e.target.value || null)}
                          disabled={action.busy}
                        >
                          <option value="">— Sin asignar —</option>
                          {[...uniquePeople.values()].map((e) => (
                            <option key={e.person_id} value={e.person_id}>
                              {e.last_name}, {e.first_name} {e.national_id ? `(${e.national_id})` : ''}
                            </option>
                          ))}
                        </select>
                      ) : (
                        p.person_name ?? '—'
                      )}
                    </td>
                    <td>
                      <div className="row" style={{ gap: 4 }}>
                        {p.review_status === 'confirmed' && <Badge tone="success">Confirmada</Badge>}
                        {p.review_status === 'skipped' && <Badge>No es nómina</Badge>}
                        {p.review_status === 'pending' && <Badge tone="warning">{p.suggested_person_id ? 'Sugerida' : 'Pendiente'}</Badge>}
                        {editable && p.review_status === 'pending' && p.suggested_person_id && (
                          <button className="btn btn-sm" disabled={action.busy} onClick={() => review(p.id, 'confirmed', p.suggested_person_id)}>
                            ✓
                          </button>
                        )}
                        {editable && p.review_status !== 'skipped' && (
                          <button className="btn btn-sm btn-ghost" disabled={action.busy} title="Marcar como página sin nómina" onClick={() => review(p.id, 'skipped')}>
                            Omitir
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        <Card title={preview ? `Página ${preview}` : 'Vista previa'}>
          {preview ? (
            <iframe className="pdf-frame" src={`/api/payslips/batches/${id}/pages/${preview}/pdf`} title={`Página ${preview}`} />
          ) : (
            <p className="muted">Pulsa el número de una página para verla y comprobar a quién corresponde.</p>
          )}
        </Card>
      </div>
    </>
  );
}
