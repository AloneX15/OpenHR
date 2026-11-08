'use client';

import { FormEvent, useState } from 'react';
import { IconButton } from '@/components/icons';
import { Badge, Card, Empty, ErrorBox, Field, Modal, Notice, PageHeader, Tabs, useAction, useLoad } from '@/components/ui';
import { api, download } from '@/lib/api';
import { dateTime, dayLabel } from '@/lib/format';
import { useSession } from '@/lib/session';

const KIND: Record<string, string> = {
  access: 'Acceso a mis datos',
  rectification: 'Rectificación',
  erasure: 'Supresión',
  restriction: 'Limitación del tratamiento',
  portability: 'Portabilidad',
  objection: 'Oposición',
};
const STATUS: Record<string, { label: string; tone: any }> = {
  received: { label: 'Recibida', tone: 'warning' },
  in_progress: { label: 'En curso', tone: 'info' },
  completed: { label: 'Atendida', tone: 'success' },
  rejected: { label: 'Denegada', tone: 'danger' },
};
const RETENTION_LABEL: Record<string, string> = {
  time_entries: 'Registro de jornada (mínimo 4 años)',
  former_employees: 'Datos de personas que ya no trabajan en el grupo (desde su última baja)',
  audit: 'Registro de auditoría',
  notifications: 'Notificaciones de la bandeja',
  outbox: 'Emails ya enviados',
};

type Tab = 'mis' | 'solicitudes' | 'conservacion' | 'canal';

export default function PrivacyPage() {
  const { me } = useSession();
  const [tab, setTab] = useState<Tab>('mis');
  const tabs: { id: Tab; label: string }[] = [{ id: 'mis', label: 'Mis datos' }];
  if (me.isHr) tabs.push({ id: 'solicitudes', label: 'Solicitudes recibidas' });
  if (me.isAdmin) tabs.push({ id: 'conservacion', label: 'Conservación' }, { id: 'canal', label: 'Canal de denuncias' });
  return (
    <>
      <PageHeader title="Privacidad" subtitle="Tus datos personales y tus derechos (RGPD)." />
      {tabs.length > 1 && <Tabs value={tab} onChange={setTab} tabs={tabs} />}
      {tab === 'mis' && <MyPrivacy />}
      {tab === 'solicitudes' && <Requests />}
      {tab === 'conservacion' && <Retention />}
      {tab === 'canal' && <ChannelSettings />}
    </>
  );
}

function MyPrivacy() {
  const { data, error, reload } = useLoad(() => api.get<any[]>('/privacy/requests/mine'));
  const [creating, setCreating] = useState(false);
  const action = useAction();
  return (
    <div className="grid grid-2">
      <Card title="Descargar mis datos">
        <p className="muted">Un fichero JSON con todo lo que OpenHR guarda de ti: datos personales, relaciones laborales, fichajes, ausencias, documentos, firmas…</p>
        <ErrorBox error={action.error} />
        <IconButton icon="download" className="btn btn-primary" disabled={action.busy} onClick={() => action.run(() => download('/privacy/my-data'))}>
          Descargar
        </IconButton>
      </Card>
      <Card
        title="Mis solicitudes"
        actions={
          <button className="btn btn-sm" onClick={() => setCreating(true)}>
            Nueva solicitud
          </button>
        }
      >
        <p className="muted small">Puedes pedir que se corrijan, borren o limiten tus datos. La empresa debe responderte en un mes.</p>
        <ErrorBox error={error} />
        {data?.length ? (
          <ul className="list">
            {data.map((r) => (
              <li key={r.id}>
                <div className="spread">
                  <strong>{KIND[r.kind]}</strong>
                  <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>
                </div>
                <div className="small muted">
                  {dateTime(r.created_at)} · respuesta antes del {dayLabel(r.due_date)}
                </div>
                <div className="small">{r.details}</div>
                {r.response && <div className="small">Respuesta: {r.response}</div>}
              </li>
            ))}
          </ul>
        ) : (
          <Empty>No has hecho ninguna solicitud.</Empty>
        )}
      </Card>
      {creating && <RequestModal onClose={() => setCreating(false)} onDone={reload} />}
    </div>
  );
}

function RequestModal({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<void> }) {
  const [kind, setKind] = useState('rectification');
  const [details, setDetails] = useState('');
  const { busy, error, run } = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api.post('/privacy/requests', { kind, details });
      await onDone();
      onClose();
    });
  };
  return (
    <Modal title="Ejercer un derecho" onClose={onClose}>
      <form onSubmit={submit}>
        <ErrorBox error={error} />
        <Field label="Derecho">
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            {Object.entries(KIND).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Explica tu solicitud">
          <textarea required minLength={5} value={details} onChange={(e) => setDetails(e.target.value)} />
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

function Requests() {
  const { data, error, reload } = useLoad(() => api.get<any[]>('/privacy/requests'));
  const [answering, setAnswering] = useState<any | null>(null);
  return (
    <Card title="Solicitudes de derechos">
      <ErrorBox error={error} />
      {data?.length ? (
        <table>
          <thead>
            <tr>
              <th>Persona</th>
              <th>Derecho</th>
              <th>Plazo</th>
              <th>Estado</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data.map((r) => (
              <tr key={r.id}>
                <td>{r.person_name}</td>
                <td>
                  {KIND[r.kind]}
                  <div className="small muted">{r.details}</div>
                </td>
                <td>{dayLabel(r.due_date)}</td>
                <td>
                  <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>
                </td>
                <td className="num">
                  {['received', 'in_progress'].includes(r.status) && (
                    <button className="btn btn-sm" onClick={() => setAnswering(r)}>
                      Responder
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>No hay solicitudes.</Empty>
      )}
      {answering && <AnswerModal r={answering} onClose={() => setAnswering(null)} onDone={reload} />}
    </Card>
  );
}

function AnswerModal({ r, onClose, onDone }: { r: any; onClose: () => void; onDone: () => Promise<void> }) {
  const [status, setStatus] = useState('completed');
  const [response, setResponse] = useState('');
  const [extend, setExtend] = useState(false);
  const { busy, error, run } = useAction();
  return (
    <Modal title={`${KIND[r.kind]}: ${r.person_name}`} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api.post(`/privacy/requests/${r.id}`, { status, response: response || undefined, extendDays: extend ? 60 : 0 });
            await onDone();
            onClose();
          });
        }}
      >
        <p className="small">{r.details}</p>
        {r.kind === 'erasure' && (
          <Notice tone="warning">
            Antes de borrar, comprueba los plazos legales de conservación (por ejemplo, el registro de jornada y las nóminas durante 4 años). Para
            anonimizar a alguien que ya no trabaja en el grupo, usa Conservación.
          </Notice>
        )}
        <ErrorBox error={error} />
        <Field label="Estado">
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="in_progress">En curso</option>
            <option value="completed">Atendida</option>
            <option value="rejected">Denegada</option>
          </select>
        </Field>
        <Field label="Respuesta a la persona">
          <textarea value={response} onChange={(e) => setResponse(e.target.value)} />
        </Field>
        <label className="check">
          <input type="checkbox" checked={extend} onChange={(e) => setExtend(e.target.checked)} /> Ampliar el plazo dos meses (casos complejos, art. 12.3)
        </label>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-primary" disabled={busy}>
            Guardar
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Retention() {
  const settings = useLoad(() => api.get<Record<string, number>>('/privacy/retention'));
  const [values, setValues] = useState<Record<string, number> | null>(null);
  const [preview, setPreview] = useState<any | null>(null);
  const action = useAction();
  const v = values ?? settings.data ?? {};
  return (
    <div className="grid grid-2">
      <Card title="Plazos de conservación (días)">
        <ErrorBox error={settings.error || action.error} />
        {Object.keys(RETENTION_LABEL).map((k) => (
          <Field key={k} label={RETENTION_LABEL[k]}>
            <input type="number" min={1} value={v[k] ?? ''} onChange={(e) => setValues({ ...v, [k]: Number(e.target.value) })} />
          </Field>
        ))}
        <button className="btn btn-primary" disabled={action.busy || !values} onClick={() => action.run(async () => { await api.put('/privacy/retention', v); await settings.reload(); setValues(null); })}>
          Guardar plazos
        </button>
      </Card>
      <Card title="Aplicar los plazos">
        <p className="muted">
          Se aplican solos cada día. Al anonimizar a una persona se borran sus datos identificativos y sus documentos; sus fichajes se purgan cuando vence
          el plazo del registro de jornada.
        </p>
        <div className="row">
          <button className="btn" disabled={action.busy} onClick={() => action.run(async () => setPreview(await api.post('/privacy/retention/run', { dryRun: true })))}>
            Ver qué se borraría
          </button>
          <button
            className="btn btn-danger"
            disabled={action.busy}
            onClick={() => confirm('Se borrarán y anonimizarán datos de forma definitiva. ¿Continuar?') && action.run(async () => setPreview(await api.post('/privacy/retention/run', { dryRun: false })))}
          >
            Aplicar ahora
          </button>
        </div>
        {preview && (
          <ul className="list small" style={{ marginTop: 12 }}>
            <li>{preview.dryRun ? 'Simulación' : 'Aplicado'}:</li>
            <li>Fichajes: {preview.result.timeEntries}</li>
            <li>Personas a anonimizar: {preview.result.formerEmployees}</li>
            <li>Notificaciones: {preview.result.notifications}</li>
            <li>Emails enviados: {preview.result.outbox}</li>
          </ul>
        )}
      </Card>
    </div>
  );
}

function ChannelSettings() {
  const { data, error, reload } = useLoad(() => api.get('/whistleblowing/settings'));
  const action = useAction();
  const url = data?.token ? `${location.origin}/canal/${data.token}` : null;
  return (
    <Card title="Canal de denuncias (Ley 2/2023)">
      <p className="muted">
        Obligatorio en empresas de 50 o más personas. Permite comunicar irregularidades de forma anónima o identificada; solo lo gestiona la persona
        Responsable del Sistema (asígnale el permiso en su ficha). Ni administración ni RR. HH. ven las denuncias por serlo.
      </p>
      <ErrorBox error={error || action.error} />
      {data?.enabled ? (
        <>
          <Notice tone="success">
            Activo. Comparte este enlace con la plantilla y en vuestra web: <span className="mono">{url}</span>
          </Notice>
          <p className="small">
            Responsables: {data.handlers.length ? data.handlers.map((h: any) => h.name).join(', ') : <span className="text-danger">Atención: no hay ninguna persona responsable asignada</span>}
          </p>
          <button className="btn btn-sm" disabled={action.busy} onClick={() => confirm('El enlace actual dejará de funcionar. ¿Continuar?') && action.run(async () => (await api.post('/whistleblowing/enable', { regenerate: true }), reload()))}>
            Cambiar el enlace
          </button>
        </>
      ) : (
        <button className="btn btn-primary" disabled={action.busy} onClick={() => action.run(async () => (await api.post('/whistleblowing/enable', {}), reload()))}>
          Activar el canal
        </button>
      )}
    </Card>
  );
}
