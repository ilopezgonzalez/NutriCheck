import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
  OnInit,
  computed,
  effect,
  inject,
  signal,
  viewChild
} from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { catchError, debounceTime, distinctUntilChanged, map, merge, of, switchMap } from 'rxjs';
import {
  CATALOGO_ALERGENOS,
  CATALOGO_SUPERMERCADOS,
  Nutrientes100g,
  Producto
} from './models/producto.model';
import { PistaScroll } from './directives/pista-scroll';
import { OpenFoodService, ResultadoBusqueda } from './services/open-food.service';

const STORAGE_ALERGIAS = 'nutricheck_alergias_usuario';
const TAMANO_PAGINA = 24;
const STORAGE_AVISO = 'nutricheck_aviso_aceptado';
const DURACION_SALIDA_AVISO = 320; // ms, debe coincidir con la animación CSS de salida

export interface FilaComparacion {
  clave: keyof Nutrientes100g;
  etiqueta: string;
  unidad: string;
  objetivo: 'menor' | 'mayor'; // Indica si es mejor tener menos (azúcar) o más (proteína)
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [ReactiveFormsModule, PistaScroll],
  templateUrl: './app.html',
  styleUrl: './app.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class App implements OnInit {
  private readonly openFoodService = inject(OpenFoodService);
  private readonly destroyRef = inject(DestroyRef);

  readonly catalogoAlergenos = CATALOGO_ALERGENOS;
  readonly controlBusqueda = new FormControl('', { nonNullable: true });

  // Filas oficiales para la tabla comparativa nutricional
  readonly filasNutricionales: FilaComparacion[] = [
    { clave: 'calorias', etiqueta: 'Valor energético', unidad: 'kcal', objetivo: 'menor' },
    { clave: 'grasas', etiqueta: 'Grasas totales', unidad: 'g', objetivo: 'menor' },
    { clave: 'grasasSaturadas', etiqueta: 'Grasas saturadas', unidad: 'g', objetivo: 'menor' },
    { clave: 'hidratos', etiqueta: 'Hidratos de carbono', unidad: 'g', objetivo: 'menor' },
    { clave: 'azucares', etiqueta: 'Azúcares', unidad: 'g', objetivo: 'menor' },
    { clave: 'fibra', etiqueta: 'Fibra alimentaria', unidad: 'g', objetivo: 'mayor' },
    { clave: 'proteinas', etiqueta: 'Proteínas', unidad: 'g', objetivo: 'mayor' },
    { clave: 'sal', etiqueta: 'Sal', unidad: 'g', objetivo: 'menor' }
  ];

  // Estado reactivo de búsqueda y filtros
  readonly productos = signal<Producto[]>([]);
  readonly cargando = signal<boolean>(false);
  readonly error = signal<string | null>(null);
  readonly busquedaRealizada = signal<boolean>(false);
  readonly alergiasSeleccionadas = signal<string[]>(this.cargarAlergiasGuardadas());
  readonly soloAptos = signal<boolean>(false);

  // Paginación de resultados
  private terminoActual = '';
  private tiendasActuales = '';

  // Filtro de supermercado ('' = todos)
  readonly supermercados = CATALOGO_SUPERMERCADOS;
  readonly tiendasSeleccionadas = signal<string[]>([]);
  private readonly tiendas$ = toObservable(this.tiendasSeleccionadas);
  readonly pagina = signal<number>(1);
  readonly totalApi = signal<number>(0);
  readonly hayMas = signal<boolean>(false);
  readonly cargandoMas = signal<boolean>(false);
  readonly errorMas = signal<string | null>(null);

  // Supermercados que no respondieron en la última búsqueda múltiple (con su nombre legible)
  private readonly tiendasFallidas = signal<string[]>([]);
  readonly avisoTiendasFallidas = computed(() => {
    const nombres = this.tiendasFallidas().map(
      (tag) => CATALOGO_SUPERMERCADOS.find((s) => s.tag === tag)?.nombre ?? tag
    );
    return nombres.length > 0
      ? `No se pudieron cargar los resultados de: ${nombres.join(', ')}. Vuelve a pulsar la tienda para reintentar.`
      : null;
  });

  // Estado de Fase 4: Detalle y Comparador
  readonly productoDetalle = signal<Producto | null>(null);
  readonly comparados = signal<Producto[]>([]);
  readonly modalComparadorAbierto = signal<boolean>(false);

  // Evaluación de seguridad calculada una sola vez por producto, no en cada ciclo de detección
  private readonly seguridadPorCodigo = computed(() => {
    const alergias = this.alergiasSeleccionadas();
    const mapa = new Map<string, ReturnType<OpenFoodService['evaluarSeguridad']>>();
    for (const prod of this.productos()) {
      mapa.set(prod.codigo, this.openFoodService.evaluarSeguridad(prod, alergias));
    }
    return mapa;
  });

  readonly productosVisibles = computed(() => {
    const lista = this.productos();

    if (!this.soloAptos() || this.alergiasSeleccionadas().length === 0) {
      return lista;
    }

    const seguridad = this.seguridadPorCodigo();
    return lista.filter((prod) => seguridad.get(prod.codigo)?.estado !== 'peligro');
  });

  // Mejor valor de cada nutriente entre los productos comparados
  private readonly mejoresValores = computed(() => {
    const items = this.comparados();
    const mejores = new Map<keyof Nutrientes100g, number>();
    if (items.length < 2) return mejores;

    for (const fila of this.filasNutricionales) {
      const valores = items
        .map((p) => p.nutrientes[fila.clave])
        .filter((v): v is number => v !== null);
      if (valores.length >= 2) {
        mejores.set(
          fila.clave,
          fila.objetivo === 'menor' ? Math.min(...valores) : Math.max(...valores)
        );
      }
    }
    return mejores;
  });

  ngOnInit(): void {
    // Se relanza la búsqueda al escribir (con debounce) o al cambiar de supermercado (al instante)
    merge(this.controlBusqueda.valueChanges.pipe(debounceTime(450)), this.tiendas$)
      .pipe(
        map(() => ({
          termino: this.controlBusqueda.value.trim(),
          tiendas: this.tiendasSeleccionadas()
        })),
        distinctUntilChanged(
          (a, b) => a.termino === b.termino && a.tiendas.join() === b.tiendas.join()
        ),
        switchMap(({ termino, tiendas }) => {
          // Término corto: switchMap cancela cualquier petición en curso y se limpia el estado
          if (termino.length < 2) {
            this.busquedaRealizada.set(false);
            this.cargando.set(false);
            this.error.set(null);
            this.terminoActual = '';
            this.tiendasActuales = '';
            this.hayMas.set(false);
            this.totalApi.set(0);
            return of<ResultadoBusqueda | null>(null);
          }

          this.cargando.set(true);
          this.error.set(null);
          this.busquedaRealizada.set(true);
          this.terminoActual = termino;
          this.tiendasActuales = tiendas.join();
          this.errorMas.set(null);
          this.cargandoMas.set(false);
          this.pagina.set(1);
          this.hayMas.set(false);
          this.totalApi.set(0);

          return this.openFoodService.buscarProductos(termino, 1, TAMANO_PAGINA, tiendas).pipe(
            catchError((err) => {
              this.error.set(this.openFoodService.mensajeDeError(err));
              return of<ResultadoBusqueda | null>(null);
            })
          );
        }),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe((resultado) => {
        this.tiendasFallidas.set(resultado?.tiendasFallidas ?? []);
        this.productos.set(resultado?.productos ?? []);
        this.totalApi.set(resultado?.total ?? 0);
        this.hayMas.set(!!resultado && resultado.recibidos >= TAMANO_PAGINA);
        this.cargando.set(false);
      });
  }

  /** Descarga la siguiente página de la búsqueda actual y la añade a la lista. */
  cargarMas(): void {
    if (this.cargandoMas() || !this.hayMas()) return;

    const termino = this.terminoActual;
    const clave = this.tiendasActuales;
    const tiendas = clave ? clave.split(',') : [];
    const siguiente = this.pagina() + 1;
    this.cargandoMas.set(true);
    this.errorMas.set(null);

    this.openFoodService
      .buscarProductos(termino, siguiente, TAMANO_PAGINA, tiendas)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (resultado) => {
          // Si mientras tanto se lanzó otra búsqueda, se descarta esta página
          if (termino !== this.terminoActual || clave !== this.tiendasActuales) return;

          const existentes = new Set(this.productos().map((p) => p.codigo));
          const nuevos = resultado.productos.filter((p) => !existentes.has(p.codigo));
          this.productos.update((lista) => [...lista, ...nuevos]);
          this.pagina.set(siguiente);
          this.totalApi.set(resultado.total);
          this.hayMas.set(resultado.recibidos >= TAMANO_PAGINA);
          this.cargandoMas.set(false);
        },
        error: (err) => {
          // El error de una página extra no debe borrar los productos ya cargados
          this.errorMas.set(this.openFoodService.mensajeDeError(err));
          this.cargandoMas.set(false);
        }
      });
  }

  // --- AVISO LEGAL DE BIENVENIDA ---
  // Se muestra al entrar; una vez aceptado no vuelve a salir durante esa sesión del navegador
  readonly avisoAbierto = signal<boolean>(!this.avisoYaAceptado());
  readonly avisoSaliendo = signal<boolean>(false);
  private readonly botonAviso = viewChild<ElementRef<HTMLButtonElement>>('botonAviso');

  constructor() {
    // Mientras el aviso está abierto se bloquea el scroll de la página de fondo
    effect(() => {
      document.body.style.overflow = this.avisoAbierto() ? 'hidden' : '';
    });
    // Al aparecer, el foco va al botón (accesibilidad con teclado)
    effect(() => {
      this.botonAviso()?.nativeElement.focus({ preventScroll: true });
    });
  }

  aceptarAviso(): void {
    if (this.avisoSaliendo()) return;

    try {
      sessionStorage.setItem(STORAGE_AVISO, '1');
    } catch {
      // Sin almacenamiento: el aviso simplemente volverá a salir en la próxima visita
    }

    // Se lanza la animación de salida y se retira del DOM cuando termina
    this.avisoSaliendo.set(true);
    setTimeout(() => {
      this.avisoAbierto.set(false);
      this.avisoSaliendo.set(false);
    }, DURACION_SALIDA_AVISO);
  }

  private avisoYaAceptado(): boolean {
    try {
      return sessionStorage.getItem(STORAGE_AVISO) === '1';
    } catch {
      return false;
    }
  }

  @HostListener('document:keydown.escape')
  cerrarConEscape(): void {
    if (this.avisoAbierto()) {
      this.aceptarAviso();
      return;
    }
    if (this.modalComparadorAbierto()) this.modalComparadorAbierto.set(false);
    else if (this.productoDetalle()) this.cerrarDetalle();
  }

  // Selección múltiple: pulsar una tienda la añade o la quita del filtro
  alternarTienda(tag: string): void {
    this.tiendasSeleccionadas.update((actuales) => {
      const nuevas = actuales.includes(tag)
        ? actuales.filter((t) => t !== tag)
        : [...actuales, tag];

      // Con todos los supermercados marcados se pasa directamente a "Todos" (sin filtro)
      return nuevas.length === this.supermercados.length ? [] : nuevas;
    });
  }

  limpiarTiendas(): void {
    this.tiendasSeleccionadas.set([]);
  }

  alternarAlergia(tag: string): void {
    const actuales = this.alergiasSeleccionadas();
    const nuevas = actuales.includes(tag)
      ? actuales.filter((t) => t !== tag)
      : [...actuales, tag];

    this.alergiasSeleccionadas.set(nuevas);
    try {
      localStorage.setItem(STORAGE_ALERGIAS, JSON.stringify(nuevas));
    } catch {
      // Sin almacenamiento (modo privado, cuota...): la selección sigue en memoria
    }
  }

  limpiarAlergias(): void {
    this.alergiasSeleccionadas.set([]);
    this.soloAptos.set(false);
    try {
      localStorage.removeItem(STORAGE_ALERGIAS);
    } catch {
      // Sin almacenamiento disponible
    }
  }

  buscarSugerencia(termino: string): void {
    this.controlBusqueda.setValue(termino);
  }

  obtenerSeguridad(producto: Producto) {
    return (
      this.seguridadPorCodigo().get(producto.codigo) ??
      this.openFoodService.evaluarSeguridad(producto, this.alergiasSeleccionadas())
    );
  }

  traducirAlergeno(tag: string): string {
    return this.openFoodService.traducirTagAlergeno(tag);
  }

  // Traduce y une una lista de etiquetas ('Gluten, Soja'); devuelve el texto de respaldo si está vacía
  traducirLista(tags: string[], vacio = ''): string {
    return tags.length > 0 ? tags.map((t) => this.traducirAlergeno(t)).join(', ') : vacio;
  }

  // --- MÉTODOS DE DETALLE Y COMPARACIÓN ---

  abrirDetalle(producto: Producto): void {
    this.productoDetalle.set(producto);
  }

  cerrarDetalle(): void {
    this.productoDetalle.set(null);
  }

  estaEnComparador(codigo: string): boolean {
    return this.comparados().some((p) => p.codigo === codigo);
  }

  alternarComparacion(producto: Producto, evento?: Event): void {
    evento?.stopPropagation(); // Evita abrir el modal de detalle al pulsar "+ Comparar"

    this.comparados.update((lista) => {
      if (lista.some((p) => p.codigo === producto.codigo)) {
        return lista.filter((p) => p.codigo !== producto.codigo);
      }
      // Límite máximo de 3 productos para que la tabla sea legible
      if (lista.length >= 3) {
        return [...lista.slice(1), producto];
      }
      return [...lista, producto];
    });
  }

  vaciarComparador(): void {
    this.comparados.set([]);
    this.modalComparadorAbierto.set(false);
  }

  // Determina si el producto tiene el mejor valor de esa fila entre los comparados
  esMejorValor(producto: Producto, fila: FilaComparacion): boolean {
    const valor = producto.nutrientes[fila.clave];
    return valor !== null && valor === this.mejoresValores().get(fila.clave);
  }

  descripcionNova(nova: number | null): string {
    switch (nova) {
      case 1: return 'NOVA 1 · Alimentos sin procesar o mínimamente procesados';
      case 2: return 'NOVA 2 · Ingredientes culinarios procesados';
      case 3: return 'NOVA 3 · Alimentos procesados';
      case 4: return 'NOVA 4 · Productos ultraprocesados';
      default: return 'NOVA · Grado de procesamiento no disponible';
    }
  }

  private cargarAlergiasGuardadas(): string[] {
    try {
      const guardado = localStorage.getItem(STORAGE_ALERGIAS);
      const datos: unknown = guardado ? JSON.parse(guardado) : [];
      const validas = new Set(CATALOGO_ALERGENOS.map((a) => a.tag));
      return Array.isArray(datos) ? datos.filter((t): t is string => validas.has(t)) : [];
    } catch {
      return [];
    }
  }
}