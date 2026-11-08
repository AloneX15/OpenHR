'use client';

import Link from 'next/link';
import { FormEvent, useState } from 'react';
import { IconButton } from '@/components/icons';
import { Badge, Card, Empty, ErrorBox, Field, Modal, Notice, PageHeader, Tabs, useAction, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import { dateTime, dayLabel } from '@/lib/format';
import { useSession } from '@/lib/session';

const STATUS: Record<string, { label: string; tone: any }> = {
  draft: { label: 'Borrador', tone: 'neutral' },
  open: { label: 'Abierta', tone: 'success' },
  closed: { label: 'Cerrada', tone: 'info' },
};
const KINDS: Record<string, string> = { scale: 'Escala del 1 al 5', enps: 'eNPS (0 a 10)', choice: 'Opción única', text: 'Texto libre' };

export default function SurveysPage() {
  const { me } = useSession();
  const [tab, setTab] = useState<'mias' | 'gestion'>('mias');
  return (
    <>
      <PageHeader title="Encuestas" subtitle="Tu opinión sobre el trabajo y la empresa." />
      {me.isHr && (
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'mias', label: 'Para responder' },
            { id: 'gestion', label: 'Gestionar' },
          ]}
        />
      )}
      {tab === 'mias' ? <Mine /> : <Manage />}
    </>
  );
}

function Mine() {
  const { data, error } = useLoad(() => api.get<any[]>('/surveys/mine'));
  return (
    <Card>
      <ErrorBox error={error} />
      {data?.length ? (
        <ul className="list">
          {data.map((s) => (
            <li key={s.id} className="row" style={{ justifyContent: 'space-between', padding: '10px 0' }}>
              <div>
                <strong>{s.title}</strong> {s.anonymous && <Badge tone="info">Anónima</Badge>}
                <div className="small muted">{s.closes_on ? `Hasta el ${dayLabel(s.closes_on)}` : `Desde ${dateTime(s.opened_at)}`}</div>
              </div>
              {s.answered ? (
                <Badge tone="success">Respondida</Badge>
              ) : (
                <Link className="btn btn-primary btn-sm" href={`/encuestas/${s.id}`}>
                  Responder
                </Link>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <Empty>No hay encuestas abiertas para ti.</Empty>
      )}
    </Card>
  );
}

function Manage() {
  const { data, error, reload } = useLoad(() => api.get<any[]>('/surveys'));
  const [editing, setEditing] = useState<any | null>(null);
  const [results, setResults] = useState<string | null>(null);
  const action = useAction();
  const act = (id: string, what: string) => action.run(async () => (await api.post(`/surveys/${id}/${what}`), reload()));
  return (
    <Card
      actions={
        <IconButton icon="plus" className="btn btn-primary btn-sm" onClick={() => setEditing({})}>
          Nueva encuesta
        </IconButton>
      }
    >
      <ErrorBox error={error || action.error} />
      {data?.length ? (
        <table>
          <thead>
            <tr>
              <th>Encuesta</th>
              <th>Estado</th>
              <th className="num">Respuestas</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data.map((s) => (
              <tr key={s.id}>
                <td>
                  {s.title}
                  <div className="small muted">
                    {s.company_name ?? 'Todo el grupo'} · {s.anonymous ? 'anónima' : 'con nombre'}
                  </div>
                </td>
                <td>
                  <Badge tone={STATUS[s.status].tone}>{STATUS[s.status].label}</Badge>
                </td>
                <td className="num">{s.responses}</td>
                <td className="num">
                  {s.status === 'draft' && (
                    <>
                      <button className="btn btn-ghost btn-sm" onClick={() => action.run(async () => setEditing(await api.get(`/surveys/${s.id}`)))}>
                        Editar
                      </button>{' '}
                      <button className="btn btn-primary btn-sm" disabled={action.busy} onClick={() => confirm('Se avisará a todas las personas de la encuesta. ¿Lanzarla?') && act(s.id, 'open')}>
                        Lanzar
                      </button>
                    </>
                  )}
                  {s.status === 'open' && (
                    <button className="btn btn-ghost btn-sm" disabled={action.busy} onClick={() => act(s.id, 'close')}>
                      Cerrar
                    </button>
                  )}{' '}
                  {s.status !== 'draft' && (
                    <button className="btn btn-sm" onClick={() => setResults(s.id)}>
                      Resultados
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>Aún no hay encuestas. Empieza por una de clima con eNPS.</Empty>
      )}
      {editing && <SurveyModal s={editing} onClose={() => setEditing(null)} onDone={reload} />}
      {results && <ResultsModal id={results} onClose={() => setResults(null)} />}
    </Card>
  );
}

const TEMPLATE = [
  { kind: 'enps', text: '¿Recomendarías esta empresa como lugar para trabajar a un amigo o familiar?', options: [], required: true },
  { kind: 'scale', text: 'Me siento valorado por mi trabajo', options: [], required: true },
  { kind: 'scale', text: 'Tengo lo que necesito para hacer bien mi trabajo', options: [], required: true },
  { kind: 'scale', text: 'Mi responsable me ayuda a mejorar', options: [], required: true },
  { kind: 'text', text: '¿Qué cambiarías?', options: [], required: false },
];

function SurveyModal({ s, onClose, onDone }: { s: any; onClose: () => void; onDone: () => Promise<void> }) {
  const companies = useLoad(() => api.get<any[]>('/org/companies'));
  const [f, setF] = useState({
    title: s.title ?? 'Encuesta de clima',
    description: s.description ?? '',
    companyId: s.company_id ?? '',
    anonymous: s.anonymous ?? true,
    minResponses: s.min_responses ?? 5,
    closesOn: s.closes_on ?? '',
    questions: (s.questions ?? TEMPLATE).map((q: any) => ({ kind: q.kind, text: q.text, options: (q.options ?? []).join(', '), required: q.required })),
  });
  const { busy, error, run } = useAction();
  const setQ = (i: number, patch: any) => setF({ ...f, questions: f.questions.map((q: any, j: number) => (i === j ? { ...q, ...patch } : q)) });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const body = {
        title: f.title,
        description: f.description || undefined,
        companyId: f.companyId || null,
        anonymous: f.anonymous,
        minResponses: Number(f.minResponses),
        closesOn: f.closesOn || null,
        questions: f.questions.map((q: any) => ({ kind: q.kind, text: q.text, required: q.required, options: q.kind === 'choice' ? q.options.split(',').map((o: string) => o.trim()).filter(Boolean) : [] })),
      };
      if (s.id) await api.put(`/surveys/${s.id}`, body);
      else await api.post('/surveys', body);
      await onDone();
      onClose();
    });
  };
  return (
    <Modal title={s.id ? 'Editar encuesta' : 'Nueva encuesta'} onClose={onClose}>
      <form onSubmit={submit}>
        <ErrorBox error={error} />
        <Field label="Título">
          <input required maxLength={200} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
        </Field>
        <Field label="Introducción (opcional)">
          <textarea rows={2} maxLength={2000} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </Field>
        <div className="grid grid-2" style={{ gap: 12 }}>
          <Field label="Para">
            <select value={f.companyId} onChange={(e) => setF({ ...f, companyId: e.target.value })}>
              <option value="">Todo el grupo</option>
              {companies.data?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Cierra el (opcional)">
            <input type="date" value={f.closesOn} onChange={(e) => setF({ ...f, closesOn: e.target.value })} />
          </Field>
        </div>
        <label className="check">
          <input type="checkbox" checked={f.anonymous} onChange={(e) => setF({ ...f, anonymous: e.target.checked })} /> Anónima: no se guarda quién responde qué
        </label>
        {f.anonymous && (
          <Field label="Mínimo de respuestas para ver resultados" hint="Con menos, se podría adivinar quién ha dicho qué.">
            <input type="number" min={3} max={50} value={f.minResponses} onChange={(e) => setF({ ...f, minResponses: e.target.value })} />
          </Field>
        )}
        <h3>Preguntas</h3>
        {f.questions.map((q: any, i: number) => (
          <fieldset key={i} className="fieldset">
            <legend>Pregunta {i + 1}</legend>
            <div className="grid grid-2" style={{ gap: 8 }}>
              <select value={q.kind} onChange={(e) => setQ(i, { kind: e.target.value })} aria-label="Tipo">
                {Object.entries(KINDS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
              <label className="check" style={{ margin: 0 }}>
                <input type="checkbox" checked={q.required} onChange={(e) => setQ(i, { required: e.target.checked })} /> Obligatoria
              </label>
            </div>
            <input required maxLength={500} value={q.text} onChange={(e) => setQ(i, { text: e.target.value })} aria-label="Texto de la pregunta" style={{ marginTop: 8 }} />
            {q.kind === 'choice' && <input required placeholder="Opciones separadas por comas" value={q.options} onChange={(e) => setQ(i, { options: e.target.value })} style={{ marginTop: 8 }} />}
            <button type="button" className="btn btn-ghost btn-sm" disabled={f.questions.length === 1} onClick={() => setF({ ...f, questions: f.questions.filter((_: any, j: number) => j !== i) })}>
              Quitar
            </button>
          </fieldset>
        ))}
        <button type="button" className="btn btn-sm" onClick={() => setF({ ...f, questions: [...f.questions, { kind: 'scale', text: '', options: '', required: true }] })}>
          Añadir pregunta
        </button>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-primary" disabled={busy}>
            Guardar borrador
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Bar({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max ? Math.round((value / max) * 100) : 0;
  return (
    <div className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
      <span className="small" style={{ width: 90, flexShrink: 0 }}>
        {label}
      </span>
      <div style={{ flex: 1, background: 'var(--surface-2)', borderRadius: 6, height: 10 }} aria-hidden>
        <div style={{ width: `${pct}%`, background: 'var(--accent)', borderRadius: 6, height: 10 }} />
      </div>
      <span className="small num" style={{ width: 32 }}>
        {value}
      </span>
    </div>
  );
}

function ResultsModal({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, error } = useLoad(() => api.get<any>(`/surveys/${id}/results`));
  return (
    <Modal title={data?.survey.title ?? 'Resultados'} onClose={onClose}>
      <ErrorBox error={error} />
      {data && (
        <>
          <p className="muted">
            {data.responses} respuesta(s) de {data.audience} persona(s) ({data.audience ? Math.round((data.responses / data.audience) * 100) : 0} % de participación).
          </p>
          {data.hidden ? (
            <Notice>Es anónima: los resultados se verán cuando haya al menos {data.survey.minResponses} respuestas.</Notice>
          ) : (
            <div className="stack">
              {data.questions.map((q: any) => (
                <div key={q.id}>
                  <strong>{q.text}</strong>
                  {q.kind === 'enps' && q.enps !== null && (
                    <p>
                      eNPS <strong>{q.enps > 0 ? `+${q.enps}` : q.enps}</strong>
                      <span className="small muted">
                        {' '}
                        · {q.promoters} promotores, {q.passives} pasivos, {q.detractors} detractores
                      </span>
                    </p>
                  )}
                  {q.kind === 'scale' && q.average !== null && <p>Media {q.average.toLocaleString('es-ES')} / 5</p>}
                  {(q.kind === 'scale' || q.kind === 'enps') && q.distribution.map((d: any) => <Bar key={d.value} label={String(d.value)} value={d.count} max={q.answered} />)}
                  {q.kind === 'choice' && q.options.map((o: any) => <Bar key={o.option} label={o.option} value={o.count} max={q.answered} />)}
                  {q.kind === 'text' &&
                    (q.comments.length ? (
                      <ul>
                        {q.comments.map((c: string, i: number) => (
                          <li key={i}>{c}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="small muted">Sin comentarios.</p>
                    ))}
                </div>
              ))}
              {data.respondents && <p className="small muted">Respondieron: {data.respondents.map((r: any) => r.name).join(', ')}.</p>}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
