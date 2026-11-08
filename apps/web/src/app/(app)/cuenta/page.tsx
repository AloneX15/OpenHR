'use client';

import QRCode from 'qrcode';
import { FormEvent, useEffect, useState } from 'react';
import { ThemeSwitch } from '@/components/ThemeSwitch';
import { Card, ErrorBox, Field, Notice, PageHeader, useAction } from '@/components/ui';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';

export default function AccountPage() {
  const { me, reload } = useSession();
  return (
    <>
      <PageHeader title="Mi cuenta" subtitle={me.email} />
      <div className="grid grid-2">
        <PasswordCard />
        <MfaCard enabled={me.mfaEnabled} onChange={reload} />
        <Card title="Apariencia">
          <p className="muted">Elige el tema de color. «Sistema» sigue la configuración de tu dispositivo.</p>
          <ThemeSwitch />
        </Card>
      </div>
    </>
  );
}

function PasswordCard() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [done, setDone] = useState(false);
  const { busy, error, run } = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api.post('/auth/password', { current, next });
      setDone(true);
      setCurrent('');
      setNext('');
    });
  };
  return (
    <Card title="Cambiar contraseña">
      <form onSubmit={submit}>
        <ErrorBox error={error} />
        {done && <Notice tone="success">Contraseña cambiada.</Notice>}
        <Field label="Contraseña actual">
          <input type="password" required autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </Field>
        <Field label="Nueva contraseña" hint="Mínimo 10 caracteres.">
          <input type="password" required minLength={10} autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
        <button className="btn btn-primary" disabled={busy}>
          Guardar
        </button>
      </form>
    </Card>
  );
}

function MfaCard({ enabled, onChange }: { enabled: boolean; onChange: () => Promise<void> }) {
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const { busy, error, run } = useAction();

  useEffect(() => {
    if (setup) QRCode.toDataURL(setup.otpauthUrl, { margin: 1, width: 200 }).then(setQr);
  }, [setup]);

  if (enabled) {
    return (
      <Card title="Verificación en dos pasos">
        <Notice tone="success">Activada. Al entrar te pediremos el código de tu app de autenticación.</Notice>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api.post('/auth/mfa/disable', { password });
              await onChange();
            });
          }}
        >
          <ErrorBox error={error} />
          <Field label="Tu contraseña, para desactivarla">
            <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <button className="btn btn-danger" disabled={busy}>
            Desactivar
          </button>
        </form>
      </Card>
    );
  }

  return (
    <Card title="Verificación en dos pasos">
      <ErrorBox error={error} />
      {!setup ? (
        <>
          <p className="muted">Protege tu cuenta con un código de una app como Google Authenticator, Microsoft Authenticator o 1Password.</p>
          <button className="btn btn-primary" disabled={busy} onClick={() => run(async () => setSetup(await api.post('/auth/mfa/setup')))}>
            Activar
          </button>
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api.post('/auth/mfa/enable', { code });
              await onChange();
            });
          }}
        >
          <p>1. Escanea este código con tu app de autenticación:</p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {qr && <img src={qr} alt="Código QR para la app de autenticación" width={200} height={200} style={{ background: '#fff', borderRadius: 8 }} />}
          <p className="small muted">
            O introduce la clave a mano: <span className="mono">{setup.secret}</span>
          </p>
          <Field label="2. Escribe el código de 6 dígitos que muestra la app">
            <input inputMode="numeric" required value={code} onChange={(e) => setCode(e.target.value)} />
          </Field>
          <button className="btn btn-primary" disabled={busy}>
            Confirmar
          </button>
        </form>
      )}
    </Card>
  );
}
