// Disposición de la pantalla de partida, compartida por GameView y por su esqueleto de carga
// (GameLoading), para que la página no salte al cargar. Solo clases de Tailwind.
//
// - Móvil y tablet (< lg): una columna, en el orden del HTML (aviso, tablero, dado/jugadores/chat,
//   jugadas/datos), como antes.
// - lg (1024–1279 px): como antes, tablero a la izquierda y una columna de 21 rem a la derecha
//   (dado, jugadores, chat y, debajo, jugadas y datos). La página puede hacer scroll.
// - xl (≥ 1280 px; columnas laterales algo más anchas desde 2xl, 1536 px): tres columnas que ocupan el alto de la ventana sin scroll de página: jugadas y
//   datos a la izquierda, el tablero (el mayor cuadrado que cabe) en el centro, y dado, jugadores y
//   chat a la derecha. El chat y las jugadas tienen su propio scroll.

/** Rejilla. Las zonas con nombre solo existen desde `lg` (sin ellas, el orden es el del HTML). */
export const GAME_GRID =
  "grid w-full max-w-6xl gap-4 " +
  "lg:grid-cols-[minmax(0,1fr)_21rem] lg:grid-rows-[auto_auto_1fr] lg:items-start " +
  "lg:[grid-template-areas:'banner_banner'_'board_right'_'board_left'] " +
  "xl:max-w-[112rem] xl:min-h-0 xl:flex-1 xl:items-stretch " +
  "xl:grid-cols-[minmax(15rem,18rem)_minmax(0,1fr)_minmax(18rem,21rem)] xl:grid-rows-[auto_minmax(0,1fr)] " +
  // Pantallas grandes: el tablero ya lo limita el alto, así que los paneles aprovechan el ancho que sobra.
  "2xl:grid-cols-[minmax(18rem,20rem)_minmax(0,1fr)_minmax(20rem,24rem)] " +
  "xl:[grid-template-areas:'banner_banner_banner'_'left_board_right']";

export const GAME_AREA = {
  banner: "lg:[grid-area:banner]",
  /**
   * Tablero: hasta `lg`, como antes (el ancho de su columna, sin pasar del alto de la ventana). Desde
   * `xl`, la zona es un contenedor de tamaño y el tablero mide `min(ancho, alto)` (ver `GAME_BOARD`).
   */
  board: "flex min-w-0 justify-center lg:[grid-area:board] xl:min-h-0 xl:items-center xl:[container-type:size]",
  right: "flex min-w-0 flex-col gap-3 lg:[grid-area:right] xl:min-h-0",
  left: "flex min-w-0 flex-col gap-3 lg:[grid-area:left] xl:min-h-0",
} as const;

/** Marco cuadrado del tablero dentro de su zona. */
export const GAME_BOARD = "w-full max-w-[min(100%,calc(100dvh_-_10rem))] xl:w-[min(100cqw,100cqh)] xl:max-w-none";

/** Panel que, desde `xl`, ocupa el alto que sobra en su columna (su lista hace scroll). */
export const FILL_PANEL = "xl:flex xl:min-h-0 xl:flex-1 xl:flex-col";
/** Lista con scroll dentro de un `FILL_PANEL`. */
export const FILL_SCROLL = "xl:max-h-none xl:min-h-0 xl:flex-1 xl:overflow-y-auto";
