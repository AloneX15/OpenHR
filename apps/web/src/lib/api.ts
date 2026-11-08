export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: any,
  ) {
    super(message);
  }
}

async function handle<T>(res: Response): Promise<T> {
  if (res.ok) {
    const type = res.headers.get('content-type') ?? '';
    return (type.includes('application/json') ? res.json() : (res.text() as any)) as Promise<T>;
  }
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    /* sin cuerpo JSON */
  }
  const detail = body?.issues?.map((i: any) => `${i.path ? `${i.path}: ` : ''}${i.message}`).join(' · ');
  const message = detail || (Array.isArray(body?.message) ? body.message.join(' · ') : body?.message) || `Error ${res.status}`;
  if (res.status === 401 && typeof window !== 'undefined' && !location.pathname.startsWith('/login')) {
    window.dispatchEvent(new Event('openhr:unauthorized'));
  }
  throw new ApiError(res.status, message, body);
}

function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  return fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then((r) => handle<T>(r));
}

export const api = {
  get: <T = any>(path: string) => request<T>('GET', path),
  post: <T = any>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  patch: <T = any>(path: string, body: unknown) => request<T>('PATCH', path, body),
  put: <T = any>(path: string, body: unknown) => request<T>('PUT', path, body),
  del: <T = any>(path: string) => request<T>('DELETE', path),
  upload: <T = any>(path: string, form: FormData) =>
    fetch(`/api${path}`, { method: 'POST', body: form, credentials: 'same-origin' }).then((r) => handle<T>(r)),
};

/** Descarga un fichero de la API respetando el nombre que propone el servidor. */
export async function download(path: string) {
  const res = await fetch(`/api${path}`, { credentials: 'same-origin' });
  if (!res.ok) await handle(res);
  const blob = await res.blob();
  const disposition = res.headers.get('content-disposition') ?? '';
  const match = /filename\*=UTF-8''([^;]+)/.exec(disposition) ?? /filename="([^"]+)"/.exec(disposition);
  const name = match ? decodeURIComponent(match[1]) : 'descarga';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function newIdempotencyKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
