// ============================================================================
// 1. CONTRATO DE ENTRADA (Lo que llega crudo desde la API de Open Food Facts)
// ============================================================================


// Envoltorio

export interface OpenFoodSearchResponse {
  count: number;
  page: number;
  page_size: number;
  products: OpenFoodProductRaw[];
}

// Datos de producto

export interface OpenFoodProductRaw {
  code: string;
  product_name?: string;
  product_name_es?: string;
  brands?: string;
  image_front_small_url?: string;
  image_front_url?: string;
  nutriscore_grade?: string;
  countries_tags?: string[]; // Países donde se comercializa ('en:spain', 'en:france'...)
  nova_group?: number;
  allergens_tags?: string[];
  traces_tags?: string[];
  ingredients_text_es?: string;
  ingredients_text?: string;
  nutriments?: {
    'energy-kcal_100g'?: number;
    fat_100g?: number;
    'saturated-fat_100g'?: number;
    carbohydrates_100g?: number;
    sugars_100g?: number;
    fiber_100g?: number;
    proteins_100g?: number;
    salt_100g?: number;
  };
}

// ============================================================================
// 2. CONTRATO INTERNO (El modelo limpio y seguro que usa nuestra aplicación)
// ============================================================================


// Plantilla valores nutricionales

export interface Nutrientes100g {
  calorias: number | null;
  grasas: number | null;
  grasasSaturadas: number | null;
  hidratos: number | null;
  azucares: number | null;
  fibra: number | null;
  proteinas: number | null;
  sal: number | null;
}

// Plantilla producto

export interface Producto {
  codigo: string;
  nombre: string;
  marca: string;
  imagen: string;
  nutriscore: 'a' | 'b' | 'c' | 'd' | 'e' | 'desconocido';
  nova: number | null;
  alergenos: string[];
  trazas: string[];
  ingredientes: string;
  nutrientes: Nutrientes100g;
}

// ============================================================================
// 3. DICCIONARIO DE ALÉRGENOS (Reglamento Europeo UE 1169/2011)
// ============================================================================

// Cada uno de los alérgenos

export interface AlergenoInfo {
  tag: string;            // Etiqueta técnica que devuelve la API ('en:gluten')
  nombre: string;         // Nombre legible para alertas ('Gluten')
  etiquetaFiltro: string; // Texto para el botón de filtro ('Sin Gluten')
}

// Traduccion

export const CATALOGO_ALERGENOS: AlergenoInfo[] = [
  { tag: 'en:gluten', nombre: 'Gluten', etiquetaFiltro: 'Sin Gluten' },
  { tag: 'en:milk', nombre: 'Lácteos / Lactosa', etiquetaFiltro: 'Sin Lactosa' },
  { tag: 'en:eggs', nombre: 'Huevo', etiquetaFiltro: 'Sin Huevo' },
  { tag: 'en:nuts', nombre: 'Frutos de cáscara', etiquetaFiltro: 'Sin Frutos Secos' },
  { tag: 'en:peanuts', nombre: 'Cacahuetes', etiquetaFiltro: 'Sin Cacahuetes' },
  { tag: 'en:soybeans', nombre: 'Soja', etiquetaFiltro: 'Sin Soja' },
  { tag: 'en:fish', nombre: 'Pescado', etiquetaFiltro: 'Sin Pescado' },
  { tag: 'en:crustaceans', nombre: 'Crustáceos', etiquetaFiltro: 'Sin Crustáceos' },
  { tag: 'en:molluscs', nombre: 'Moluscos', etiquetaFiltro: 'Sin Moluscos' },
  { tag: 'en:lupin', nombre: 'Altramuces', etiquetaFiltro: 'Sin Altramuces' },
  { tag: 'en:mustard', nombre: 'Mostaza', etiquetaFiltro: 'Sin Mostaza' },
  { tag: 'en:sesame-seeds', nombre: 'Sésamo', etiquetaFiltro: 'Sin Sésamo' },
  { tag: 'en:celery', nombre: 'Apio', etiquetaFiltro: 'Sin Apio' },
  { tag: 'en:sulphur-dioxide-and-sulphites', nombre: 'Sulfitos', etiquetaFiltro: 'Sin Sulfitos' }
];

// Los 3 posibles resultados del semáforo de seguridad

export type EstadoAlergia = 'apto' | 'trazas' | 'peligro';
// ============================================================================
// 4. SUPERMERCADOS (etiquetas del campo 'stores' de Open Food Facts)
// ============================================================================

export interface Supermercado {
  tag: string;    // Etiqueta usada en la API ('mercadona')
  nombre: string; // Nombre para mostrar
  logo: string;   // Ruta del logo (carpeta public/logos)
}

export const CATALOGO_SUPERMERCADOS: Supermercado[] = [
  { tag: 'mercadona', nombre: 'Mercadona', logo: 'logos/mercadona.png' },
  { tag: 'carrefour', nombre: 'Carrefour', logo: 'logos/carrefour.png' },
  { tag: 'lidl', nombre: 'Lidl', logo: 'logos/lidl.png' },
  { tag: 'dia', nombre: 'Dia', logo: 'logos/dia.png' },
  { tag: 'alcampo', nombre: 'Alcampo', logo: 'logos/alcampo.png' },
  { tag: 'eroski', nombre: 'Eroski', logo: 'logos/eroski.png' },
  { tag: 'el-corte-ingles', nombre: 'El Corte Inglés', logo: 'logos/el-corte-ingles.png' },
  { tag: 'aldi', nombre: 'Aldi', logo: 'logos/aldi.png' }
];
