'use client';

import { useRouter } from 'next/navigation';
import { FormEvent, useEffect, useState } from 'react';
import { ErrorBox, Field, useAction } from '@/components/ui';
import { api } from '@/lib/api';

export default function SetupPage() {
  const router = useRouter();
  const [f, setF] = useState({
    organizationName: '',
    companyName: '',
    companyTaxId: '',
    firstName: '',
    lastName: '',
    email: '',
    password: '',
    setupToken: '',
  });
  const [tokenRequired, setTokenRequired] = useState(false);
  const { busy, error, run } = useAction();
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  useEffect(() => {
    api
      .get<{ done: boolean; tokenRequired?: boolean }>('/setup/status')
      .then((s) => (s.done ? router.replace('/login') : setTokenRequired(Boolean(s.tokenRequired))))
      .catch(() => undefined);
  }, [router]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api.post('/setup', { ...f, setupToken: f.setupToken || undefined });
      router.replace('/organizacion');
    });
  };

  return (
    <div className="auth-page">
      <div className="card auth-card" style={{ width: 'min(560px, 100%)' }}>
        <div className="brand">
          <span className="brand-mark">O</span>
          <strong>OpenHR</strong>
        </div>
        <h1 style={{ textAlign: 'center', fontSize: '1.2rem' }}>Configuración inicial</h1>
        <p className="muted" style={{ textAlign: 'center' }}>
          Crea tu organización, la primera sociedad y tu cuenta de administración. Después podrás añadir más sociedades y personas.
        </p>
        <form onSubmit={submit}>
          <ErrorBox error={error} />
          {tokenRequired && (
            <Field label="Token de configuración" hint="Es el valor de SETUP_TOKEN en el fichero .env del servidor.">
              <input required type="password" value={f.setupToken} onChange={set('setupToken')} autoComplete="off" />
            </Field>
          )}
          <Field label="Nombre del grupo u organización">
            <input required value={f.organizationName} onChange={set('organizationName')} placeholder="Grupo Ejemplo" />
          </Field>
          <div className="form-grid">
            <Field label="Primera sociedad">
              <input required value={f.companyName} onChange={set('companyName')} placeholder="Ejemplo Servicios SL" />
            </Field>
            <Field label="CIF">
              <input required value={f.companyTaxId} onChange={set('companyTaxId')} placeholder="B12345678" />
            </Field>
            <Field label="Tu nombre">
              <input required value={f.firstName} onChange={set('firstName')} />
            </Field>
            <Field label="Tus apellidos">
              <input required value={f.lastName} onChange={set('lastName')} />
            </Field>
          </div>
          <Field label="Email">
            <input type="email" required autoComplete="username" value={f.email} onChange={set('email')} />
          </Field>
          <Field label="Contraseña" hint="Mínimo 10 caracteres.">
            <input type="password" required minLength={10} autoComplete="new-password" value={f.password} onChange={set('password')} />
          </Field>
          <button className="btn btn-primary" style={{ width: '100%' }} disabled={busy}>
            {busy ? 'Creando…' : 'Crear organización'}
          </button>
        </form>
      </div>
    </div>
  );
}
