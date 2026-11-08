'use client';

import { FormEvent, useState } from 'react';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { IconButton } from './icons';
import { Badge, Card, Empty, ErrorBox, Field, Modal, Notice, useAction, useLoad } from './ui';

const EVENTS: { id: string; label: string; hint: string }[] = [
  { id: 'announcement', label: 'Anuncios', hint: 'Cada anuncio publicado' },
  { id: 'absence', label: 'Ausencias aprobadas', hint: 'Quién estará fuera y cuándo. Nunca las bajas médicas ni otras con datos de salud' },
  { id: 'welcome', label: 'Bienvenidas', hint: 'Cada alta nueva, con su sociedad y puesto' },
];
const PROVIDER: Record<string, string> = { slack: 'Slack', teams: 'Microsoft Teams' };

/** Organización → Integraciones: avisos en canales de Slack y Teams. */
export function ChatIntegrations() {
  const { data, error, reload } = useLoad(() => api.get<any[]>('/integrations/chat'));
  const companies = useLoad(() => api.get<any[]>('/org/companies'));
  const [editing, setEditing] = useState<any | null>(null);
  const action = useAction();
  return (
    <Card
      title="Avisos en Slack y Teams"
      actions={
        <IconButton icon="plus" className="btn btn-sm" onClick={() => setEditing({ provider: 'slack', label: '', events: ['announcement', 'absence', 'welcome'], enabled: true, company_id: null })}>
          Conectar canal
        </IconButton>
      }
    >
      <ErrorBox error={error || action.error} />
      <p className="muted">
        Publica en un canal los anuncios, quién estará fuera y las bienvenidas. Solo se envía el nombre, el tipo y las fechas; nunca datos de salud.
      </p>
      {data?.length ? (
        <table>
          <thead>
            <tr>
              <th>Canal</th>
              <th>Avisos</th>
              <th>Último envío</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data.map((w) => (
              <tr key={w.id}>
                <td>
                  {w.label} {!w.enabled && <Badge>Pausado</Badge>}
                  <div className="small muted">
                    {PROVIDER[w.provider]} · {w.company_name ?? 'Todas las sociedades'} · {w.url_hint}
                  </div>
                </td>
                <td className="small">{w.events.map((e: string) => EVENTS.find((x) => x.id === e)?.label).join(', ')}</td>
                <td className="small">
                  {w.last_sent_at ? dateTime(w.last_sent_at) : '—'}
                  {w.last_error && <div style={{ color: 'var(--danger)' }}>{w.last_error}</div>}
                </td>
                <td className="num">
                  <button className="btn btn-ghost btn-sm" disabled={action.busy} onClick={() => action.run(async () => (await api.post(`/integrations/chat/${w.id}/test`), reload()))}>
                    Probar
                  </button>{' '}
                  <IconButton icon="edit" className="btn btn-ghost btn-sm" onClick={() => setEditing(w)}>
                    Editar
                  </IconButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>No hay ningún canal conectado.</Empty>
      )}
      {editing && <WebhookModal w={editing} companies={companies.data ?? []} onClose={() => setEditing(null)} onDone={reload} />}
    </Card>
  );
}

function WebhookModal({ w, companies, onClose, onDone }: { w: any; companies: any[]; onClose: () => void; onDone: () => Promise<void> }) {
  const [f, setF] = useState({ provider: w.provider, label: w.label, url: '', companyId: w.company_id ?? '', events: w.events as string[], enabled: w.enabled });
  const { busy, error, run } = useAction();
  const toggle = (id: string) => setF({ ...f, events: f.events.includes(id) ? f.events.filter((e) => e !== id) : [...f.events, id] });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const body = { provider: f.provider, label: f.label, url: f.url || undefined, companyId: f.companyId || null, events: f.events, enabled: f.enabled };
      if (w.id) await api.patch(`/integrations/chat/${w.id}`, body);
      else await api.post('/integrations/chat', body);
      await onDone();
      onClose();
    });
  };
  return (
    <Modal title={w.id ? 'Editar canal' : 'Conectar canal'} onClose={onClose}>
      <form onSubmit={submit}>
        <ErrorBox error={error} />
        <div className="grid grid-2" style={{ gap: 12 }}>
          <Field label="Servicio">
            <select value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value })}>
              <option value="slack">Slack</option>
              <option value="teams">Microsoft Teams</option>
            </select>
          </Field>
          <Field label="Nombre">
            <input required maxLength={80} placeholder="#general" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} />
          </Field>
        </div>
        <Field
          label={w.id ? 'URL del webhook (déjala vacía para no cambiarla)' : 'URL del webhook'}
          hint={
            f.provider === 'slack'
              ? 'En Slack: Apps → Incoming Webhooks → Add to Slack, elige el canal y copia la URL (https://hooks.slack.com/…).'
              : 'En Teams: en el canal, … → Flujos de trabajo → «Publicar en un canal cuando se reciba una solicitud de webhook» y copia la URL.'
          }
        >
          <input type="url" required={!w.id} autoComplete="off" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} />
        </Field>
        <Field label="Sociedad">
          <select value={f.companyId} onChange={(e) => setF({ ...f, companyId: e.target.value })}>
            <option value="">Todas las sociedades</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <fieldset className="fieldset">
          <legend>Qué se publica</legend>
          {EVENTS.map((ev) => (
            <label key={ev.id} className="check">
              <input type="checkbox" checked={f.events.includes(ev.id)} onChange={() => toggle(ev.id)} /> {ev.label}
              <span className="small muted"> · {ev.hint}</span>
            </label>
          ))}
        </fieldset>
        <label className="check">
          <input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> Activo
        </label>
        <Notice>La URL del webhook es como una contraseña del canal: se guarda cifrada y no se vuelve a mostrar.</Notice>
        <div className="modal-actions">
          {w.id && (
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await api.del(`/integrations/chat/${w.id}`);
                  await onDone();
                  onClose();
                })
              }
            >
              Desconectar
            </button>
          )}
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-primary" disabled={busy || !f.events.length}>
            Guardar
          </button>
        </div>
      </form>
    </Modal>
  );
}
