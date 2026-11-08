'use client';

import { useEffect, useRef, useState } from 'react';
import { newIdempotencyKey } from '@/lib/api';

const TOKEN_KEY = 'openhr-kiosk-token';
const KIND: Record<string, string> = { in: 'Entrada', out: 'Salida', break_start: 'Inicio de pausa', break_end: 'Fin de pausa' };

async function call(path: string, token: string, body?: unknown) {
  const res = await fetch(`/api/kiosk/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-kiosk-token': token, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message ?? 'Error');
  return data;
}

/**
 * Kiosco de fichaje para una tableta en el centro. Se abre una vez con el enlace que da RR. HH.
 * (lleva el token del dispositivo) y queda guardado en el navegador de la tableta.
 */
export default function KioskPage() {
  const [token, setToken] = useState<string | null>(null);
  const [info, setInfo] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(new Date());
  const [code, setCode] = useState('');
  const [pin, setPin] = useState('');
  const [step, setStep] = useState<'code' | 'pin'>('code');
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [scanning, setScanning] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const url = new URL(location.href);
    const fromUrl = url.searchParams.get('token');
    if (fromUrl) {
      localStorage.setItem(TOKEN_KEY, fromUrl);
      history.replaceState(null, '', '/kiosco'); // que el token no quede en la barra
    }
    const t = fromUrl ?? localStorage.getItem(TOKEN_KEY);
    setToken(t);
    if (t) call('device', t).then(setInfo).catch((e) => setError(e.message));
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const show = (r: { ok: boolean; text: string }) => {
    setResult(r);
    setCode('');
    setPin('');
    setStep('code');
    setTimeout(() => setResult(null), 4000);
  };

  const clock = async (body: Record<string, string>) => {
    try {
      const r = await call('device/clock', token!, { ...body, idempotencyKey: newIdempotencyKey() });
      const at = new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: info?.timezone }).format(new Date(r.at));
      show({ ok: true, text: `Hola, ${r.name}. ${KIND[r.kind]} registrada a las ${at}.` });
    } catch (e) {
      show({ ok: false, text: (e as Error).message });
    }
  };

  const press = (d: string) => {
    if (step === 'code') {
      const next = (code + d).slice(0, 6);
      setCode(next);
      if (next.length === 6) setStep('pin');
    } else {
      const next = (pin + d).slice(0, 6);
      setPin(next);
    }
  };

  const scan = async () => {
    const Detector = (window as any).BarcodeDetector;
    if (!Detector) return show({ ok: false, text: 'Este navegador no puede leer códigos QR. Usa tu código y PIN.' });
    setScanning(true);
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play();
      const detector = new Detector({ formats: ['qr_code'] });
      const started = Date.now();
      while (Date.now() - started < 20_000) {
        const codes = await detector.detect(video);
        if (codes.length) {
          await clock({ qr: codes[0].rawValue });
          return;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      show({ ok: false, text: 'No se ha leído ningún QR.' });
    } catch {
      show({ ok: false, text: 'No se puede usar la cámara.' });
    } finally {
      stream?.getTracks().forEach((t) => t.stop());
      setScanning(false);
    }
  };

  if (!token || error) {
    return (
      <div className="kiosk">
        <div className="kiosk-panel">
          <h1>Kiosco de fichaje</h1>
          <p>{error ?? 'Abre este kiosco con el enlace que genera RR. HH. en Organización → Centros → Kioscos.'}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="kiosk">
      <div className="kiosk-panel">
        <p className="kiosk-place">
          {info?.company_name} · {info?.work_center_name}
        </p>
        <div className="kiosk-time">{new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: info?.timezone }).format(now)}</div>
        {result ? (
          <div className={result.ok ? 'kiosk-result ok' : 'kiosk-result ko'} role="status">
            {result.text}
          </div>
        ) : scanning ? (
          <video ref={videoRef} className="kiosk-video" muted playsInline />
        ) : (
          <>
            <p className="kiosk-prompt">{step === 'code' ? 'Escribe tu código de 6 cifras' : 'Ahora tu PIN y pulsa Fichar'}</p>
            <div className="kiosk-display" aria-live="polite">
              {step === 'code' ? code.padEnd(6, '·') : '•'.repeat(pin.length).padEnd(4, '·')}
            </div>
            <div className="kiosk-keys">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
                <button key={d} onClick={() => press(d)}>
                  {d}
                </button>
              ))}
              <button
                onClick={() => {
                  setCode('');
                  setPin('');
                  setStep('code');
                }}
              >
                Borrar
              </button>
              <button onClick={() => press('0')}>0</button>
              <button className="go" disabled={step !== 'pin' || pin.length < 4} onClick={() => clock({ code, pin })}>
                Fichar
              </button>
            </div>
            <button className="kiosk-qr" onClick={scan}>
              Fichar con mi QR
            </button>
          </>
        )}
      </div>
    </div>
  );
}
