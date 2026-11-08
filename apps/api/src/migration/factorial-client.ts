/**
 * Cliente mínimo de la API pública de Factorial (https://apidoc.factorialhr.com), versión
 * 2026-10-01. Autenticación con clave de API (cabecera x-api-key), paginación por cursor
 * (limit ≤ 100, after_id = meta.end_cursor) y reintentos con espera exponencial en 429/5xx.
 */

export const FACTORIAL_VERSION = '2026-10-01';
export const FACTORIAL_HOSTS = {
  production: 'https://api.factorialhr.com',
  demo: 'https://api.eu2.demo.factorial.dev',
} as const;

interface Page<T> {
  data: T[];
  meta?: { has_next_page?: boolean; end_cursor?: string | null };
}

export class FactorialError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class FactorialClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
    private readonly version = FACTORIAL_VERSION,
    private readonly retryDelaysMs = [2000, 4000, 8000, 16000],
  ) {}

  private async get<T>(path: string, params: Record<string, string | string[] | undefined>): Promise<Page<T>> {
    const url = new URL(`${this.baseUrl}/api/${this.version}/resources/${path}`);
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, x));
      else url.searchParams.set(k, v);
    }
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, { headers: { 'x-api-key': this.apiKey, accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(60_000) });
      if (res.ok) return (await res.json()) as Page<T>;
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < this.retryDelaysMs.length) {
        await sleep(this.retryDelaysMs[attempt]);
        continue;
      }
      if (res.status === 401) throw new FactorialError(401, 'Factorial rechaza la clave de API (¿caducada o del entorno equivocado?)');
      if (res.status === 403) throw new FactorialError(403, `La clave de API no tiene permiso para ${path}`);
      throw new FactorialError(res.status, `Factorial respondió ${res.status} en ${path}`);
    }
  }

  /** Recorre todas las páginas de un recurso. */
  async *all<T>(path: string, params: Record<string, string | string[] | undefined> = {}): AsyncGenerator<T> {
    let after: string | undefined;
    for (;;) {
      const page = await this.get<T>(path, { ...params, limit: '100', after_id: after });
      for (const item of page.data ?? []) yield item;
      if (!page.meta?.has_next_page || !page.meta.end_cursor) return;
      after = page.meta.end_cursor;
    }
  }

  async list<T>(path: string, params: Record<string, string | string[] | undefined> = {}): Promise<T[]> {
    const out: T[] = [];
    for await (const x of this.all<T>(path, params)) out.push(x);
    return out;
  }
}

// Tipos de la especificación OpenAPI 2026-10-01 (solo los campos que se usan).
export interface FEmployee {
  id: string | number;
  first_name: string;
  last_name: string;
  email?: string | null;
  login_email?: string | null;
  identifier?: string | null;
  identifier_type?: string | null;
  birthday_on?: string | null;
  gender?: string | null;
  phone_number?: string | null;
  legal_entity_id?: string | number | null;
  location_id?: string | number | null;
  manager_id?: string | number | null;
  terminated_on?: string | null;
  seniority_calculation_date?: string | null;
  created_at?: string;
  active?: boolean;
}
export interface FLegalEntity {
  id: string | number;
  legal_name: string;
  tin?: string | null;
  country?: string;
  address_line_1?: string | null;
  city?: string | null;
}
export interface FLocation {
  id: string | number;
  name: string;
  timezone?: string | null;
  address_line_1?: string | null;
  city?: string | null;
}
export interface FTeam {
  id: string | number;
  name: string;
  employee_ids?: (string | number)[];
}
export interface FContractVersion {
  id?: string | number;
  employee_id: string | number;
  effective_on: string;
  starts_on?: string | null;
  ends_on?: string | null;
  job_title?: string | null;
  working_hours?: number | null;
  working_hours_frequency?: string | null;
  salary_amount?: number | null;
  salary_frequency?: string | null;
}
export interface FLeaveType {
  id: string | number;
  name: string;
  identifier?: string | null;
  active?: boolean;
  approval_required?: boolean;
  payable?: boolean;
}
export interface FLeave {
  id: string | number;
  employee_id: string | number;
  start_on: string;
  finish_on?: string | null;
  half_day?: string | null;
  leave_type_id?: string | number | null;
  leave_type_name?: string | null;
  approved?: boolean | null;
  description?: string | null;
  days_taken?: number | null;
  deleted_at?: string | null;
}
export interface FShift {
  id: string | number;
  employee_id: string | number;
  date: string;
  clock_in?: string | null;
  clock_out?: string | null;
  clock_in_with_seconds?: string | null;
  workable?: boolean | null;
}
