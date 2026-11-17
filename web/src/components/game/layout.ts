// Disposición de la pantalla de partida, compartida por GameView y por su esqueleto de carga
// (GameLoading), para que la página no salte al cargar. Solo clases de Tailwind.
//
// - Móvil y tablet (< lg): una columna, en el orden del HTML (aviso, tablero, dado/jugadores/jugadas,
//   chat/datos).
// - lg (1024–1279 px): tablero a la izquierda y una columna de 21 rem a la derecha (dado, jugadores,
//   jugadas y, debajo, datos y chat). La página puede hacer scroll.
// - xl (≥ 1280 px; columnas laterales algo más anchas desde 2xl, 1536 px): tres columnas que ocupan el
//   alto de la ventana sin scroll de página: datos y chat a la izquierda, el tablero (el mayor cuadrado
//   que cabe) en el centro, y dado, jugadores y jugadas a la derecha. El chat y las jugadas tienen su
//   propio scroll.
//   Ventanas bajas (desde `xl` y con menos de 800 px de alto, variante `[@media(max-height:49.99rem)]`):
//   el tablero queda limitado por el alto y «Últimas jugadas» apenas tenía sitio. Solo ahí, la columna
//   central mide como mucho el alto disponible y el ancho que sobra pasa a la columna derecha, que pone a
//   los jugadores en dos columnas y deja más alto a la lista. La columna derecha nunca es más estrecha que
//   en la disposición general (21rem; 24rem desde 2xl), así que el tablero no se reduce. Ese máximo,
//   `100dvh − 7.25rem`, es la ventana menos la cabecera, el aviso y los márgenes. Con 800 px de alto o
//   más (por ejemplo, 1920 × 1080), la disposición es la general, sin ningún cambio.

/** Rejilla. Las zonas con nombre solo existen desde `lg` (sin ellas, el orden es el del HTML). */
// `calc(100dvh − 7.25rem)`: alto de la fila del tablero desde `xl` (medido en Chrome). Tailwind solo ve clases
// literales, así que la variante de ventana baja y ese cálculo se repiten tal cual en cada clase.
export const GAME_GRID =
  "grid w-full max-w-6xl gap-4 " +
  "lg:grid-cols-[minmax(0,1fr)_21rem] lg:grid-rows-[auto_auto_1fr] lg:items-start " +
  "lg:[grid-template-areas:'banner_banner'_'board_right'_'board_left'] " +
  "xl:max-w-[112rem] xl:min-h-0 xl:flex-1 xl:items-stretch " +
  "xl:grid-cols-[minmax(15rem,18rem)_minmax(0,1fr)_minmax(18rem,21rem)] xl:grid-rows-[auto_minmax(0,1fr)] " +
  // Pantallas grandes: el tablero ya lo limita el alto, así que los paneles aprovechan el ancho que sobra.
  "2xl:grid-cols-[minmax(18rem,20rem)_minmax(0,1fr)_minmax(20rem,24rem)] " +
  // Ventanas bajas (< 800 px de alto): la columna central no pasa del alto disponible y la derecha se
  // queda con el resto (ver arriba). Cada rango de ancho tiene su clase, sin solaparse con la general.
  "xl:max-2xl:[@media(max-height:49.99rem)]:grid-cols-[minmax(15rem,18rem)_minmax(0,calc(100dvh_-_7.25rem))_minmax(21rem,1fr)] " +
  "2xl:[@media(max-height:49.99rem)]:grid-cols-[minmax(18rem,20rem)_minmax(0,calc(100dvh_-_7.25rem))_minmax(24rem,1fr)] " +
  "xl:[grid-template-areas:'banner_banner_banner'_'left_board_right']";

export const GAME_AREA = {
  banner: "lg:[grid-area:banner]",
  /**
   * Tablero: hasta `lg`, como antes (el ancho de su columna, sin pasar del alto de la ventana). Desde
   * `xl`, la zona es un contenedor de tamaño y el tablero mide `min(ancho, alto)` (ver `GAME_BOARD`).
   */
  board: "flex min-w-0 justify-center lg:[grid-area:board] xl:min-h-0 xl:items-center xl:[container-type:size]",
  /**
   * Dado, jugadores y jugadas. Solo en ventanas bajas (desde `xl`, < 800 px de alto) es un contenedor de
   * ancho (los jugadores pasan a dos columnas si cabe; ver `PlayersPanel` en modo `compact`) y, si no cabe
   * todo, hace scroll.
   */
  right:
    "flex min-w-0 flex-col gap-3 lg:[grid-area:right] xl:min-h-0 " +
    "xl:[@media(max-height:49.99rem)]:@container xl:[@media(max-height:49.99rem)]:overflow-y-auto",
  left: "flex min-w-0 flex-col gap-3 lg:[grid-area:left] xl:min-h-0",
} as const;

/** Marco cuadrado del tablero dentro de su zona. */
export const GAME_BOARD = "w-full max-w-[min(100%,calc(100dvh_-_10rem))] xl:w-[min(100cqw,100cqh)] xl:max-w-none";

/** Panel que, desde `xl`, ocupa el alto que sobra en su columna (su lista hace scroll). */
export const FILL_PANEL = "xl:flex xl:min-h-0 xl:flex-1 xl:flex-col";
/** Lista con scroll dentro de un `FILL_PANEL`. */
export const FILL_SCROLL = "xl:max-h-none xl:min-h-0 xl:flex-1 xl:overflow-y-auto";
/**
 * Lista de «Últimas jugadas»: desde xl ocupa el alto del panel y hace scroll con las anteriores; por
 * debajo de xl (móvil, tablet y lg) solo se ven las 8 más recientes, como antes de ampliar el búfer. En
 * ventanas bajas (desde xl, < 800 px de alto) nunca baja de unas 4 jugadas (6rem en lugar de 0; si no
 * caben, la columna derecha hace scroll).
 */
export const LOG_LIST = `${FILL_SCROLL} xl:[@media(max-height:49.99rem)]:min-h-24 max-xl:[&>li:nth-child(n+9)]:hidden`;
