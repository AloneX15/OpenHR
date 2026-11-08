'use client';

import { FormEvent, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Card, ErrorBox, Field, Notice, useAction, useLoad } from './ui';

/** Organización → inicio de sesión con Microsoft 365 u otro proveedor OpenID Connect. */
export function OidcSettings() {
  const { data, error, reload } = useLoad(() => api.get('/auth/oidc/config'));
  const [f, setF] = useState({ label: 'Microsoft 365', issuer: '', clientId: '', clientSecret: '', domains: '', enabled: true, enforce: false });
  const [saved, setSaved] = useState(false);
  const action = useAction();
  useEffect(() => {
    const c = data?.config;
    if (c) setF({ label: c.label, issuer: c.issuer, clientId: c.client_id, clientSecret: '', domains: c.domains.join(', '), enabled: c.enabled, enforce: c.enforce });
  }, [data]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void action.run(async () => {
      await api.put('/auth/oidc/config', {
        ...f,
        clientSecret: f.clientSecret || undefined,
        domains: f.domains.split(/[,\s]+/).filter(Boolean),
      });
      setSaved(true);
      await reload();
    });
  };
  return (
    <div className="grid grid-2">
      <Card title="Inicio de sesión con la cuenta corporativa">
        <p className="muted">
          Las personas de los dominios indicados entran con su cuenta de Microsoft 365 (Entra ID), Google Workspace u otro proveedor OpenID Connect. Solo
          entran quienes ya tienen cuenta en OpenHR con ese email.
        </p>
        <ErrorBox error={error || action.error} />
        {saved && <Notice tone="success">Guardado.</Notice>}
        <form onSubmit={submit}>
          <div className="form-grid">
            <Field label="Texto del botón">
              <input required value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} />
            </Field>
            <Field label="Dominios de email" hint="Separados por comas: grupo.es, filial.es">
              <input required value={f.domains} onChange={(e) => setF({ ...f, domains: e.target.value })} />
            </Field>
          </div>
          <Field label="Emisor (issuer)" hint="Entra ID: https://login.microsoftonline.com/<id-del-inquilino>/v2.0">
            <input required type="url" value={f.issuer} onChange={(e) => setF({ ...f, issuer: e.target.value })} />
          </Field>
          <div className="form-grid">
            <Field label="Id. de la aplicación (client ID)">
              <input required value={f.clientId} onChange={(e) => setF({ ...f, clientId: e.target.value })} />
            </Field>
            <Field label="Secreto del cliente" hint={data?.config ? 'Déjalo vacío para conservar el actual.' : undefined}>
              <input type="password" autoComplete="off" value={f.clientSecret} onChange={(e) => setF({ ...f, clientSecret: e.target.value })} />
            </Field>
          </div>
          <label className="check">
            <input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> Activado
          </label>
          <label className="check">
            <input type="checkbox" checked={f.enforce} onChange={(e) => setF({ ...f, enforce: e.target.checked })} /> Obligatorio: esos dominios ya no pueden entrar con contraseña
          </label>
          <button className="btn btn-primary" disabled={action.busy}>
            Guardar y comprobar
          </button>
        </form>
      </Card>
      <Card title="Cómo registrarlo en Microsoft Entra ID">
        <ol className="small">
          <li>Entra ID → Registros de aplicaciones → Nuevo registro. Tipo de cuenta: solo este directorio.</li>
          <li>
            URI de redirección (Web): <span className="mono">{data?.redirectUri}</span>
          </li>
          <li>Certificados y secretos → nuevo secreto de cliente. Cópialo aquí.</li>
          <li>Permisos: openid, email y profile (Microsoft Graph, delegados).</li>
          <li>Emisor: https://login.microsoftonline.com/&lt;id del inquilino&gt;/v2.0 (aparece en «Información general»).</li>
        </ol>
      </Card>
    </div>
  );
}
