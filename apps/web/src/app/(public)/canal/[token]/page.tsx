'use client';

import { useParams } from 'next/navigation';
import { FormEvent, useState } from 'react';
import { Badge, ErrorBox, Field, Notice, Tabs, useAction, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';

const STATUS: Record<string, string> = {
  received: 'Recibida',
  acknowledged: 'Acuse de recibo enviado',
  investigating: 'En investigación',
  resolved: 'Resuelta',
  dismissed: 'Archivada',
};

/** Canal de denuncias público: no necesita cuenta y no guarda la IP con la denuncia. */
export default function WhistleblowingPublicPage() {
  const { token } = useParams<{ token: string }>();
  const info = useLoad(() => api.get(`/public/whistleblowing/${token}`), [token]);
  const [tab, setTab] = useState<'nueva' | 'seguimiento'>('nueva');
  if (info.error) {
    return (
      <div className="auth-page">
        <div className="card auth-card">
          <ErrorBox error="Este canal no existe o ya no está activo." />
        </div>
      </div>
    );
  }
  return (
    <div className="auth-page">
      <div className="card" style={{ width: 'min(680px, 100%)' }}>
        <div className="brand">
          <span className="brand-mark">O</span>
          <div>
            <strong>Canal de denuncias</strong>
            <small style={{ display: 'block', color: 'var(--muted)' }}>{info.data?.organization}</small>
          </div>
        </div>
        <p className="muted">
          Comunica de forma confidencial irregularidades o incumplimientos (Ley 2/2023). Puedes hacerlo de forma anónima. Te daremos un código para
          seguir tu comunicación y hablar con la persona responsable; guárdalo bien, no se puede recuperar.
        </p>
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'nueva', label: 'Nueva comunicación' },
            { id: 'seguimiento', label: 'Tengo un código' },
          ]}
        />
        {tab === 'nueva' ? <NewReport token={token} categories={info.data?.categories ?? []} /> : <FollowUp token={token} />}
      </div>
    </div>
  );
}

function NewReport({ token, categories }: { token: string; categories: string[] }) {
  const [f, setF] = useState({ category: '', subject: '', description: '', anonymous: true, contact: '' });
  const [code, setCode] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await api.post(`/public/whistleblowing/${token}/reports`, { ...f, category: f.category || categories[0], contact: f.anonymous ? undefined : f.contact });
      setCode(r.code);
    });
  };
  if (code) {
    return (
      <Notice tone="success">
        Comunicación enviada. Tu código de seguimiento es:
        <div className="mono" style={{ fontSize: '1.3rem', margin: '10px 0' }}>
          {code}
        </div>
        Guárdalo: lo necesitarás para consultar el estado y responder a la persona responsable. Recibirás un acuse de recibo en un máximo de 7 días.
      </Notice>
    );
  }
  return (
    <form onSubmit={submit}>
      <ErrorBox error={error} />
      <Field label="Tipo">
        <select value={f.category || categories[0]} onChange={(e) => setF({ ...f, category: e.target.value })}>
          {categories.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </Field>
      <Field label="Asunto">
        <input required minLength={3} maxLength={200} value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} />
      </Field>
      <Field label="Qué ha pasado" hint="Cuándo, dónde, quién está implicado y cómo lo sabes. No incluyas datos que no sean necesarios.">
        <textarea required minLength={20} rows={8} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
      </Field>
      <label className="check">
        <input type="checkbox" checked={f.anonymous} onChange={(e) => setF({ ...f, anonymous: e.target.checked })} /> Quiero que sea anónima
      </label>
      {!f.anonymous && (
        <Field label="Tu nombre y cómo contactarte">
          <input required value={f.contact} onChange={(e) => setF({ ...f, contact: e.target.value })} />
        </Field>
      )}
      <p className="muted small">Está prohibida cualquier represalia contra quien comunica de buena fe (art. 36 de la Ley 2/2023).</p>
      <button className="btn btn-primary" disabled={busy}>
        Enviar comunicación
      </button>
    </form>
  );
}

function FollowUp({ token }: { token: string }) {
  const [code, setCode] = useState('');
  const [report, setReport] = useState<any | null>(null);
  const [message, setMessage] = useState('');
  const { busy, error, run } = useAction();
  const load = () => run(async () => setReport(await api.post(`/public/whistleblowing/${token}/status`, { code })));
  return (
    <>
      <ErrorBox error={error} />
      {!report ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void load();
          }}
        >
          <Field label="Código de seguimiento">
            <input required className="mono" value={code} onChange={(e) => setCode(e.target.value)} placeholder="ABCDE-FGHJK-LMNPQ-RSTUV" autoComplete="off" />
          </Field>
          <button className="btn btn-primary" disabled={busy}>
            Consultar
          </button>
        </form>
      ) : (
        <>
          <div className="spread">
            <strong>{report.subject}</strong>
            <Badge tone={['resolved', 'dismissed'].includes(report.status) ? 'success' : 'warning'}>{STATUS[report.status]}</Badge>
          </div>
          <p className="small muted">
            {report.category} · enviada el {dateTime(report.receivedAt)}
          </p>
          {report.resolution && <Notice>Resolución: {report.resolution}</Notice>}
          <ul className="list">
            {report.messages.map((m: any, i: number) => (
              <li key={i}>
                <strong>{m.author === 'handler' ? 'Persona responsable' : 'Tú'}</strong> <span className="small muted">{dateTime(m.createdAt)}</span>
                <div className="announcement-body">{m.body}</div>
              </li>
            ))}
          </ul>
          {!['resolved', 'dismissed'].includes(report.status) && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  await api.post(`/public/whistleblowing/${token}/messages`, { code, body: message });
                  setMessage('');
                  setReport(await api.post(`/public/whistleblowing/${token}/status`, { code }));
                });
              }}
            >
              <Field label="Añadir información">
                <textarea required value={message} onChange={(e) => setMessage(e.target.value)} />
              </Field>
              <button className="btn btn-primary" disabled={busy}>
                Enviar
              </button>
            </form>
          )}
        </>
      )}
    </>
  );
}
