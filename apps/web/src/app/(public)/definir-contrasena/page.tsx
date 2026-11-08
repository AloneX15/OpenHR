'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { FormEvent, Suspense, useState } from 'react';
import { ErrorBox, Field, useAction } from '@/components/ui';
import { api } from '@/lib/api';

function SetPasswordForm() {
  const router = useRouter();
  const token = useSearchParams().get('token') ?? '';
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const { busy, error, setError, run } = useAction();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (password !== repeat) return setError('Las contraseñas no coinciden');
    void run(async () => {
      await api.post('/auth/set-password', { token, password });
      router.replace('/');
    });
  };

  if (!token) return <ErrorBox error="El enlace no es válido. Pide uno nuevo a RR. HH." />;
  return (
    <form onSubmit={submit}>
      <ErrorBox error={error} />
      <Field label="Nueva contraseña" hint="Mínimo 10 caracteres. Mejor una frase que puedas recordar.">
        <input type="password" required minLength={10} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
      </Field>
      <Field label="Repite la contraseña">
        <input type="password" required minLength={10} autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} />
      </Field>
      <button className="btn btn-primary" style={{ width: '100%' }} disabled={busy}>
        {busy ? 'Guardando…' : 'Guardar y entrar'}
      </button>
    </form>
  );
}

export default function SetPasswordPage() {
  return (
    <div className="auth-page">
      <div className="card auth-card">
        <div className="brand">
          <span className="brand-mark">O</span>
          <strong>OpenHR</strong>
        </div>
        <h1 style={{ textAlign: 'center', marginBottom: 20, fontSize: '1.2rem' }}>Elige tu contraseña</h1>
        <Suspense>
          <SetPasswordForm />
        </Suspense>
      </div>
    </div>
  );
}
