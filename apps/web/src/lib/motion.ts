'use client';

import gsap from 'gsap';
import { useEffect, useLayoutEffect, useRef } from 'react';

/**
 * Movimiento de la interfaz con GSAP. Todo pasa por aquí para que las reglas sean las
 * mismas en toda la aplicación: animaciones cortas, que acompañan a una acción de la
 * persona y que desaparecen si tiene activado «reducir movimiento».
 */

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Entrada escalonada de los hijos directos de un contenedor, al montar y cuando cambia `key`. */
export function useStagger<T extends HTMLElement>(key?: unknown) {
  const ref = useRef<T>(null);
  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el || prefersReducedMotion() || !el.children.length) return;
    const ctx = gsap.context(() => {
      gsap.from(el.children, { y: 16, autoAlpha: 0, duration: 0.45, ease: 'power3.out', stagger: 0.06, clearProps: 'transform,opacity,visibility' });
    }, el);
    return () => ctx.revert();
  }, [key]);
  return ref;
}

/** Aparición de un desplegable: crece desde su origen y sus opciones entran en cascada. */
export function usePopIn<T extends HTMLElement>(open: boolean) {
  const ref = useRef<T>(null);
  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!open || !el || prefersReducedMotion()) return;
    const ctx = gsap.context(() => {
      gsap.from(el, { autoAlpha: 0, scale: 0.96, y: el.classList.contains('drop-up') ? 8 : -8, duration: 0.2, ease: 'power3.out', clearProps: 'transform,opacity,visibility' });
      gsap.from(el.children, { autoAlpha: 0, x: -6, duration: 0.22, ease: 'power2.out', stagger: 0.025, delay: 0.04, clearProps: 'transform,opacity,visibility' });
    }, el);
    return () => ctx.revert();
  }, [open]);
  return ref;
}

/** Entrada de una ventana: en escritorio se acerca; en móvil sube desde abajo. */
export function useModalIn<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el || prefersReducedMotion()) return;
    const sheet = window.matchMedia('(max-width: 600px)').matches;
    const ctx = gsap.context(() => {
      if (el.parentElement) gsap.from(el.parentElement, { backgroundColor: 'rgba(0,0,0,0)', duration: 0.25, clearProps: 'backgroundColor' });
      gsap.from(el, sheet ? { yPercent: 100, duration: 0.38, ease: 'power3.out', clearProps: 'transform' } : { y: 18, scale: 0.97, autoAlpha: 0, duration: 0.28, ease: 'power3.out', clearProps: 'transform,opacity,visibility' });
    });
    return () => ctx.revert();
  }, []);
  return ref;
}

/** Plegado y desplegado en altura. El contenido queda fuera del foco mientras está plegado. */
export function useCollapse<T extends HTMLElement>(open: boolean) {
  const ref = useRef<T>(null);
  const first = useRef(true);
  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (first.current || prefersReducedMotion()) {
      first.current = false;
      gsap.set(el, { height: open ? 'auto' : 0, display: open ? '' : 'none' });
      return;
    }
    gsap.killTweensOf(el);
    if (open) {
      gsap.set(el, { display: '' });
      gsap.fromTo(el, { height: el.offsetHeight }, { height: 'auto', duration: 0.32, ease: 'power3.out' });
      gsap.from(el.children, { autoAlpha: 0, y: -6, duration: 0.25, delay: 0.06, clearProps: 'transform,opacity,visibility' });
    } else {
      gsap.to(el, { height: 0, duration: 0.24, ease: 'power2.inOut', onComplete: () => void gsap.set(el, { display: 'none' }) });
    }
  }, [open]);
  return ref;
}

/** Anima el ancho de las barras de progreso marcadas con data-grow cuando cambian. */
export function useGrow<T extends HTMLElement>(key?: unknown) {
  const ref = useRef<T>(null);
  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el || prefersReducedMotion()) return;
    const bars = el.querySelectorAll('[data-grow]');
    if (!bars.length) return;
    const ctx = gsap.context(() => {
      gsap.from(bars, { scaleX: 0, transformOrigin: 'left center', duration: 0.6, ease: 'power3.out', stagger: 0.05, clearProps: 'transform' });
    }, el);
    return () => ctx.revert();
  }, [key]);
  return ref;
}

/**
 * Respuesta al pulsar: los botones se hunden un poco y vuelven con un rebote corto.
 * Se instala una sola vez para toda la página (delegación de eventos).
 */
export function installPressFeedback(): () => void {
  if (prefersReducedMotion()) return () => undefined;
  const down = (e: PointerEvent) => {
    const target = (e.target as Element | null)?.closest?.('.btn, .btn-icon, .tabbar-fab, .tabbar-item');
    if (!target || (target as HTMLButtonElement).disabled) return;
    gsap.to(target, { scale: 0.95, duration: 0.12, ease: 'power2.out', overwrite: true });
    const up = () => {
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      gsap.to(target, { scale: 1, duration: 0.55, ease: 'elastic.out(1, 0.45)', overwrite: true, clearProps: 'transform' });
    };
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };
  document.addEventListener('pointerdown', down);
  return () => document.removeEventListener('pointerdown', down);
}
