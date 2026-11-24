import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import {
  Observable,
  TimeoutError,
  catchError,
  forkJoin,
  map,
  merge,
  of,
  retry,
  shareReplay,
  switchMap,
  tap,
  throwError,
  timeout,
  timer
} from 'rxjs';

// Importaciones desde el modelo creado

import {
  CATALOGO_ALERGENOS,
  EstadoAlergia,
  OpenFoodProductRaw,
  OpenFoodSearchResponse,
  Producto
} from '../models/producto.model';

export interface ResultadoBusqueda {
  productos: Producto[];
  /** Total de coincidencias que reporta la API para la búsqueda (todas las páginas) */
  total: number;
  /** Productos que devolvió la API en esta página, antes de descartar los que no tienen nombre */
  recibidos: number;
  /** Etiquetas de tiendas que no respondieron (solo en búsquedas con varios supermercados) */
  tiendasFallidas?: string[];
  /** true en el resultado provisional: aún se están buscando coincidencias parciales */
  ampliando?: boolean;
}

// Máximo de palabras "ampliadas" (p. ej. gall → galletas) que se buscan además del texto escrito
const MAX_AMPLIACIONES = 2;

/**
 * @Injectable({ providedIn: 'root' })
 * Convierte esta clase en un servicio global (Singleton): Angular crea una única
 * instancia compartida para toda la aplicación, sin tener que registrarla en ningún módulo.
 */
@Injectable({
  providedIn: 'root'
})
export class OpenFoodService {
  // Inyección moderna de Angular: pedimos el cliente HTTP sin usar el constructor clásico
  private readonly http = inject(HttpClient);

  // Endpoints oficiales de Open Food Facts (búsqueda general y producto individual)
  private readonly apiUrl = 'https://world.openfoodfacts.org/cgi/search.pl';

  // Servicio de sugerencias de Open Food Facts: busca por prefijo en el catálogo de categorías
  private readonly sugerenciasUrl = 'https://world.openfoodfacts.org/cgi/suggest.pl';

  // Cachés en memoria: búsquedas ya realizadas y palabras ampliadas por prefijo
  private readonly cacheBusquedas = new Map<string, ResultadoBusqueda>();
  private readonly cacheAmpliaciones = new Map<string, string[]>();
  private readonly productoUrl = 'https://world.openfoodfacts.org/api/v2/product';

  // Lista exacta de claves que queremos descargar. Unirlas con .join(',') crea la cadena
  // "code,product_name,product_name_es..." para que la respuesta pese un 90 % menos.
  private readonly camposRequeridos = [
    'code',
    'product_name',
    'product_name_es',
    'brands',
    'image_front_small_url',
    'image_front_url',
    'nutriscore_grade',
    'countries_tags',
    'nova_group',
    'allergens_tags',
    'traces_tags',
    'ingredients_text_es',
    'ingredients_text',
    'nutriments'
  ].join(',');

  // Imagen SVG incrustada directamente en memoria (Data URI).
  // Si un producto no tiene foto en la base de datos, usamos este gráfico gris en lugar
  // de depender de un archivo externo que pueda dar error 404.
  private readonly imagenFallback =
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 300 300">
        <rect width="300" height="300" fill="#f1f5f9"/>
        <text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="#94a3b8" font-family="sans-serif" font-size="16">Sin imagen disponible</text>
      </svg>`
    );

  /**
   * Busca productos en España por texto. Devuelve una página de resultados ya limpios
   * junto con el total de coincidencias que reporta la API (para poder paginar).
   */
  buscarProductos(
    termino: string,
    pagina = 1,
    tamanoPagina = 24,
    tiendas: string[] = []
  ): Observable<ResultadoBusqueda> {
    // Varios supermercados: la API solo sabe combinar etiquetas con "Y" (producto en TODAS las
    // tiendas), así que se consulta cada tienda por separado y se fusionan los resultados.
    if (tiendas.length > 1) {
      return this.buscarEnVariasTiendas(termino, pagina, tamanoPagina, tiendas);
    }
    const tienda = tiendas[0] ?? '';
    const terminoLimpio = termino.trim();

    // Caché en memoria: las búsquedas repetidas se resuelven al instante
    const claveCache = `${terminoLimpio.toLowerCase()}|${tienda}|${pagina}|${tamanoPagina}`;
    const enCache = this.cacheBusquedas.get(claveCache);
    if (enCache) return of(enCache);

    // HttpParams construye los parámetros de la URL de forma segura
    let params = new HttpParams()
      .set('search_terms', terminoLimpio)
      .set('countries_tags_en', 'spain')
      // json=1 devuelve en formato json
      .set('json', '1')
      .set('page', pagina.toString())
      .set('page_size', tamanoPagina.toString())
      .set('fields', this.camposRequeridos);

    // Filtro por supermercado: el producto debe tener esa tienda en su campo 'stores'
    if (tienda) {
      params = params
        .set('tagtype_0', 'stores')
        .set('tag_contains_0', 'contains')
        .set('tag_0', tienda);
    }

    return this.http.get<OpenFoodSearchResponse>(this.apiUrl, { params }).pipe(
      // Si tarda más de 15 s, corta la espera en lugar de quedarse colgado
      timeout(15000),
      // Reintenta hasta 4 veces con espera creciente (1 s, 2 s, 3 s, 4 s) solo ante fallos
      // temporales: el servidor gratuito responde 503 de forma intermitente. Un 4xx (salvo 429)
      // no se reintenta porque volvería a fallar igual.
      retry({
        count: 4,
        delay: (error, intento) =>
          this.esErrorTemporal(error) ? timer(1000 * intento) : throwError(() => error)
      }),
      map((respuesta): ResultadoBusqueda => ({
        // Total real de coincidencias (la API puede enviarlo como número o como texto)
        total: Number(respuesta.count) || 0,
        // Nº de productos que devolvió la API en esta página, antes de descartar los sin nombre
        recibidos: (respuesta.products || []).length,
        productos: (respuesta.products || [])
          // 1. Filtramos productos incompletos (sin nombre) y los que no se comercializan en
          //    España. La API ya filtra por país; esto es una segunda garantía por si algún
          //    producto llegara sin esa etiqueta.
          .filter((item) => Boolean(item.product_name_es?.trim() || item.product_name?.trim()))
          .filter((item) => !item.countries_tags || item.countries_tags.includes('en:spain'))
          // 2. Transformamos cada producto crudo al formato limpio 'Producto' de nuestra app
          .map((item) => this.normalizarProducto(item))
      })),
      tap((resultado) => {
        // Caché acotada: al superar 50 entradas se descarta la más antigua
        if (this.cacheBusquedas.size >= 50) {
          this.cacheBusquedas.delete(this.cacheBusquedas.keys().next().value!);
        }
        this.cacheBusquedas.set(claveCache, resultado);
      })
    );
  }

  /**
   * Búsqueda con coincidencias parciales. La API solo entiende palabras completas ("gall" no
   * encuentra "galletas"), así que se hace en dos pasos para no perder velocidad:
   *  1. Emite enseguida los resultados exactos (marcados con ampliando = true).
   *  2. En paralelo consulta el servicio de sugerencias por prefijo ("gall" → "galletas"),
   *     busca esas palabras y emite la lista final con las coincidencias añadidas al final.
   * La lista final conserva el orden del primer paso, así que no "salta" al ampliarse.
   */
  buscarConAmpliacion(
    termino: string,
    pagina = 1,
    tamanoPagina = 24,
    tiendas: string[] = []
  ): Observable<ResultadoBusqueda> {
    const tamanoAmpliacion = Math.max(6, Math.ceil(tamanoPagina / 2));

    // shareReplay: la petición exacta se hace una sola vez aunque la usen dos ramas
    const base$ = this.buscarProductos(termino, pagina, tamanoPagina, tiendas).pipe(shareReplay(1));
    if (!this.admiteAmpliacion(termino)) return base$;

    // La petición de sugerencias se lanza A LA VEZ que la exacta (no después), para que
    // sus tiempos de espera no se sumen.
    const palabras$ = this.obtenerAmpliaciones(termino);

    const completo$ = forkJoin([base$, palabras$]).pipe(
      switchMap(([base, palabras]) => {
        if (palabras.length === 0) return of(base);

        return forkJoin(
          palabras.map((palabra) =>
            this.buscarProductos(palabra, pagina, tamanoAmpliacion, tiendas).pipe(
              // Una ampliación que falla no estropea el resultado exacto
              catchError(() => of(null))
            )
          )
        ).pipe(map((extras) => this.fusionar(base, extras, tamanoAmpliacion, tamanoPagina)));
      })
    );

    // Primero el resultado exacto (provisional) y, cuando está todo, el completo
    return merge(base$.pipe(map((base) => ({ ...base, ampliando: true }))), completo$);
  }

  // Solo se amplían palabras sueltas de 3 o más letras (con 1-2 letras habría demasiado ruido)
  private admiteAmpliacion(termino: string): boolean {
    const limpio = termino.trim();
    return limpio.length >= 3 && !/\s/.test(limpio);
  }

  /** Quita tildes y pasa a minúsculas para comparar ("Jamón" → "jamon"). */
  private normalizar(texto: string): string {
    return texto.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  }

  /**
   * Palabras que empiezan por lo escrito, sacadas del catálogo de categorías de Open Food Facts
   * ("gall" → ["galletas"]). Si el servicio falla o tarda, simplemente no hay ampliación.
   */
  private obtenerAmpliaciones(termino: string): Observable<string[]> {
    const prefijo = this.normalizar(termino.trim());
    const enCache = this.cacheAmpliaciones.get(prefijo);
    if (enCache) return of(enCache);

    const params = new HttpParams()
      .set('tagtype', 'categories')
      .set('string', termino.trim())
      .set('lc', 'es')
      .set('limit', '12');

    return this.http.get<string[]>(this.sugerenciasUrl, { params }).pipe(
      // Este servicio tarda entre 2 y 5 s; mientras tanto el usuario ya ve los resultados exactos
      timeout(12000),
      map((sugerencias) => this.extraerPalabras(sugerencias, prefijo)),
      // Solo se cachea el éxito: un fallo puntual no debe "recordarse"
      tap((palabras) => this.cacheAmpliaciones.set(prefijo, palabras)),
      catchError(() => of([] as string[]))
    );
  }

  // De las sugerencias ("Galletas con nueces", "Galletas crujientes"...) se queda con las
  // palabras que empiezan por el prefijo y son más largas que él, las más repetidas primero.
  private extraerPalabras(sugerencias: unknown, prefijo: string): string[] {
    if (!Array.isArray(sugerencias)) return [];

    const cuenta = new Map<string, number>();
    for (const sugerencia of sugerencias) {
      if (typeof sugerencia !== 'string') continue;
      for (const palabra of sugerencia.split(/[^\p{L}\p{N}]+/u)) {
        const clave = palabra.toLowerCase();
        if (clave.length > prefijo.length && this.normalizar(clave).startsWith(prefijo)) {
          cuenta.set(clave, (cuenta.get(clave) ?? 0) + 1);
        }
      }
    }

    return [...cuenta.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)
      .slice(0, MAX_AMPLIACIONES)
      .map(([palabra]) => palabra);
  }

  // Añade al final de la lista exacta los productos de las ampliaciones, sin repetidos
  private fusionar(
    base: ResultadoBusqueda,
    extras: (ResultadoBusqueda | null)[],
    tamanoAmpliacion: number,
    tamanoPagina: number
  ): ResultadoBusqueda {
    const vistos = new Set(base.productos.map((p) => p.codigo));
    const productos = [...base.productos];
    let total = base.total;
    let hayMas = base.recibidos;

    for (const extra of extras) {
      if (!extra) continue;
      total += extra.total; // aproximado: un producto puede contarse en dos palabras
      // Si alguna ampliación devolvió su página completa, aún hay más páginas que pedir
      if (extra.recibidos >= tamanoAmpliacion) hayMas = Math.max(hayMas, tamanoPagina);
      for (const prod of extra.productos) {
        if (!vistos.has(prod.codigo)) {
          vistos.add(prod.codigo);
          productos.push(prod);
        }
      }
    }

    return { ...base, productos, total, recibidos: hayMas, ampliando: false };
  }

  /**
   * Busca en varios supermercados a la vez (unión): una petición por tienda en paralelo,
   * resultados intercalados para que ninguna tienda domine y sin productos repetidos.
   */
  private buscarEnVariasTiendas(
    termino: string,
    pagina: number,
    tamanoPagina: number,
    tiendas: string[]
  ): Observable<ResultadoBusqueda> {
    // Cada tienda aporta su parte de la página, para mantener el tamaño total similar
    const porTienda = Math.max(6, Math.ceil(tamanoPagina / tiendas.length));

    return forkJoin(
      tiendas.map((tienda) =>
        this.buscarProductos(termino, pagina, porTienda, [tienda]).pipe(
          // Una tienda que falla no tumba el resto: se muestran las demás
          catchError((error) => of({ error } as { error: unknown }))
        )
      )
    ).pipe(
      map((respuestas) => {
        const correctas = respuestas.filter((r): r is ResultadoBusqueda => 'productos' in r);
        if (correctas.length === 0) {
          throw (respuestas[0] as { error: unknown }).error;
        }

        // Intercalado (round-robin): 1º de cada tienda, 2º de cada tienda...
        const vistos = new Set<string>();
        const productos: Producto[] = [];
        const maxLen = Math.max(...correctas.map((r) => r.productos.length));
        for (let i = 0; i < maxLen; i++) {
          for (const r of correctas) {
            const prod = r.productos[i];
            if (prod && !vistos.has(prod.codigo)) {
              vistos.add(prod.codigo);
              productos.push(prod);
            }
          }
        }

        return {
          productos,
          // Suma aproximada: un producto vendido en varias tiendas cuenta una vez por tienda
          total: correctas.reduce((suma, r) => suma + r.total, 0),
          // Hay más páginas si alguna tienda devolvió su página completa
          recibidos: correctas.some((r) => r.recibidos >= porTienda) ? tamanoPagina : 0,
          tiendasFallidas: tiendas.filter((_, i) => !('productos' in respuestas[i]))
        };
      })
    );
  }

  /**
   * Devuelve un mensaje de error comprensible según la causa del fallo.
   */
  mensajeDeError(error: unknown): string {
    if (error instanceof TimeoutError) {
      return 'Open Food Facts tarda demasiado en responder. Inténtalo de nuevo en unos segundos.';
    }
    if (error instanceof HttpErrorResponse) {
      if (error.status === 429) {
        return 'Demasiadas búsquedas seguidas. Espera un momento antes de volver a intentarlo.';
      }
      if (error.status === 502 || error.status === 503 || error.status === 504) {
        return 'Los servidores de Open Food Facts están saturados. Inténtalo de nuevo en un minuto.';
      }
      if (error.status === 0) {
        return typeof navigator !== 'undefined' && !navigator.onLine
          ? 'Sin conexión a internet. Revisa tu red.'
          : 'No se pudo conectar con Open Food Facts (el servidor puede estar caído o saturado).';
      }
    }
    return 'No se pudo conectar con Open Food Facts. Inténtalo de nuevo.';
  }

  private esErrorTemporal(error: unknown): boolean {
    if (error instanceof TimeoutError) return true;
    if (error instanceof HttpErrorResponse) {
      return error.status === 0 || error.status === 429 || error.status >= 500;
    }
    return false;
  }

  /**
   * Obtiene el detalle de un único producto usando su código de barras (EAN).
   * Útil para la vista de detalle o si en el futuro añades un lector de códigos.
   */
  obtenerProductoPorCodigo(codigo: string): Observable<Producto | null> {
    const params = new HttpParams().set('fields', this.camposRequeridos);

    return this.http
      .get<{ status: number; product?: OpenFoodProductRaw }>(`${this.productoUrl}/${codigo}.json`, { params })
      .pipe(
        // La API v2 devuelve status === 1 cuando el código existe; si no existe, devolvemos null
        map((res) => (res.status === 1 && res.product ? this.normalizarProducto(res.product) : null))
      );
  }

  /**
   * Motor de detección de alergias: cruza las etiquetas del producto contra
   * las restricciones seleccionadas por el usuario y devuelve el nivel de riesgo.
   */
  evaluarSeguridad(producto: Producto, alergiasUsuario: string[]): {
    estado: EstadoAlergia;
    detectados: string[];
    trazasDetectadas: string[];
  } {
    // Si el usuario no ha marcado ninguna alergia, todo es apto por defecto
    if (alergiasUsuario.length === 0) {
      return { estado: 'apto', detectados: [], trazasDetectadas: [] };
    }

    // Comprobamos coincidencias directas en ingredientes confirmados
    const detectados = alergiasUsuario.filter((tag) => producto.alergenos.includes(tag));
    // Comprobamos coincidencias en posibles trazas de fábrica
    const trazasDetectadas = alergiasUsuario.filter((tag) => producto.trazas.includes(tag));

    // Prioridad 1: Si contiene un alérgeno directo -> Peligro (Rojo)
    if (detectados.length > 0) {
      return { estado: 'peligro', detectados, trazasDetectadas };
    }

    // Prioridad 2: Si no lo contiene directamente pero hay trazas -> Precaución (Ámbar)
    if (trazasDetectadas.length > 0) {
      return { estado: 'trazas', detectados: [], trazasDetectadas };
    }

    // Prioridad 3: Limpio de alérgenos y trazas -> Apto (Verde)
    return { estado: 'apto', detectados: [], trazasDetectadas: [] };
  }

  /**
   * Traduce una etiqueta técnica ('en:milk') a español legible ('Lácteos / Lactosa').
   */
  traducirTagAlergeno(tag: string): string {
    const encontrado = CATALOGO_ALERGENOS.find((a) => a.tag === tag);
    if (encontrado) return encontrado.nombre;

    // Respaldo por si aparece un alérgeno fuera del catálogo: le quita 'en:' y los guiones
    return tag.replace(/^en:/, '').replace(/-/g, ' ');
  }

  /**
   * Método privado (solo lo usa este servicio) que limpia, ordena y estandariza
   * un producto crudo de la API para convertirlo en nuestro objeto 'Producto'.
   */
  private normalizarProducto(raw: OpenFoodProductRaw): Producto {
    // Normalizamos el Nutri-Score a minúsculas y verificamos que sea una letra válida (a-e)
    const grado = raw.nutriscore_grade?.toLowerCase();
    const nutriscoreValido =
      grado === 'a' || grado === 'b' || grado === 'c' || grado === 'd' || grado === 'e'
        ? grado
        : 'desconocido';

    // Si 'nutriments' viene undefined, usamos un objeto vacío para evitar errores al leer sus claves
    const n = raw.nutriments || {};

    // Priorizamos el nombre en español; si no existe, usamos el nombre general
    const nombreLimpio =
      raw.product_name_es?.trim() || raw.product_name?.trim() || 'Producto sin nombre';

    return {
      codigo: raw.code,
      nombre: nombreLimpio,
      // Si hay varias marcas ("Hacendado, Mercadona"), nos quedamos solo con la primera
      marca: raw.brands?.split(',')[0]?.trim() || 'Marca no especificada',
      // Elegimos la imagen pequeña para rapidez; si no hay, la grande; si no, el SVG por defecto
      imagen: raw.image_front_small_url || raw.image_front_url || this.imagenFallback,
      nutriscore: nutriscoreValido,
      // Usamos '??' (Nullish Coalescing) para que si un valor es 0, se respete el 0
      // y solo se convierta en null cuando realmente sea undefined
      nova: raw.nova_group ?? null,
      alergenos: raw.allergens_tags || [],
      trazas: raw.traces_tags || [],
      ingredientes:
        raw.ingredients_text_es?.trim() ||
        raw.ingredients_text?.trim() ||
        'Lista de ingredientes no disponible.',
      nutrientes: {
        calorias: this.redondear(n['energy-kcal_100g']),
        grasas: this.redondear(n.fat_100g),
        grasasSaturadas: this.redondear(n['saturated-fat_100g']),
        hidratos: this.redondear(n.carbohydrates_100g),
        azucares: this.redondear(n.sugars_100g),
        fibra: this.redondear(n.fiber_100g),
        proteinas: this.redondear(n.proteins_100g),
        sal: this.redondear(n.salt_100g)
      }
    };
  }

  // Redondea a 1 decimal (la API devuelve cosas como 533.333333333333); null si no hay dato numérico
  private redondear(valor: unknown): number | null {
    const num = typeof valor === 'string' ? parseFloat(valor) : valor;
    return typeof num === 'number' && Number.isFinite(num) ? Math.round(num * 10) / 10 : null;
  }
}