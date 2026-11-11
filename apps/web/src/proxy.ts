import { NextRequest, NextResponse } from 'next/server';

const isProd = process.env.NODE_ENV === 'production';

/**
 * Política de seguridad de contenidos de las páginas, con un nonce distinto en cada
 * petición: solo se ejecutan los scripts que lo llevan (los de Next.js y el del tema) y los
 * que estos cargan ('strict-dynamic'). No hace falta 'unsafe-inline' en script-src; en
 * desarrollo React necesita 'unsafe-eval'. Los estilos en línea siguen permitidos porque
 * React escribe atributos style.
 */
export function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isProd ? '' : " 'unsafe-eval'"}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'self'",
    "frame-ancestors 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64');
  const csp = contentSecurityPolicy(nonce);
  // Next.js lee el nonce de esta cabecera de la petición y lo pone en sus scripts; el
  // layout raíz lo lee de x-nonce para el script del tema.
  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('Content-Security-Policy', csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  // Solo páginas: ni la API (la reenvía el route handler), ni estáticos, ni ficheros de public/.
  matcher: ['/((?!api/|_next/static|_next/image|.*\\..*).*)'],
};
