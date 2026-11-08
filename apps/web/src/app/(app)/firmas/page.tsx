'use client';

import { FormEvent, useState } from 'react';
import { IconButton } from '@/components/icons';
import { Badge, Card, Empty, ErrorBox, Field, Modal, Notice, PageHeader, Tabs, useAction, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import { dateTime, dayLabel } from '@/lib/format';
import { useSession } from '@/lib/session';

const STATUS: Record<string, { label: string; tone: any }> = {
  pending: { label: 'Pendiente', tone: 'warning' },
  signed: { label: 'Firmado', tone: 'success' },
  declined: { label: 'Rechazado', tone: 'danger' },
  cancelled: { label: 'Anulado', tone: 'neutral' },
};

export default function SignaturesPage() {
  const { me } = useSession();
  const [tab, setTab] = useState<'mias' | 'todas'>('mias');
  return (
    <>
      <PageHeader title="Firmas" subtitle="Documentos que debes leer y firmar." />
      {me.isHr && (
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'mias', label: 'Para firmar' },
            { id: 'todas', label: 'Solicitudes enviadas' },
          ]}
        />
      )}
      {tab === 'mias' ? <Mine /> : <Sent />}
    </>
  );
}

function Mine() {
  const { data, error, reload } = useLoad(() => api.get<any[]>('/signatures/mine'));
  const [signing, setSigning] = useState<any | null>(null);
  return (
    <Card>
      <ErrorBox error={error} />
      {data?.length ? (
        <table>
          <thead>
            <tr>
              <th>Documento</th>
              <th>Enviado</th>
              <th>Estado</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data.map((s) => (
              <tr key={s.id}>
                <td>
                  {s.title}
                  <div className="small muted">{s.company_name}</div>
                </td>
                <td>
                  {dateTime(s.created_at)}
                  {s.due_date && <div className="small muted">Antes del {dayLabel(s.due_date)}</div>}
                </td>
                <td>
                  <Badge tone={STATUS[s.status].tone}>{STATUS[s.status].label}</Badge>
                </td>
                <td className="num">
                  {s.status === 'pending' ? (
                    <IconButton icon="sign" className="btn btn-primary btn-sm" onClick={() => setSigning(s)}>
                      Leer y firmar
                    </IconButton>
                  ) : s.status === 'signed' ? (
                    <a className="btn btn-sm" href={`/api/signatures/${s.id}/file?signed=true`} target="_blank" rel="noreferrer">
                      Ver firmado
                    </a>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>No tienes documentos para firmar.</Empty>
      )}
      {signing && <SignModal s={signing} onClose={() => setSigning(null)} onDone={reload} />}
    </Card>
  );
}

function SignModal({ s, onClose, onDone }: { s: any; onClose: () => void; onDone: () => Promise<void> }) {
  const [sent, setSent] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [consent, setConsent] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const { busy, error, run } = useAction();
  const sign = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api.post(`/signatures/${s.id}/sign`, { code, consent });
      await onDone();
      onClose();
    });
  };
  return (
    <Modal title={s.title} onClose={onClose}>
      {s.message && <Notice>{s.message}</Notice>}
      <iframe className="pdf-frame" src={`/api/signatures/${s.id}/file`} title={s.title} />
      <ErrorBox error={error} />
      {declining ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => (await api.post(`/signatures/${s.id}/decline`, { reason }), onDone(), onClose()));
          }}
        >
          <Field label="Motivo del rechazo">
            <input required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <div className="modal-actions">
            <button type="button" className="btn" onClick={() => setDeclining(false)}>
              Volver
            </button>
            <button className="btn btn-danger" disabled={busy}>
              Rechazar firma
            </button>
          </div>
        </form>
      ) : !sent ? (
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={() => setDeclining(true)}>
            No firmar
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={() => run(async () => setSent((await api.post(`/signatures/${s.id}/code`)).sentTo))}>
            Enviarme el código para firmar
          </button>
        </div>
      ) : (
        <form onSubmit={sign}>
          <p className="muted small" style={{ marginTop: 12 }}>
            Te hemos enviado un código de 6 dígitos a {sent}. Caduca en 10 minutos.
          </p>
          <Field label="Código">
            <input inputMode="numeric" autoComplete="one-time-code" required pattern="[0-9 ]{6,7}" value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
          </Field>
          <label className="check">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> He leído el documento y lo firmo electrónicamente.
          </label>
          <div className="modal-actions">
            <button type="button" className="btn" disabled={busy} onClick={() => run(async () => setSent((await api.post(`/signatures/${s.id}/code`)).sentTo))}>
              Reenviar código
            </button>
            <button className="btn btn-primary" disabled={busy || !consent}>
              Firmar
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function Sent() {
  const { data, error, reload } = useLoad(() => api.get<any[]>('/signatures'));
  const [requesting, setRequesting] = useState(false);
  const action = useAction();
  return (
    <Card
      title="Solicitudes de firma"
      actions={
        <IconButton icon="sign" className="btn btn-primary btn-sm" onClick={() => setRequesting(true)}>
          Pedir una firma
        </IconButton>
      }
    >
      <p className="muted">
        Firma electrónica simple: la persona firma desde su sesión con un código que recibe por email. Al documento se le añade una hoja con las
        evidencias (identidad, fecha, IP y huella SHA-256) y la copia firmada queda en sus documentos.
      </p>
      <ErrorBox error={error || action.error} />
      {data?.length ? (
        <table>
          <thead>
            <tr>
              <th>Documento</th>
              <th>Persona</th>
              <th>Estado</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data.map((s) => (
              <tr key={s.id}>
                <td>
                  {s.title}
                  <div className="small muted">{dateTime(s.created_at)}</div>
                </td>
                <td>
                  {s.person_name}
                  <div className="small muted">{s.company_name}</div>
                </td>
                <td>
                  <Badge tone={STATUS[s.status].tone}>{STATUS[s.status].label}</Badge>
                  {s.signed_at && <div className="small muted">{dateTime(s.signed_at)}</div>}
                  {s.decline_reason && <div className="small muted">«{s.decline_reason}»</div>}
                </td>
                <td className="num">
                  <div className="row" style={{ justifyContent: 'flex-end' }}>
                    {s.status === 'signed' && (
                      <a className="btn btn-sm" href={`/api/signatures/${s.id}/file?signed=true`} target="_blank" rel="noreferrer">
                        Firmado
                      </a>
                    )}
                    {s.status === 'pending' && (
                      <button className="btn btn-sm btn-danger" disabled={action.busy} onClick={() => confirm('¿Anular la solicitud?') && action.run(async () => (await api.post(`/signatures/${s.id}/cancel`), reload()))}>
                        Anular
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>No has pedido ninguna firma.</Empty>
      )}
      {requesting && <RequestModal onClose={() => setRequesting(false)} onDone={reload} />}
    </Card>
  );
}

function RequestModal({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<void> }) {
  const people = useLoad(() => api.get<any[]>('/org/employees'));
  const [employmentId, setEmploymentId] = useState('');
  const [f, setF] = useState({ title: '', message: '', dueDate: '' });
  const [file, setFile] = useState<File | null>(null);
  const { busy, error, run } = useAction();
  const emp = people.data?.find((p) => p.id === employmentId);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!file || !emp) return;
    void run(async () => {
      const form = new FormData();
      form.set('personId', emp.person_id);
      form.set('companyId', emp.company_id);
      form.set('title', f.title);
      if (f.message) form.set('message', f.message);
      if (f.dueDate) form.set('dueDate', f.dueDate);
      form.set('file', file);
      await api.upload('/signatures', form);
      await onDone();
      onClose();
    });
  };
  return (
    <Modal title="Pedir una firma" onClose={onClose}>
      <form onSubmit={submit}>
        <ErrorBox error={error || people.error} />
        <Field label="Persona">
          <select required value={employmentId} onChange={(e) => setEmploymentId(e.target.value)}>
            <option value="" disabled>
              Elige…
            </option>
            {people.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.last_name}, {p.first_name} · {p.company_name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Título">
          <input required value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Anexo al contrato: teletrabajo" />
        </Field>
        <Field label="Mensaje (opcional)">
          <input value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} />
        </Field>
        <div className="form-grid">
          <Field label="Firmar antes del (opcional)">
            <input type="date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} />
          </Field>
          <Field label="PDF">
            <input type="file" accept="application/pdf" required onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </Field>
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-primary" disabled={busy || !file || !emp}>
            Enviar
          </button>
        </div>
      </form>
    </Modal>
  );
}
