import type { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

const API_URL = process.env.API_URL ?? 'http://localhost:3001';
const HOP_BY_HOP = ['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'host', 'content-length'];

/** Proxy transparente hacia la API: mismo origen para el navegador. */
async function proxy(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const target = `${API_URL}/api/${path.map(encodeURIComponent).join('/')}${req.nextUrl.search}`;
  const headers = new Headers(req.headers);
  HOP_BY_HOP.forEach((h) => headers.delete(h));
  headers.set('x-forwarded-for', req.headers.get('x-forwarded-for') ?? '');
  const hasBody = !['GET', 'HEAD'].includes(req.method);
  const res = await fetch(target, {
    method: req.method,
    headers,
    body: hasBody ? await req.arrayBuffer() : undefined,
    redirect: 'manual',
    cache: 'no-store',
  });
  const out = new Headers();
  res.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.includes(key) && key !== 'set-cookie' && key !== 'content-encoding') out.set(key, value);
  });
  for (const c of res.headers.getSetCookie()) out.append('set-cookie', c);
  return new Response(res.body, { status: res.status, headers: out });
}

export { proxy as GET, proxy as POST, proxy as PUT, proxy as PATCH, proxy as DELETE };
