'use client';

import QRCode from 'qrcode';
import { FormEvent, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { Badge, Card, Empty, ErrorBox, Field, Modal, Notice, useAction, useLoad } from './ui';

/** Mi cuenta → código y PIN del kiosco, y QR personal. */
export function KioskCredentials() {
  const { data, error, reload } = useLoad(() => api.get('/kiosk/me').catch(() => null));
  const [pin, setPin] = useState('');
  const [showQr, setShowQr] = useState(false);
  const action = useAction();
  if (!data) return error ? null : null;
  return (
    <Card title="Kiosco de fichaje">
      <p className="muted">Si tu centro tiene una tableta para fichar, identifícate con tu código y tu PIN o enseñando tu QR.</p>
      <ErrorBox error={action.error} />
      {data.code ? (
        <p>
          Tu código: <strong className="mono">{data.code}</strong> {data.hasPin && <Badge tone="success">PIN configurado</Badge>}
        </p>
      ) : (
        <Notice>Elige un PIN para obtener tu código.</Notice>
      )}
      <form
        className="row"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void action.run(async () => {
            await api.put('/kiosk/pin', { pin });
            setPin('');
            await reload();
          });
        }}
      >
        <input aria-label="Nuevo PIN" type="password" inputMode="numeric" pattern="\d{4,6}" placeholder="PIN de 4 a 6 cifras" value={pin} onChange={(e) => setPin(e.target.value)} style={{ width: 200 }} />
        <button className="btn" disabled={action.busy || pin.length < 4}>
          {data.hasPin ? 'Cambiar PIN' : 'Guardar PIN'}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => setShowQr(true)}>
          Mostrar mi QR
        </button>
      </form>
      {showQr && <QrModal onClose={() => setShowQr(false)} />}
    </Card>
  );
}

function QrModal({ onClose }: { onClose: () => void }) {
  const [img, setImg] = useState<string | null>(null);
  const [left, setLeft] = useState(60);
  useEffect(() => {
    let alive = true;
    let expires = 0;
    const refresh = async () => {
      const r = await api.get('/kiosk/qr');
      expires = Date.now() + (r.expiresIn - 10) * 1000;
      const url = await QRCode.toDataURL(r.token, { margin: 1, width: 260 });
      if (alive) setImg(url);
    };
    void refresh();
    const t = setInterval(() => {
      const s = Math.max(0, Math.round((expires - Date.now()) / 1000));
      setLeft(s);
      if (s === 0) void refresh();
    }, 1000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return (
    <Modal title="Mi QR para fichar" onClose={onClose}>
      <div style={{ textAlign: 'center' }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {img && <img src={img} alt="Código QR personal para fichar" width={260} height={260} style={{ background: 'var(--paper)', borderRadius: 8 }} />}
        <p className="muted small">Enséñalo a la cámara del kiosco. Cambia cada minuto (quedan {left} s).</p>
      </div>
    </Modal>
  );
}

/** Organización → Centros: kioscos de fichaje. */
export function KioskDevices() {
  const { data, error, reload } = useLoad(() => api.get<any[]>('/kiosk/devices'));
  const centers = useLoad(() => api.get<any[]>('/org/work-centers'));
  const [f, setF] = useState({ workCenterId: '', name: '' });
  const [link, setLink] = useState<string | null>(null);
  const action = useAction();
  return (
    <Card title="Kioscos de fichaje">
      <p className="muted">Una tableta en la entrada del centro donde cada persona ficha con su código y PIN o con su QR.</p>
      <ErrorBox error={error || action.error} />
      {link && (
        <Notice tone="success">
          Abre este enlace una sola vez en la tableta (se guarda en ella): <span className="mono">{link}</span>
        </Notice>
      )}
      <form
        className="row"
        style={{ marginBottom: 12 }}
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            const r = await api.post('/kiosk/devices', { workCenterId: f.workCenterId || centers.data?.[0]?.id, name: f.name });
            setLink(`${location.origin}/kiosco?token=${r.token}`);
            setF({ ...f, name: '' });
            await reload();
          });
        }}
      >
        <select aria-label="Centro" value={f.workCenterId || centers.data?.[0]?.id || ''} onChange={(e) => setF({ ...f, workCenterId: e.target.value })} style={{ width: 'auto' }}>
          {centers.data?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} · {c.company_name}
            </option>
          ))}
        </select>
        <input aria-label="Nombre del kiosco" required placeholder="Tableta de recepción" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} style={{ flex: 1 }} />
        <button className="btn btn-primary" disabled={action.busy}>
          Crear kiosco
        </button>
      </form>
      {data?.length ? (
        <ul className="list small">
          {data.map((d) => (
            <li key={d.id} className="spread">
              <span>
                <strong>{d.name}</strong> · {d.work_center_name} ({d.company_name})
                <div className="muted">Última actividad: {d.last_seen_at ? dateTime(d.last_seen_at) : 'nunca'}</div>
              </span>
              {d.active ? (
                <button className="btn btn-sm btn-danger" disabled={action.busy} onClick={() => confirm('¿Desactivar este kiosco?') && action.run(async () => (await api.del(`/kiosk/devices/${d.id}`), reload()))}>
                  Desactivar
                </button>
              ) : (
                <Badge>Desactivado</Badge>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <Empty>Sin kioscos.</Empty>
      )}
    </Card>
  );
}

/** Campos de la zona de fichaje en el formulario de un centro. */
export function GeoFields({ value, onChange }: { value: any; onChange: (v: any) => void }) {
  const [locating, setLocating] = useState(false);
  return (
    <>
      <h3>Zona de fichaje</h3>
      <Field label="Ubicación al fichar">
        <select value={value.geoPolicy} onChange={(e) => onChange({ ...value, geoPolicy: e.target.value })}>
          <option value="off">No se usa (no se guarda la ubicación)</option>
          <option value="record">Se registra si la persona la comparte</option>
          <option value="require">Obligatoria: solo se ficha dentro de la zona</option>
        </select>
      </Field>
      {value.geoPolicy !== 'off' && (
        <>
          <div className="form-grid">
            <Field label="Latitud">
              <input type="number" step="any" required value={value.latitude ?? ''} onChange={(e) => onChange({ ...value, latitude: e.target.value === '' ? null : Number(e.target.value) })} />
            </Field>
            <Field label="Longitud">
              <input type="number" step="any" required value={value.longitude ?? ''} onChange={(e) => onChange({ ...value, longitude: e.target.value === '' ? null : Number(e.target.value) })} />
            </Field>
            <Field label="Radio (metros)">
              <input type="number" min={20} max={5000} required value={value.radiusM ?? 150} onChange={(e) => onChange({ ...value, radiusM: Number(e.target.value) })} />
            </Field>
          </div>
          <button
            type="button"
            className="btn btn-sm"
            disabled={locating}
            onClick={() => {
              setLocating(true);
              navigator.geolocation.getCurrentPosition(
                (p) => {
                  onChange({ ...value, latitude: Number(p.coords.latitude.toFixed(6)), longitude: Number(p.coords.longitude.toFixed(6)) });
                  setLocating(false);
                },
                () => setLocating(false),
                { enableHighAccuracy: true, timeout: 10000 },
              );
            }}
          >
            Usar mi ubicación actual
          </button>
          <p className="muted small">Solo se pide la ubicación en el momento de fichar; nunca se sigue a nadie. Quien tenga teletrabajo permitido puede fichar fuera.</p>
        </>
      )}
    </>
  );
}
