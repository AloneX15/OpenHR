import { SignatureEvidence, stampSignaturePage } from './signatures.service';

/** Nivel de la firma según el Reglamento eIDAS. */
export type SignatureLevel = 'simple' | 'advanced' | 'qualified';

/**
 * Adaptador de firma: convierte el PDF original en el PDF firmado.
 *
 * OpenHR hace siempre lo mismo antes de llamarlo: identifica a la persona (sesión y código
 * de un solo uso por email), recoge las evidencias y, después, guarda el resultado. Lo
 * único que cambia de un proveedor a otro es cómo se firma el fichero. Un proveedor de
 * firma avanzada o cualificada sellaría aquí el PDF con un certificado y devolvería en
 * `providerEvidence` sus identificadores (transacción, certificado…), que se guardan con
 * el resto de evidencias.
 *
 * Límite: `sign` responde en la misma petición. Un proveedor cuyo proceso de firma ocurre
 * en su propia web (redirección y aviso posterior) no encaja sin ampliar esta interfaz.
 */
export interface SignatureProvider {
  /** Identificador que queda en las evidencias, por ejemplo `simple`. */
  readonly id: string;
  readonly level: SignatureLevel;
  sign(original: Buffer, evidence: SignatureEvidence): Promise<{ pdf: Buffer; providerEvidence?: Record<string, unknown> }>;
}

export const SIGNATURE_PROVIDER = Symbol('SIGNATURE_PROVIDER');

/** Firma electrónica simple (eIDAS art. 3.10): hoja de evidencias añadida al PDF. */
export class SimpleSignatureProvider implements SignatureProvider {
  readonly id = 'simple';
  readonly level = 'simple' as const;

  async sign(original: Buffer, evidence: SignatureEvidence) {
    return { pdf: await stampSignaturePage(original, evidence) };
  }
}

/** Proveedores disponibles. Para añadir uno, impleméntalo y regístralo aquí. */
const PROVIDERS: Record<string, () => SignatureProvider> = {
  simple: () => new SimpleSignatureProvider(),
};

/** Proveedor elegido con SIGNATURE_PROVIDER; un nombre desconocido impide arrancar. */
export function createSignatureProvider(name: string): SignatureProvider {
  const create = PROVIDERS[name];
  if (!create) throw new Error(`SIGNATURE_PROVIDER desconocido: «${name}». Disponibles: ${Object.keys(PROVIDERS).join(', ')}`);
  return create();
}
