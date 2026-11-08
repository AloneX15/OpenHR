'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { FormEvent, Suspense, useEffect, useState } from 'react';
import { ErrorBox, Field, useAction } from '@/components/ui';
import { api } from '@/lib/api';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next') || '/';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const { busy, error, run } = useAction();
  const [sso, setSso] = useState<{ sso: boolean; label?: string; enforce?: boolean }>({ sso: false });
  const ssoError = params.get('error');

  // Si el dominio del email usa la cuenta corporativa, se ofrece el botón (o se exige).
  const checkSso = () => {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return setSso({ sso: false });
    api.post('/auth/oidc/lookup', { email }).then(setSso).catch(() => setSso({ sso: false }));
  };

  useEffect(() => {
    api.get<{ done: boolean }>('/setup/status').then((s) => !s.done && router.replace('/configuracion-inicial')).catch(() => undefined);
  }, [router]);

  const go = () => router.replace(next.startsWith('/') && !next.startsWith('//') ? next : '/');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      if (challenge) {
        await api.post('/auth/mfa', { challenge, code });
        return go();
      }
      const r = await api.post<{ ok?: boolean; mfaRequired?: boolean; challenge?: string }>('/auth/login', { email, password });
      if (r.mfaRequired && r.challenge) setChallenge(r.challenge);
      else go();
    });
  };

  return (
    <form onSubmit={submit}>
      <ErrorBox error={error || ssoError} />
      {!challenge ? (
        <>
          <Field label="Email">
            <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} onBlur={checkSso} autoFocus />
          </Field>
          {sso.sso && (
            <a className="btn btn-primary" style={{ width: '100%', marginBottom: 12 }} href={`/api/auth/oidc/start?email=${encodeURIComponent(email)}`}>
              Entrar con {sso.label}
            </a>
          )}
          {!sso.enforce && (
            <Field label="Contraseña">
              <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
          )}
        </>
      ) : (
        <Field label="Código de verificación" hint="Abre tu app de autenticación e introduce el código de 6 dígitos.">
          <input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" required value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
        </Field>
      )}
      {!(sso.enforce && !challenge) && (
        <button className={sso.sso && !challenge ? 'btn' : 'btn btn-primary'} style={{ width: '100%' }} disabled={busy}>
          {busy ? 'Entrando…' : challenge ? 'Verificar' : sso.sso ? 'Entrar con contraseña' : 'Entrar'}
        </button>
      )}
      <p className="muted small" style={{ textAlign: 'center', marginTop: 16 }}>
        <Link href="/recuperar">¿Has olvidado tu contraseña?</Link>
      </p>
    </form>
  );
}

export default function LoginPage() {
  return (
    <div className="auth-page">
      <div className="card auth-card">
        <div className="brand">
          <span className="brand-mark">O</span>
          <strong>OpenHR</strong>
        </div>
        <h1 style={{ textAlign: 'center', marginBottom: 20, fontSize: '1.2rem' }}>Inicia sesión</h1>
        <Suspense>
          <LoginForm />
        </Suspense>
      </div>
    </div>
  );
}
