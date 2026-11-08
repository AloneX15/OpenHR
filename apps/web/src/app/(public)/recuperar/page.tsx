'use client';

import Link from 'next/link';
import { FormEvent, useState } from 'react';
import { ErrorBox, Field, Notice, useAction } from '@/components/ui';
import { api } from '@/lib/api';

export default function RecoverPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const { busy, error, run } = useAction();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api.post('/auth/forgot', { email });
      setSent(true);
    });
  };

  return (
    <div className="auth-page">
      <div className="card auth-card">
        <div className="brand">
          <span className="brand-mark">O</span>
          <strong>OpenHR</strong>
        </div>
        <h1 style={{ textAlign: 'center', marginBottom: 20, fontSize: '1.2rem' }}>Recuperar contraseña</h1>
        {sent ? (
          <Notice tone="success">Si el email existe, te hemos enviado un enlace para elegir una contraseña nueva. Caduca en 24 horas.</Notice>
        ) : (
          <form onSubmit={submit}>
            <ErrorBox error={error} />
            <Field label="Email">
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
            </Field>
            <button className="btn btn-primary" style={{ width: '100%' }} disabled={busy}>
              Enviar enlace
            </button>
          </form>
        )}
        <p className="muted small" style={{ textAlign: 'center', marginTop: 16 }}>
          <Link href="/login">Volver a iniciar sesión</Link>
        </p>
      </div>
    </div>
  );
}
