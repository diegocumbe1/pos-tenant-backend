/**
 * Cómo habla la gente de su negocio, en español de mostrador colombiano.
 *
 * Es un archivo de DATOS, no de lógica: crece con lo que aparezca en uso real.
 * La clave es el CONCEPTO con el que se escriben las reglas de los intents; el
 * array son las formas en que ese concepto aparece escrito o dicho.
 *
 * Todo va normalizado —minúsculas, sin tildes— porque el texto llega
 * normalizado. Escribir las reglas contra conceptos y no contra las veinte
 * maneras de nombrarlos es lo que evita que añadir un sinónimo obligue a tocar
 * cinco intents.
 *
 * Gemelo de `verticals/retail/assistant/retail.lexicon.ts` en el frontend. Los
 * dos crecen juntos: si aquí entra una forma nueva, allá también, o el mismo
 * copiloto contesta distinto según por dónde le pregunten.
 */
export const LEXICON: Record<string, string[]> = {
  // ─── Dinero que entra ──────────────────────────────────────────────────────
  venta: [
    'venta',
    'ventas',
    'vendi',
    'vendido',
    'vendimos',
    'vender',
    'vendio',
    'se vendio',
    // Presente: "qué es lo que más VENDO", "qué se VENDE más". Sin estas formas
    // los rankings se quedaban sin anchor y la pregunta caía en el menú.
    'vendo',
    'vende',
    'venden',
    'vendes',
    'facture',
    'facturacion',
    'facturado',
    'facturamos',
    'ingreso',
    'ingresos',
    'entro',
    'recaude',
    'recaudo',
    'caja',
    'cuanto hice',
    'cuanto llevo',
    // "plata" NO está aquí a propósito: es evidencia de DINERO, no de venta.
    // "cuánta plata entró" ya lo cubre `entro`, mientras que "en qué se me va la
    // plata" es justo la pregunta contraria. Tenerlo como sinónimo de venta
    // hacía que los gastos perdieran contra un ranking de productos.
  ],

  // ─── Dinero que sale ───────────────────────────────────────────────────────
  // Nada que ver con `fiado` (lo que NO ha entrado) ni con `compra` (lo que se
  // le pidió al proveedor): esto es lo que ya salió de la caja.
  gasto: [
    'gasto',
    'gastos',
    'gaste',
    'gastado',
    'gastamos',
    'egreso',
    'egresos',
    'salida',
    'salidas',
    'pague',
    'pagos',
    'pagado',
    'costos',
    'arriendo',
    'servicios',
    'nomina',
    'sueldos',
    'en que se me va',
    'en que se va la plata',
  ],

  // ─── Mercancía ─────────────────────────────────────────────────────────────
  inventario: [
    'inventario',
    'stock',
    'existencia',
    'existencias',
    'bodega',
    'mercancia',
    'mercancias',
    'lo que hay',
    'lo que queda',
    'almacen',
  ],
  producto: [
    'producto',
    'productos',
    'articulo',
    'articulos',
    'item',
    'items',
    'referencia',
    'referencias',
    'unidad',
    'unidades',
  ],

  // POR AGOTARSE: todavía queda algo y hay margen para pedir. Distinto de
  // `sin stock`, que ya es un hecho consumado.
  agotado: [
    'agotando',
    'acabando',
    'acaba',
    'se acaba',
    'por acabarse',
    'queda poco',
    'quedan pocos',
    'poco stock',
    'stock bajo',
    'bajo stock',
    'minimo',
    'reponer',
    'repongo',
    'faltando',
    'escaso',
  ],

  /**
   * YA SE ACABÓ: stock en cero. Dos preguntas con dos acciones distintas —"qué
   * está agotado" ya te costó ventas; "qué se está agotando" todavía se puede
   * evitar—, así que van a intents separados.
   */
  'sin stock': [
    'agotado',
    'agotados',
    'agotadas',
    'agotada',
    'se agoto',
    'sin stock',
    'sin existencias',
    'sin unidades',
    'en cero',
    'se acabo',
    'se me acabo',
    'se acabaron',
    'se me acabaron',
    'no queda',
    'no me queda',
  ],

  // ─── Plata que NO ha entrado ───────────────────────────────────────────────
  fiado: [
    'fiado',
    'fiados',
    'fie',
    'credito',
    'deben',
    'debe',
    'debo cobrar',
    'deuda',
    'deudas',
    'me deben',
    'por cobrar',
    'sin cobrar',
    'saldo',
    'saldos',
    'pendiente de pago',
    'cartera',
    'quedaron debiendo',
  ],

  // ─── Mercancía prometida y no entregada (SALE hacia el cliente) ────────────
  entrega: [
    'entrega',
    'entregas',
    'entregar',
    'por entregar',
    'sin entregar',
    'encargo',
    'encargos',
    'pendiente de entrega',
    'despachar',
    'despacho',
    'separado',
    'separados',
    'apartado',
  ],

  /**
   * Mercancía pedida al PROVEEDOR y todavía no recibida: entra hacia nosotros.
   *
   * Es lo contrario de `entrega` y confundirlos es el error más caro del
   * asistente: "¿qué pedidos tengo pendientes por recibir?" contestado con lo
   * que falta despachar manda al dueño a la pantalla equivocada.
   */
  compra: [
    'compra',
    'compras',
    'por recibir',
    'sin recibir',
    'pendiente de recibir',
    'falta recibir',
    'falta que llegue',
    'que me falta llegar',
    'proveedor',
    'proveedores',
    'orden de compra',
    'ordenes de compra',
    'lo que pedi',
    'que pedi',
    'encargue',
    'reposicion',
  ],

  // ─── Clientes ──────────────────────────────────────────────────────────────
  cliente: [
    'cliente',
    'clientes',
    'clienta',
    'clientas',
    'compradores',
    'comprador',
    'me compra',
    'me compro',
    'compraron',
    'quien compra',
  ],

  // ─── El negocio como un todo ───────────────────────────────────────────────
  negocio: ['negocio', 'tienda', 'local', 'mi negocio', 'empresa'],
  reporte: [
    'reporte',
    'reportes',
    'informe',
    'resumen',
    'resumeme',
    'panorama',
    'como va',
    'como vamos',
    'como esta',
    'como estamos',
    'como me fue',
    'como nos fue',
    'ponme al dia',
  ],

  // ─── Conceptos de pregunta: modificadores, nunca anchors ───────────────────
  cuanto: ['cuanto', 'cuanta', 'cuantos', 'cuantas', 'que tanto'],
  cual: ['cual', 'cuales'],
  quien: ['quien', 'quienes'],
  top: [
    'mas',
    'mejor',
    'mejores',
    'top',
    'mayor',
    'mayores',
    'principales',
    'estrella',
    'popular',
    'populares',
  ],
  peor: [
    'menos',
    'peor',
    'peores',
    'menor',
    'mas bajo',
    'quieto',
    'quietos',
    'estancado',
    'estancados',
    'parado',
    'parados',
    'no se mueve',
    'no se vende',
    'no se ha vendido',
  ],
  solo: ['solo', 'solamente', 'unicamente', 'nada mas que', 'solo de'],
  general: ['general', 'completo', 'todo', 'entero', 'de todo'],
};

/**
 * Palabras que piden un total SIN decir de cuándo.
 *
 * No son una ventana temporal: son la señal de que hay que preguntar cuál.
 * Responder "hoy" a "¿cuánto llevo en ventas totales?" es dar una cifra
 * correcta a una pregunta que nadie hizo.
 */
export const TOTALIZING_TERMS = [
  'total',
  'totales',
  'en total',
  'acumulado',
  'acumuladas',
  'historico',
  'historicos',
  'desde siempre',
  'todo el tiempo',
  'hasta ahora',
];
