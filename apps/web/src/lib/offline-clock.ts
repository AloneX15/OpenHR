'use client';

import { api } from './api';

/**
 * Cola de fichajes hechos sin conexión. Se guardan en el dispositivo con su hora y una
 * clave de idempotencia, y se envían al recuperar la conexión (el servidor los marca como
 * «sin conexión» y solo los acepta hasta 72 horas después).
 */
const KEY = 'openhr-offline-clock';

export interface QueuedClock {
  employmentId: string;
  kind: 'in' | 'out' | 'break_start' | 'break_end';
  offlineAt: string;
  idempotencyKey: string;
}

export function queued(): QueuedClock[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]');
  } catch {
    return [];
  }
}

function save(list: QueuedClock[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* almacenamiento no disponible */
  }
}

export function enqueue(item: QueuedClock) {
  save([...queued(), item]);
}

/** Envía la cola en orden. Devuelve cuántos se enviaron; los rechazados se descartan con su error. */
export async function flush(): Promise<{ sent: number; failed: string[] }> {
  const list = queued();
  const failed: string[] = [];
  let sent = 0;
  const rest: QueuedClock[] = [];
  for (const item of list) {
    try {
      await api.post('/time/clock', item);
      sent++;
    } catch (e) {
      if ((e as any)?.status) failed.push((e as Error).message); // el servidor lo rechazó: no se reintenta
      else rest.push(item); // sigue sin conexión
    }
  }
  save(rest);
  return { sent, failed };
}

export function isNetworkError(e: unknown) {
  return e instanceof TypeError || (typeof navigator !== 'undefined' && !navigator.onLine);
}

/** Posición actual (si la persona la concede), con un límite de tiempo. */
export function currentPosition(timeoutMs = 8000): Promise<{ latitude: number; longitude: number; accuracy: number } | undefined> {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return resolve(undefined);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy }),
      () => resolve(undefined),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30000 },
    );
  });
}
