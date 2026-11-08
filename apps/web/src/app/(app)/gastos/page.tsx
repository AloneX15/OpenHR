'use client';

import { useSearchParams } from 'next/navigation';
import { FormEvent, Suspense, useState } from 'react';
import { IconButton } from '@/components/icons';
import { Badge, Card, Empty, ErrorBox, Field, Modal, Notice, PageHeader, Tabs, useAction, useLoad } from '@/components/ui';
import { api, download } from '@/lib/api';
import { dayLabel, todayIso } from '@/lib/format';
import { useSession } from '@/lib/session';

type Tab = 'mios' | 'aprobar' | 'todos' | 'categorias';

const STATUS: Record<string, { label: string; tone: any }> = {
  pending: { label: 'Pendiente', tone: 'warning' },
  approved: { label: 'Aprobado', tone: 'info' },
  paid: { label: 'Abonado', tone: 'success' },
  rejected: { label: 'Rechazado', tone: 'danger' },
  cancelled: { label: 'Anulado', tone: 'neutral' },
};
const STAGE: Record<string, string> = { manager: 'responsable', hr: 'RR. HH.' };

const eur = (cents: number) => new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(cents / 100);

function ExpensesContent() {
  const { me } = useSession();
  const canApprove = me.isManager || me.isHr;
  const canCatalog = me.isAdmin || (me.isHr && me.hrCompanyIds === null);
  const initial = (useSearchParams().get('tab') as Tab) || 'mios';
  const [tab, setTab] = useState<Tab>(canApprove ? initial : 'mios');
  const tabs: { id: Tab; label: string }[] = [];
  if (me.employments.length) tabs.push({ id: 'mios', label: 'Mis gastos' });
  if (canApprove) tabs.push({ id: 'aprobar', label: 'Por aprobar' });
  if (me.isHr) tabs.push({ id: 'todos', label: 'Todos y abono' });
  if (canCatalog) tabs.push({ id: 'categorias', label: 'Categorías' });
  const current = tabs.some((t) => t.id === tab) ? tab : tabs[0]?.id;

  return (
    <>
      <PageHeader title="Gastos" subtitle="Tickets, kilometraje y su reembolso con la nómina." />
      {tabs.length > 1 && <Tabs value={current} onChange={setTab} tabs={tabs} />}
      {current === 'mios' && <MyExpenses />}
      {current === 'aprobar' && <ToApprove />}
      {current === 'todos' && <AllExpenses />}
      {current === 'categorias' && <Categories />}
    </>
  );
}

export default function ExpensesPage() {
  return (
    <Suspense>
      <ExpensesContent />
    </Suspense>
  );
}

function StatusBadge({ x }: { x: any }) {
  return (
    <>
      <Badge tone={STATUS[x.status].tone}>{STATUS[x.status].label}</Badge>
      {x.status === 'pending' && <div className="small muted">Espera a {STAGE[x.stage]}</div>}
    </>
  );
}

function Amount({ x }: { x: any }) {
  return (
    <>
      {eur(x.amount_cents)}
      {x.km && <div className="small muted">{Number(x.km).toLocaleString('es-ES')} km</div>}
      {x.over_limit && <div className="small" style={{ color: 'var(--warning)' }}>Supera el límite de {eur(x.limit_cents)}</div>}
    </>
  );
}

function ReceiptLink({ x }: { x: any }) {
  return x.has_receipt ? (
    <a className="btn btn-sm" href={`/api/expenses/${x.id}/receipt`} target="_blank" rel="noreferrer">
      Justificante
    </a>
  ) : null;
}

function MyExpenses() {
  const { data, error, reload } = useLoad(() => api.get<any[]>('/expenses/mine'));
  const [creating, setCreating] = useState(false);
  const action = useAction();
  const total = (data ?? []).filter((x) => x.status === 'pending' || x.status === 'approved').reduce((s, x) => s + x.amount_cents, 0);
  return (
    <Card
      title={total ? `Pendiente de cobrar: ${eur(total)}` : undefined}
      actions={
        <IconButton icon="plus" className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
          Nuevo gasto
        </IconButton>
      }
    >
      <ErrorBox error={error || action.error} />
      {data?.length ? (
        <table>
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Concepto</th>
              <th className="num">Importe</th>
              <th>Estado</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data.map((x) => (
              <tr key={x.id}>
                <td>{dayLabel(x.expense_date)}</td>
                <td>
                  {x.description}
                  <div className="small muted">{x.category_name}</div>
                  {x.decision_comment && <div className="small muted">«{x.decision_comment}»</div>}
                </td>
                <td className="num">
                  <Amount x={x} />
                </td>
                <td>
                  <StatusBadge x={x} />
                  {x.paid_period && <div className="small muted">Nómina {x.paid_period}</div>}
                </td>
                <td className="num">
                  <ReceiptLink x={x} />{' '}
                  {x.status === 'pending' && (
                    <button className="btn btn-ghost btn-sm" disabled={action.busy} onClick={() => action.run(async () => (await api.post(`/expenses/${x.id}/cancel`), reload()))}>
                      Anular
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>Aún no has enviado gastos. Haz una foto del ticket y envíalo desde aquí.</Empty>
      )}
      {creating && <NewExpense onClose={() => setCreating(false)} onDone={reload} />}
    </Card>
  );
}

function NewExpense({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<void> }) {
  const { me } = useSession();
  const cats = useLoad(() => api.get<any[]>('/expenses/categories'));
  const [f, setF] = useState({ employmentId: me.employments[0]?.id ?? '', categoryId: '', date: todayIso(), description: '', amount: '', km: '' });
  const [file, setFile] = useState<File | null>(null);
  const { busy, error, run } = useAction();
  const cat = cats.data?.find((c) => c.id === f.categoryId);
  const mileage = cat?.kind === 'mileage';
  const kmValue = Number(f.km.replace(',', '.'));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const form = new FormData();
      form.set('employmentId', f.employmentId);
      form.set('categoryId', f.categoryId);
      form.set('date', f.date);
      form.set('description', f.description);
      if (mileage) form.set('km', f.km);
      else form.set('amount', f.amount);
      if (file) form.set('receipt', file);
      await api.upload('/expenses', form);
      await onDone();
      onClose();
    });
  };

  return (
    <Modal title="Nuevo gasto" onClose={onClose}>
      <form onSubmit={submit}>
        <ErrorBox error={error || cats.error} />
        {me.employments.length > 1 && (
          <Field label="Sociedad">
            <select value={f.employmentId} onChange={(e) => setF({ ...f, employmentId: e.target.value })}>
              {me.employments.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.company_name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Categoría">
          <select required value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value })}>
            <option value="">Elige…</option>
            {cats.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="grid grid-2" style={{ gap: 12 }}>
          <Field label="Fecha">
            <input type="date" required max={todayIso()} value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
          </Field>
          {mileage ? (
            <Field label="Kilómetros" hint={kmValue > 0 ? `${eur(Math.round(kmValue * cat.rate_cents_per_km))} a ${eur(cat.rate_cents_per_km)}/km` : `Se paga a ${eur(cat.rate_cents_per_km)}/km`}>
              <input inputMode="decimal" required pattern="[0-9]+([,.][0-9])?" value={f.km} onChange={(e) => setF({ ...f, km: e.target.value })} />
            </Field>
          ) : (
            <Field label="Importe (€)" hint={cat?.limit_cents ? `Límite orientativo: ${eur(cat.limit_cents)}` : undefined}>
              <input inputMode="decimal" required pattern="[0-9]+([,.][0-9]{1,2})?" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
            </Field>
          )}
        </div>
        <Field label="Concepto">
          <input required maxLength={500} placeholder={mileage ? 'Origen, destino y motivo' : 'Qué y para qué'} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </Field>
        <Field label={cat?.requires_receipt === false ? 'Justificante (opcional)' : 'Justificante'} hint="Foto del ticket o PDF, hasta 10 MB.">
          <input type="file" accept="image/*,application/pdf" capture="environment" required={cat?.requires_receipt !== false} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </Field>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-primary" disabled={busy}>
            Enviar
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ToApprove() {
  const { data, error, reload } = useLoad(() => api.get<any[]>('/expenses/to-approve'));
  const [rejecting, setRejecting] = useState<any | null>(null);
  const action = useAction();
  const approve = (x: any) => action.run(async () => (await api.post(`/expenses/${x.id}/decision`, { approve: true }), reload()));
  return (
    <Card>
      <ErrorBox error={error || action.error} />
      {data?.length ? (
        <table>
          <thead>
            <tr>
              <th>Persona</th>
              <th>Gasto</th>
              <th className="num">Importe</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data.map((x) => (
              <tr key={x.id}>
                <td>
                  {x.person_name}
                  <div className="small muted">{x.company_name}</div>
                </td>
                <td>
                  {x.description}
                  <div className="small muted">
                    {x.category_name} · {dayLabel(x.expense_date)} · paso de {STAGE[x.stage]}
                  </div>
                </td>
                <td className="num">
                  <Amount x={x} />
                </td>
                <td className="num">
                  <ReceiptLink x={x} />{' '}
                  <button className="btn btn-ghost btn-sm" onClick={() => setRejecting(x)}>
                    Rechazar
                  </button>{' '}
                  <IconButton icon="check" className="btn btn-primary btn-sm" disabled={action.busy} onClick={() => approve(x)}>
                    Aprobar
                  </IconButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>No tienes gastos por aprobar.</Empty>
      )}
      {rejecting && <RejectModal x={rejecting} onClose={() => setRejecting(null)} onDone={reload} />}
    </Card>
  );
}

function RejectModal({ x, onClose, onDone }: { x: any; onClose: () => void; onDone: () => Promise<void> }) {
  const [comment, setComment] = useState('');
  const { busy, error, run } = useAction();
  return (
    <Modal title={`Rechazar gasto de ${x.person_name}`} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api.post(`/expenses/${x.id}/decision`, { approve: false, comment });
            await onDone();
            onClose();
          });
        }}
      >
        <ErrorBox error={error} />
        <Field label="Motivo (lo verá la persona)">
          <input required minLength={3} maxLength={500} value={comment} onChange={(e) => setComment(e.target.value)} autoFocus />
        </Field>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Volver
          </button>
          <button className="btn btn-danger" disabled={busy}>
            Rechazar
          </button>
        </div>
      </form>
    </Modal>
  );
}

function AllExpenses() {
  const [status, setStatus] = useState('approved');
  const [period, setPeriod] = useState(todayIso().slice(0, 7));
  const { data, error, reload } = useLoad(() => api.get<any[]>(`/expenses?status=${status}`), [status]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const action = useAction();
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };
  const total = (data ?? []).filter((x) => selected.has(x.id)).reduce((s, x) => s + x.amount_cents, 0);
  return (
    <Card
      actions={
        <IconButton icon="download" className="btn btn-sm" onClick={() => action.run(() => download(`/expenses/export?status=approved`))}>
          CSV para nómina
        </IconButton>
      }
    >
      <div className="row" style={{ marginBottom: 12 }}>
        <select style={{ width: "auto" }} value={status} onChange={(e) => (setStatus(e.target.value), setSelected(new Set()))} aria-label="Estado">
          {Object.entries(STATUS).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </select>
        {status === 'approved' && (
          <>
            <input type="month" style={{ width: "auto" }} value={period} onChange={(e) => setPeriod(e.target.value)} aria-label="Nómina en la que se abonan" />
            <button
              className="btn btn-primary btn-sm"
              disabled={!selected.size || action.busy}
              onClick={() =>
                action.run(async () => {
                  await api.post('/expenses/pay', { ids: [...selected], period });
                  setSelected(new Set());
                  await reload();
                })
              }
            >
              Marcar {selected.size || ''} como abonados {total ? `(${eur(total)})` : ''}
            </button>
          </>
        )}
      </div>
      <ErrorBox error={error || action.error} />
      {status === 'approved' && <Notice>Descarga el CSV, añade los importes a la nómina y márcalos como abonados en el mes correspondiente.</Notice>}
      {data?.length ? (
        <table>
          <thead>
            <tr>
              {status === 'approved' && <th></th>}
              <th>Persona</th>
              <th>Gasto</th>
              <th className="num">Importe</th>
              <th>Estado</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data.map((x) => (
              <tr key={x.id}>
                {status === 'approved' && (
                  <td>
                    <input type="checkbox" checked={selected.has(x.id)} onChange={() => toggle(x.id)} aria-label={`Seleccionar gasto de ${x.person_name}`} />
                  </td>
                )}
                <td>
                  {x.person_name}
                  <div className="small muted">{x.company_name}</div>
                </td>
                <td>
                  {x.description}
                  <div className="small muted">
                    {x.category_name} · {dayLabel(x.expense_date)}
                  </div>
                </td>
                <td className="num">
                  <Amount x={x} />
                </td>
                <td>
                  <StatusBadge x={x} />
                  {x.paid_period && <div className="small muted">Nómina {x.paid_period}</div>}
                </td>
                <td className="num">
                  <ReceiptLink x={x} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>No hay gastos en este estado.</Empty>
      )}
    </Card>
  );
}

function Categories() {
  const { data, error, reload } = useLoad(() => api.get<any[]>('/expenses/categories?all=true'));
  const [editing, setEditing] = useState<any | null>(null);
  return (
    <Card
      actions={
        <IconButton icon="plus" className="btn btn-sm" onClick={() => setEditing({ name: '', kind: 'amount', requires_receipt: true, active: true })}>
          Nueva categoría
        </IconButton>
      }
    >
      <ErrorBox error={error} />
      <table>
        <thead>
          <tr>
            <th>Categoría</th>
            <th>Cálculo</th>
            <th>Límite</th>
            <th>Justificante</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {data?.map((c) => (
            <tr key={c.id} className={c.active ? undefined : 'muted'}>
              <td>
                {c.name} {!c.active && <Badge>Inactiva</Badge>}
              </td>
              <td>{c.kind === 'mileage' ? `${eur(c.rate_cents_per_km)}/km` : 'Importe del ticket'}</td>
              <td>{c.limit_cents ? eur(c.limit_cents) : '—'}</td>
              <td>{c.requires_receipt ? 'Obligatorio' : 'Opcional'}</td>
              <td className="num">
                <IconButton icon="edit" className="btn btn-ghost btn-sm" onClick={() => setEditing(c)}>
                  Editar
                </IconButton>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {editing && <CategoryModal c={editing} onClose={() => setEditing(null)} onDone={reload} />}
    </Card>
  );
}

function CategoryModal({ c, onClose, onDone }: { c: any; onClose: () => void; onDone: () => Promise<void> }) {
  const [f, setF] = useState({
    name: c.name,
    kind: c.kind,
    rate: c.rate_cents_per_km ? String(c.rate_cents_per_km / 100).replace('.', ',') : '0,26',
    limit: c.limit_cents ? String(c.limit_cents / 100).replace('.', ',') : '',
    requiresReceipt: c.requires_receipt,
    active: c.active,
  });
  const { busy, error, run } = useAction();
  const cents = (v: string) => (v.trim() ? Math.round(Number(v.replace(',', '.')) * 100) : null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const body = { name: f.name, kind: f.kind, rateCentsPerKm: f.kind === 'mileage' ? cents(f.rate) : null, limitCents: cents(f.limit), requiresReceipt: f.requiresReceipt, active: f.active };
      if (c.id) await api.patch(`/expenses/categories/${c.id}`, body);
      else await api.post('/expenses/categories', body);
      await onDone();
      onClose();
    });
  };
  return (
    <Modal title={c.id ? 'Editar categoría' : 'Nueva categoría'} onClose={onClose}>
      <form onSubmit={submit}>
        <ErrorBox error={error} />
        <Field label="Nombre">
          <input required maxLength={80} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field label="Cálculo">
          <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
            <option value="amount">Importe del ticket</option>
            <option value="mileage">Kilometraje</option>
          </select>
        </Field>
        {f.kind === 'mileage' && (
          <Field label="Tarifa por km (€)" hint="0,26 €/km es el importe exento de IRPF.">
            <input inputMode="decimal" required value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} />
          </Field>
        )}
        <Field label="Límite orientativo por gasto (€)" hint="Se avisa si se supera; no lo impide.">
          <input inputMode="decimal" value={f.limit} onChange={(e) => setF({ ...f, limit: e.target.value })} />
        </Field>
        <label className="check">
          <input type="checkbox" checked={f.requiresReceipt} onChange={(e) => setF({ ...f, requiresReceipt: e.target.checked })} /> Justificante obligatorio
        </label>
        <label className="check">
          <input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Activa
        </label>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-primary" disabled={busy}>
            Guardar
          </button>
        </div>
      </form>
    </Modal>
  );
}
