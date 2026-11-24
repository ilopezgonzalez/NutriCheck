import {
  AfterViewInit,
  DestroyRef,
  Directive,
  ElementRef,
  effect,
  inject,
  input,
  signal
} from '@angular/core';

/**
 * Ayuda visual para filas con scroll horizontal (carruseles de botones):
 *  - Difumina el borde por el que aún hay contenido (variables CSS --fade-izq / --fade-der,
 *    que el CSS usa en un mask-image).
 *  - La primera vez que la fila se ve en pantalla Y la directiva está activa (pistaActiva),
 *    hace un pequeño "empujón" automático hacia la derecha y vuelve, para que el usuario
 *    descubra que se puede desplazar. Se cancela si el usuario toca la fila y se omite con
 *    "reducir movimiento".
 *
 * pistaActiva permite retrasar el empujón mientras algo tapa la página (p. ej. la ventana de
 * aviso inicial): si no, la animación ocurriría detrás y el usuario nunca la vería.
 */
@Directive({
  selector: '[pistaScroll]',
  standalone: true
})
export class PistaScroll implements AfterViewInit {
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly destroyRef = inject(DestroyRef);

  readonly activa = input<boolean>(true, { alias: 'pistaActiva' });
  private readonly visible = signal(false);
  private pistaMostrada = false;

  private temporizadores: ReturnType<typeof setTimeout>[] = [];

  constructor() {
    // Cuando la fila es visible y la directiva está activa, se lanza el empujón (una sola vez)
    effect(() => {
      if (this.activa() && this.visible() && !this.pistaMostrada) {
        this.pistaMostrada = true;
        this.temporizadores.push(setTimeout(() => this.pista(), 1100));
      }
    });
  }

  ngAfterViewInit(): void {
    const el = this.el;

    const actualizar = () => {
      const max = el.scrollWidth - el.clientWidth;
      const hayScroll = max > 4;
      el.style.setProperty('--fade-izq', hayScroll && el.scrollLeft > 4 ? '30px' : '0px');
      el.style.setProperty('--fade-der', hayScroll && el.scrollLeft < max - 4 ? '30px' : '0px');
    };

    actualizar();
    el.addEventListener('scroll', actualizar, { passive: true });
    el.addEventListener('pointerdown', this.cancelarPista, { passive: true });

    const redimension = new ResizeObserver(actualizar);
    redimension.observe(el);

    const visibilidad = new IntersectionObserver(
      (entradas) => {
        if (entradas[0].isIntersecting) {
          this.visible.set(true);
          visibilidad.disconnect();
        }
      },
      { threshold: 0.6 }
    );
    visibilidad.observe(el);

    this.destroyRef.onDestroy(() => {
      el.removeEventListener('scroll', actualizar);
      el.removeEventListener('pointerdown', this.cancelarPista);
      redimension.disconnect();
      visibilidad.disconnect();
      this.cancelarPista();
    });
  }

  private readonly cancelarPista = (): void => {
    this.temporizadores.forEach(clearTimeout);
    this.temporizadores = [];
    this.el.style.scrollSnapType = '';
  };

  private pista(): void {
    const el = this.el;
    const max = el.scrollWidth - el.clientWidth;
    const reducir = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reducir || max <= 4) return;

    // Sin "snap" durante la animación para que el desplazamiento sea suave y vuelva al inicio
    el.style.scrollSnapType = 'none';
    el.scrollTo({ left: Math.min(90, max), behavior: 'smooth' });

    this.temporizadores.push(
      setTimeout(() => el.scrollTo({ left: 0, behavior: 'smooth' }), 900),
      setTimeout(() => (el.style.scrollSnapType = ''), 1700)
    );
  }
}
