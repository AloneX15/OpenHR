'use client';

import { FormEvent, useState } from 'react';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { Badge, Card, ErrorBox, Field, Notice, useAction, useLoad } from './ui';

/** Organización → Inicio de sesión: tokens para que Entra ID cree y desactive cuentas por SCIM. */
export function ScimTokens() {
  const { data, error, reload } = useLoad(() => api.get<any[]>('/scim-tokens'));
  const [label, setLabel] = useState('Microsoft Entra ID');
  const [created, setCreated] = useState<{ token: string; baseUrl: string } | null>(null);
  const action = useAction();
  const create = (e: FormEvent) => {
    e.preventDefault();
    void action.run(async () => {
      setCreated(await api.post('/scim-tokens', { label }));
      await reload();
    });
  };
  return (
    <Card title="Aprovisionamiento automático (SCIM)">
      <ErrorBox error={error || action.error} />
      <p className="muted">
        Con SCIM, Microsoft Entra ID crea la cuenta de OpenHR cuando asignas la aplicación a alguien y la desactiva en cuanto deja la empresa. La ficha laboral la sigue dando de alta RR. HH. con el
        mismo email; las dos se unen solas.
      </p>
      <ol className="small">
        <li>En Entra ID, abre la aplicación empresarial de OpenHR → Aprovisionamiento → Automático.</li>
        <li>Pega la URL del inquilino y el token que se generan aquí y pulsa «Probar conexión».</li>
        <li>En las asignaciones de atributos, deja userName = userPrincipalName (o mail), active y externalId = objectId.</li>
      </ol>
      {created && (
        <Notice tone="success">
          Copia estos datos ahora: el token no se volverá a mostrar.
          <div className="small" style={{ marginTop: 8 }}>
            URL del inquilino: <code>{created.baseUrl}</code>
            <br />
            Token secreto: <code style={{ wordBreak: 'break-all' }}>{created.token}</code>
          </div>
        </Notice>
      )}
      <form onSubmit={create} className="row" style={{ alignItems: 'flex-end' }}>
        <Field label="Nombre del token">
          <input required maxLength={80} value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <button className="btn btn-primary" disabled={action.busy} style={{ marginBottom: 12 }}>
          Generar token
        </button>
      </form>
      {data && data.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Token</th>
              <th>Creado</th>
              <th>Último uso</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data.map((t) => (
              <tr key={t.id}>
                <td>
                  {t.label} {t.revoked_at && <Badge>Revocado</Badge>}
                </td>
                <td>{dateTime(t.created_at)}</td>
                <td>{t.last_used_at ? dateTime(t.last_used_at) : '—'}</td>
                <td className="num">
                  {!t.revoked_at && (
                    <button className="btn btn-ghost btn-sm" disabled={action.busy} onClick={() => action.run(async () => (await api.del(`/scim-tokens/${t.id}`), reload()))}>
                      Revocar
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
