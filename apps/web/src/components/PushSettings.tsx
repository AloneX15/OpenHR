'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { Card, ErrorBox, Notice, useAction, useLoad } from './ui';

function keyBytes(base64url: string) {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function registration() {
  return (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.register('/sw.js'));
}

/** Activar o desactivar los avisos push en este navegador. */
export function PushSettings() {
  const info = useLoad(() => api.get<{ enabled: boolean; publicKey: string | null; devices: any[] }>('/notifications/push'));
  const [here, setHere] = useState<PushSubscription | null>(null);
  const [supported, setSupported] = useState(true);
  const { busy, error, run } = useAction();

  useEffect(() => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      setSupported(false);
      return;
    }
    navigator.serviceWorker
      .getRegistration()
      .then((r) => r?.pushManager.getSubscription())
      .then((s) => setHere(s ?? null))
      .catch(() => undefined);
  }, []);

  if (!info.data?.enabled) return null;

  const enable = () =>
    run(async () => {
      if ((await Notification.requestPermission()) !== 'granted') throw new Error('El navegador no ha dado permiso para mostrar avisos.');
      const reg = await registration();
      await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(info.data!.publicKey!) });
      await api.post('/notifications/push/subscriptions', sub.toJSON());
      setHere(sub);
      await info.reload();
    });

  const disable = () =>
    run(async () => {
      if (here) {
        await fetch('/api/notifications/push/subscriptions', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: here.endpoint }),
        });
        await here.unsubscribe();
      }
      setHere(null);
      await info.reload();
    });

  return (
    <Card title="Avisos en este dispositivo">
      <ErrorBox error={error || info.error} />
      {!supported ? (
        <Notice>Este navegador no admite avisos push. En iPhone, añade OpenHR a la pantalla de inicio y ábrelo desde ahí.</Notice>
      ) : here ? (
        <>
          <p>Los avisos (solicitudes, aprobaciones, nóminas…) llegan también como notificación a este dispositivo.</p>
          <button className="btn" disabled={busy} onClick={disable}>
            Desactivar en este dispositivo
          </button>
        </>
      ) : (
        <>
          <p className="muted">Recibe al momento las solicitudes que debes aprobar y las respuestas a las tuyas, aunque no tengas OpenHR abierto.</p>
          <button className="btn btn-primary" disabled={busy} onClick={enable}>
            Activar avisos
          </button>
        </>
      )}
      {info.data.devices.length > 0 && (
        <p className="small muted" style={{ marginTop: 12 }}>
          Activados en {info.data.devices.length} dispositivo(s). Último uso: {info.data.devices.map((d) => (d.last_used_at ? dateTime(d.last_used_at) : 'aún ninguno')).join(', ')}.
        </p>
      )}
    </Card>
  );
}
