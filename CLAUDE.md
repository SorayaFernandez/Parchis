# Parchís IA

Nueva versión del Parchís online: cuatro personajes controlados por IA juegan entre ellos y el usuario es **espectador** (ve el tablero y el chat).

## Estructura

- `web/`: **nueva aplicación**. Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS v4, shadcn/ui (estilo `base-nova`, sobre Base UI) y Vitest. Requiere Node ≥ 22.
  - `src/lib/engine/`: motor del Parchís en TypeScript puro (ver abajo).
  - `src/lib/board/` y `src/components/board/`: tablero visual (ver abajo).
  - `src/lib/hud/` y `src/components/hud/`: HUD de jugadores y panel de dados (ver abajo).
  - `src/lib/chat/`, `src/components/hud/ChatPanel.tsx` y `web/supabase/8.2a-chat.sql`: chat entre personajes (ver "Chat entre personajes").
- `frontend/`, `backend/`, `nginx/`, `vault/`, `docker-compose.yml`, `Makefile`: **proyecto original** (ft_transcendence). Solo de referencia. **No modificar ni eliminar.**

## Motor (`web/src/lib/engine/`)

- Sin dependencias de Next.js, React, BD ni servicios externos. Sin temporizadores, I/O ni azar.
- API (`index.ts`):
  - `createGame(playerIds)`: entre 2 y 4 jugadores; colores en el orden pink, purple, green, blue; la partida empieza ya en juego.
  - `applyAction(state, action)`: devuelve `{ ok, state, events }` o `{ ok: false, error }`, sin modificar `state`.
  - `getAvailableMoves(state)`: movimientos legales del jugador en turno.
- Acciones:
  - `roll`: el valor del dado lo genera quien llama (el servidor).
  - `move`: usa el dado o el bonus pendiente.
  - `timeout`: pasa el turno cuando el servidor decide que ha vencido el plazo.
- Archivos: `types.ts`, `constants.ts`, `board.ts` (posiciones y barreras), `moves.ts` (validación, movimientos legales, captura), `turns.ts`, `engine.ts`, `__tests__/` (reglas y simulación de partidas completas).
- `steps` es relativo a cada color: −1 en casa, 0–63 en el recorrido y 75 en la meta. Las casillas globales van de 0 a 67.
- **Tramo final: 8 casillas + meta.** La 1ª es la entrada (17, 34, 51 o 68/0), que es también casilla del recorrido común (`steps 63`). Después vienen las 7 casillas de color (`steps 68–74`) y luego la meta (`75`), que es una posición aparte. Desde la entrada hay 8 casillas de avance hasta la meta, y hace falta la tirada exacta (`FINAL_SECTION_SIZE`, `HOME_ENTRY_STEPS` en `constants.ts`).

### Reglas implementadas

- **Ocupación:** como máximo 2 fichas en cualquier casilla del recorrido (segura o normal).
- **Barreras** (`getBlockades` en `board.ts`; el pasillo final, la casa y la meta no cuentan):
  - En una casilla normal, 2 fichas del mismo color. Dos fichas de distinto color en una casilla normal no son barrera.
  - En una casilla segura, 2 fichas de cualquier color (iguales o distintos). La de dos colores tiene `color: null`.
  - Ninguna ficha, de ningún color (tampoco las de quienes la forman), puede atravesar una barrera ni caer en ella (`BLOCKADE_IN_PATH`). Una barrera en la entrada del pasillo impide entrar en él.
  - Una ficha que forma parte de una barrera puede salir de su casilla y la rompe.
  - En el original solo había barreras del mismo color y cabían 4 fichas en una casilla normal.
- **Salida de casa con un 5** (regla propia, prevalece sobre la de barreras):
  - Si hay fichas en casa y alguna puede salir, es **obligatorio** sacar una: con el 5 solo se ofrecen salidas (`MUST_EXIT_HOME` si se intenta otra jugada). Si ninguna puede salir, el 5 se juega con normalidad.
  - No se puede salir si ya hay 2 fichas propias en la salida (`OWN_BLOCKADE_ON_EXIT`).
  - Con una ficha propia, sale (barrera propia). Con una rival, o con una propia y una rival, sale y captura a la rival. Con dos fichas de otros colores (iguales o distintos), sale y captura a la que llegó la última (mayor `arrivalOrder`). Una barrera de dos colores en la salida no impide salir. Nunca quedan más de 2.
- **Con un 6, obligación de abrir barreras:** si alguna jugada legal abre una barrera en la que participa una ficha propia (del mismo color o de dos colores en un seguro), solo se ofrecen esas jugadas (`MUST_BREAK_BLOCKADE` si se intenta otra). Si ninguna se puede abrir, se aplican las reglas normales del 6. Nunca obliga a abrir barreras formadas solo por rivales.
- Las dos obligaciones están en `getLegalMoves` (`moves.ts`), la única fuente de movimientos legales: la usan `getAvailableMoves` (y con ella la IA), la validación de `applyAction` y la concesión de bonus. Los bonus (+10/+20) no son ni 5 ni 6, así que no les afecta ninguna.
- Se captura en casillas normales; nunca en casillas seguras ni en barreras (salvo al salir de casa). Si hay varias fichas candidatas, se captura la que llegó la última: la de mayor `arrivalOrder`, que se asigna con `moveCounter` cada vez que una ficha se mueve (mismo criterio que el original).
- Para llegar a la meta hace falta la tirada exacta.
- Bonus: +20 por captura y +10 por llegar a la meta. Se juegan antes de volver a tirar, se pueden encadenar y se pierden si ninguna ficha puede usarlos.
- Con un 6 se vuelve a tirar. Si el bonus venía de un movimiento con 6, también se vuelve a tirar después de usarlo.
- Tres seises seguidos: al sacar el tercer 6, la última ficha movida por ese jugador vuelve a casa y pasa el turno. **Regla confirmada; no cambiarla.**
- Orden de turno: pink → blue → purple → green. Se saltan los colores ausentes y los jugadores que han terminado. La partida acaba cuando solo queda un jugador sin terminar.

### Decisiones pendientes / no implementado

Ninguna de estas reglas existía en el original; no se ha inventado nada.

- **Contar 7 con un 6 cuando todas las fichas están fuera:** no implementado.
- **Tercer 6:** devuelve a casa la última ficha movida aunque esté en el pasillo final o en la meta (como en el original).

## Tablero visual

Solo dibuja el `GameState` del motor; no contiene reglas. Todo se dibuja en un único `<svg viewBox="0 0 1600 1600">`, que escala con CSS en escritorio y móvil.

### `src/lib/board/` (sin React)

- `geometry.ts`: coordenadas en el viewBox 1600.
  - `TRACK_CELLS`: las 68 casillas, portadas de `backend/game/utils/boardMap.js` y verificadas sobre `board-path.svg`.
  - `HOME_STRETCH`: las 7 casillas de color por color, portadas de `homeStretchMap.js`. Blue y green están corregidos: en el original estaban desplazados una casilla.
  - `BASE_SLOTS`: posiciones en casa, tomadas de los círculos de `board-base.svg`.
  - `GOAL_SLOTS`: posiciones en la meta (`finishedPositions` del original).
  - También: orientación de las casillas, `CELL_LENGTH`/`CELL_WIDTH`, colores y nombres en español.
  - `PIECE_IMAGE_SCALE = 512/343`: los PNG de las fichas tienen margen transparente, y la ficha visible ocupa 343 de 512 px.
- `layout.ts`:
  - `getPieceSlot(color, index, steps)`: casilla lógica de una ficha (casa, recorrido, pasillo o meta), con el mismo convenio de `steps` que el motor.
  - `layoutPieces(state, { movingKey })`: posición y tamaño visible de cada ficha. Agrupa por casilla lógica en una sola pasada, así ninguna ficha se dibuja dos veces. Si hay varias en una casilla, las reparte a lo largo de su eje largo y las reduce (58 / 50 / 36 / 27) para que quepan.
    - La ficha `movingKey` no se apila: va centrada, y las que encuentra en el camino no se recolocan.
    - El orden de los nodos es siempre el mismo, para que el navegador no corte las transiciones.
  - `PIECE_IMAGES`: rutas de los PNG de las fichas (las usan el tablero y el HUD).
- `journey.ts`: recorrido continuo de una ficha en casillas avanzadas (0 = salida, 63 = entrada, 64–70 = casillas de color, 71 = meta), sin el salto de `steps` 63 → 68 del motor.
  - `stepsToJourney` / `journeyToSteps`.
  - `journeySteps(from, to)`: los `steps` de cada casilla que pisa la ficha.
  - `pieceStateForSteps`.
  - Lo usan la animación y el progreso del HUD.
- `animation.ts`: `buildAnimation(prev, events, next)` convierte los eventos de una acción en fotogramas (ver "Animación de las fichas").
- `demo.ts`:
  - `DEMO_PLAYER_IDS` / `DEMO_PLAYER_NAMES`: jugadores con nombres provisionales hasta tener los personajes de IA.
  - `createDemoGame()`: partida nueva con esos jugadores.
  - `createShowcaseState()`: estado de ejemplo con un caso de cada (casa, salida, barrera, dos colores en un seguro —también barrera—, pasillos y meta).

### `src/components/board/`

- `ParchisBoard.tsx`: tablero de solo lectura. No usa hooks, así que funciona como Server o Client Component. Props:
  - `state`: el estado real o un fotograma.
  - `highlightedPieces` (opcional; por ejemplo `getAvailableMoves(state)`).
  - `movingKey` y `transitionMs` (opcionales), durante la animación.
- `useBoardAnimation.ts` (`"use client"`): reproduce los fotogramas y expone `frame`, `animating`, `play(frames)` y `cancel()`. Respeta `prefers-reduced-motion`: en ese caso no anima.
- `BoardLayers.tsx`: las 5 capas SVG como `<image>`, con el orden y la opacidad de `GameBoard.tsx` del original.
- `BoardPiece.tsx`: ficha con halo, PNG con sombra de color, anillo de resaltado y `<title>` accesible. Se desplaza con una transición CSS de `transform` que dura `transitionMs`: lineal al moverse casilla a casilla y `ease-out` en el resto.
- `BoardDemo.tsx` (`"use client"`): demostración. Ver la página `/tablero`.

### Recursos reutilizados (copiados de `frontend/public/`)

- `public/board/`: `board-base.svg`, `board-glow.svg`, `board-effects.svg` y `board-home-paths.svg` (escala 1000) y `board-path.svg` (escala 732, con las casillas numeradas). Todas son cuadradas y se superponen sobre el mismo viewBox.
  - `board-home-paths.svg` (solo la copia de `web/`): eliminados del grupo `MAIN TRACK` los 7 rectángulos verdes y los 7 azules que duplicaban `HOME LANES`. **Pendiente de decidir:** rosa y morado tienen el mismo duplicado (y = 55–349 y y = 606–900) y se han dejado sin tocar.
- `public/pieces/`: `pink-`, `purple-`, `green-` y `blue-piece.png` (512×512).
- `public/ui/`: `dice-1.svg` … `dice-6.svg` (512×512), para el panel del dado.

## Animación de las fichas

Las fichas recorren el tablero casilla a casilla usando los eventos del motor. Sin dependencias: transiciones CSS más `setTimeout`.

- **Estado real separado del visual:**
  - El motor se actualiza al instante con `applyAction`, y el HUD muestra ese estado real.
  - El tablero dibuja `applyPositions(state, frame.positions)` mientras hay fotogramas.
  - `positions` son solo los `steps` visibles de cada ficha.
- **`buildAnimation(prev, events, next)`**, a partir de las posiciones de `prev`:
  - `piece_moved`: un fotograma por casilla (`journeySteps`). Cubre la salida de casa (un salto a la salida, 320 ms), el recorrido con sus esquinas, la entrada, las casillas de color y la meta.
  - Duración de cada salto: 170 ms. Un movimiento largo (bonus de 20) dura como mucho 1500 ms, con un mínimo de 55 ms por salto.
  - `piece_captured` y `third_six_penalty`: la ficha vuelve a casa (420 ms) después de que llegue la que captura.
  - Fotograma final (220 ms) con las posiciones de `next`: la animación siempre acaba en el estado real, y las fichas se reapilan.
  - Si la acción no mueve fichas (una tirada), devuelve `[]`.
  - Los tiempos están en `ANIMATION_TIMING`.
- **Bloqueo:**
  - Mientras `animating`, *Siguiente acción* y *Lanzar dado* están desactivados (el dado muestra "Moviendo ficha…").
  - `perform` ignora acciones.
  - El modo automático espera a que termine la animación y hace una pausa de 450 ms.
  - *Ejemplo* y *Partida nueva* cancelan la animación.
- **Comprobado en Chrome**, muestreando la posición interpolada de las fichas en cada fotograma, en escritorio y móvil:
  - 60 fps.
  - Sin saltos de más de ¼ de casilla entre fotogramas.
  - Ninguna acción posible mientras hay fichas en movimiento.
  - Los movimientos siguen el recorrido: giran en las esquinas en lugar de ir en línea recta.
- **Límite conocido:** como el orden de los nodos SVG es fijo, una ficha en movimiento puede pasar por debajo de otra en una casilla compartida.

## HUD de jugadores y dados

Igual que el tablero: deriva todo del `GameState` del motor y no contiene reglas. Lo que se puede hacer sale del estado y de `getAvailableMoves`.

### `src/lib/hud/` (sin React)

- `summary.ts`:
  - `getPlayerSummaries(state)`: por jugador, color, estado (`turn`, `waiting` o `finished`), puesto, fichas por zona (casa, recorrido, pasillo, meta) y progreso de 0 a 100.
  - `pieceProgress(piece)`: casillas avanzadas por una ficha (0 a 71 = 63 de recorrido + 8 de tramo final).
  - `getTurnInfo(state)`: jugador en turno y fase: `roll` (puede lanzar), `move` (dado y fichas movibles), `bonus` (cantidad, motivo y si después repite) o `finished` (ganador). También el último dado, los seises del turno y `canRoll`.
- `events.ts`: `describeEvent(event, names)`, el texto en español de cada `GameEvent`. Devuelve `null` para `turn_changed`.

### `src/components/hud/`

Ninguno usa hooks; reciben los datos ya calculados.

- `DicePanel.tsx`: la cara del dado y el texto de la fase del turno, con el bonus (+20/+10 y si después repite tirada) y los seises seguidos (3 puntos; el tercero en rojo). Si recibe `onRoll`, muestra el botón *Lanzar dado*, activo solo cuando `canRoll` y no `busy` (animación en curso). El espectador no lo tendrá.
- `DiceFace.tsx`: la cara del dado (`next/image`). Se anima con `motion-safe:animate-dice-roll` (keyframes en `globals.css`) cuando cambia `rollKey`, y se atenúa si el valor ya se ha usado.
- `PlayersPanel.tsx`: una tarjeta por jugador con la ficha de su color como avatar, nombre, estado (*En turno*, *Esperando*, *Ganador*, *Nº puesto*), barra de progreso de su color y fichas por zona. El jugador en turno se resalta con borde y halo de su color. Adaptado de `frontend/src/game/hud/PlayersPanel.tsx`; no hay avatares de usuario ni estado de conexión.
- `TurnLog.tsx`: las últimas jugadas, a partir de los eventos del motor. No es el chat.
- `ChatPanel.tsx`: el chat de los personajes (ver "Chat entre personajes"). Sin hooks.
- Componentes shadcn usados: `ui/progress.tsx` (Base UI, sin dependencias nuevas) y `ui/button.tsx`.

## Portada (`src/app/page.tsx`)

- Server Component (estático) con el botón **«Nueva partida»** y el enlace «Ver el tablero (demo)» a `/tablero`. Sin registro, login ni participación humana: la partida la juegan los cuatro personajes.
- `src/lib/home/newGame.ts` (sin React; `fetch` y navegación inyectados):
  - `interpretCreateResponse(status, body, retryAfter)`:
    - 201 con `id` UUID válido → partida creada. Cualquier otra respuesta, incluido un 201 sin id válido, nunca navega a una ruta rota.
    - Errores con mensajes comprensibles y sin detalles técnicos: 429 con la espera de `Retry-After` en segundos o minutos, 503 servicio no disponible, sin red y genérico.
  - `NewGameController`: `create()` hace `POST /api/games` con `{}` y `no-store`, y navega a `/partida/[id]`.
    - Estados `idle`, `creating` y `error`.
    - **Una sola petición a la vez:** los clics se ignoran mientras se crea y mientras se navega (sigue en `creating`).
    - Tras un error, `create()` es el reintento.
- `src/components/home/NewGameButton.tsx` (`"use client"`):
  - `NewGameButton` conecta el controlador con `router.push` (`useRouter` de `next/navigation`).
  - `NewGameButtonView` (sin hooks) muestra:
    - El botón («Nueva partida» / «Creando partida…» desactivado con `aria-busy` / «Reintentar»).
    - Una región `role="status"` con el progreso.
    - El error en `role="alert"`.
- **Comprobado en Chrome** con `next start` y variables de Supabase falsas, interceptando `POST /api/games` (no llega al servidor ni a Supabase):
  - Tres clics rápidos hacen una sola petición, con el botón desactivado y el texto de carga.
  - Un 503 muestra el mensaje y «Reintentar».
  - Al reintentar con un 201, navega a `/partida/[id]`.

## Página `/tablero` (`src/app/tablero/page.tsx`)

- Server Component con tema oscuro (clase `dark`) que muestra `BoardDemo`. La portada (`/`) enlaza aquí.
- **Disposición:** en escritorio (`lg`), el tablero va a la izquierda y el HUD en una columna de 21 rem a la derecha (dado y turno, jugadores, últimas jugadas). En móvil, el HUD va debajo del tablero y de los botones.
- `BoardDemo` (`"use client"`) usa el motor real (`applyAction`, `getAvailableMoves`) con un dado aleatorio (`Math.random`) y mueve siempre la primera ficha legal. **No es la IA del juego.**
  - Guarda el estado real, las últimas 6 jugadas (de los eventos de cada acción) y el número de tiradas, que reinicia la animación del dado.
  - Cada acción lanza `buildAnimation` con `useBoardAnimation`.
  - Resalta en el tablero las fichas que se pueden mover, excepto durante la animación.
  - Botones: *Siguiente acción*, *Automático/Pausar* (espera a la animación y luego 450 ms), *Ejemplo* (vuelve al estado de muestra), *Partida nueva* y *Lanzar dado* (en el panel del dado; se oculta en modo automático).

## Referencias del proyecto original (para las próximas fases)

- Interfaz pendiente de portar: animación de victoria (`frontend/src/game/animations/VictoryAnimation.tsx`, que usa `react-confetti`). El chat ya está portado (`ChatPanel.tsx`, sin campo de escritura).

## Decisiones de arquitectura

- Sin registro, login ni jugadores humanos en la partida.
- El servidor tira el dado y valida todo con el motor; la IA **solo elige** entre los movimientos legales que calcula el motor.
- Supabase (BD + Realtime): tabla `public.games` creada y conexión configurada (ver "Supabase"). Desplegado en Vercel.
- El LLM del chat (Vercel AI Gateway, fase 8.2b) solo escribe texto de algunas intervenciones; nunca decide nada del juego. Está desactivado por defecto.
- Las claves privadas solo existen en el servidor (nunca con el prefijo `NEXT_PUBLIC_`).

## Supabase

- Tabla `public.games` creada en Supabase (SQL aprobado: estado JSONB, `version`, reserva `lock_token`/`processing_until` de 20 s con el reloj de PostgreSQL, trigger `games_guard`, RLS de solo lectura pública, escritura solo `service_role`, Realtime).
- `src/lib/supabase/`:
  - `env.ts`: valida las variables con Zod (sin mostrar valores). Rechaza una URL con ruta (debe ser la URL base, sin `/rest/v1/`) y una clave secreta en variables `NEXT_PUBLIC_`.
  - `browser.ts`: `getBrowserSupabase()`, con la URL y la clave publicable; para leer y suscribirse a Realtime.
  - `server.ts`: `getServerSupabase()`, con la clave secreta (`service_role`, ignora RLS). Protegido con `import "server-only"`.
  - Los dos clientes se crean la primera vez que se usan y no tienen sesión (`persistSession`, `autoRefreshToken` y `detectSessionInUrl` desactivados).
- Variables (`web/.env.local`, ignorado por Git; plantilla en `web/.env.example`): `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (`sb_publishable_…`) y `SUPABASE_SECRET_KEY` (`sb_secret_…`, solo servidor).
- Dependencias exactas: `@supabase/supabase-js@2.118.0`, `zod@4.6.7`, `server-only@0.0.1`. Sin `@supabase/ssr` (no hay autenticación).
- `src/lib/game/`:
  - `characters.ts`: catálogo de los 4 personajes, con ids estables `ai-pink`, `ai-purple`, `ai-green` y `ai-blue` (en el orden de `COLORS`). Cada uno tiene nombre, género gramatical (`gender`: `f` Brava y Abuela Pilar, `m` Don Ernesto y Chispa; ver «Concordancia de género»), arquetipo, personalidad, expresiones, perfil de estrategia (ver "Personajes") y perfil de chat (ver "Chat entre personajes").
  - `schemas.ts`: esquemas Zod tipados contra el motor (`z.ZodType<GameState>`, `GameAction`, `GameEvent`) y `GameRowSchema`, que exige que `status` y `winner` coincidan con `state`. También `toStoredGame` (camelCase, sin `lock_token`) y `ENGINE_STATE_VERSION = 1`.
  - `repository.ts` (`server-only`): operaciones sobre el cliente de servidor. Valida antes de escribir y al leer. Errores `GameRepositoryError` (`not_found`, `invalid_data`, `unsupported_version` y `database`; código de PostgreSQL solo para el registro; sin código = fallo de red, con su mensaje técnico).
    - `create(state)` y `get(id)`.
    - `claim(id, version, token)`: `UPDATE lock_token` con filtro por `id`, `version` y `status = 'playing'`. El plazo de 20 s lo fija el trigger.
    - `commit(id, version, token, { state, action, events })`: versión + 1 con el mismo token en `SET` y `WHERE`. Valida antes con Zod.
    - `release(id, token)`.
    - `55P03` (reserva vigente o caducada) o 0 filas → `null`, que el servicio trata como conflicto.
  - `ai.ts` (puro): IA heurística sin LLM, con el perfil de cada personaje (ver "Personajes").
    - `scoreMove(state, i, strategy?)`: simula cada jugada legal con `applyAction` (sin duplicar reglas) y puntúa con `AI_WEIGHTS` × multiplicadores del perfil. Pesos base: captura 1000, meta 800, salir de casa 400, entrar al pasillo 250, casilla segura 120, +1 por casilla, −150 por cada rival a 1-6 casillas detrás, +60 por barrera propia (dos fichas propias en una casilla normal) y +30 por cada rival capturable a 1-6 casillas delante (caza). Por defecto, el perfil del jugador en turno.
    - `chooseMove(state, moves, { strategy?, random? })`: solo considera índices que también devuelve `getAvailableMoves` (si no queda ninguno, lanza un error). Sin azar: la mejor jugada, con desempate por el índice más bajo.
    - `candidateMoves` y `createSeededRandom` (mulberry32, para pruebas).
    - `decideAction(state, rollDie, random?)`: sin dado ni bonus → `roll` con el valor de `rollDie`; con dado o bonus → `move`; sin movimientos legales (estado anómalo) → `timeout`.
  - `advance.ts`: `advanceGame(id, expectedVersion, { repository, rollDie, newToken, random? })` aplica **una** acción por llamada. `random` (opcional) es el azar de Chispa; sin él, todos los personajes son deterministas.
    - Pasos: leer → comprobar versión y estado → reservar → decidir y aplicar con el motor → confirmar; si algo falla tras reservar, liberar.
    - Resultados: `advanced`, `not_found`, `game_finished`, `version_conflict` (con `currentVersion`), `turn_in_progress` y `lease_expired`.
- `POST /api/games` (`src/app/api/games/route.ts`): crea una partida con `createGame(CHARACTER_IDS)`.
  - Respuestas: 201 `{ id, version }`; 400 si el cuerpo no está vacío o no es `{}`; 503 o 500 con mensajes genéricos. Todas con `Cache-Control: no-store`.
- `GET /api/games/[id]` (`src/app/api/games/[id]/route.ts`): devuelve la partida guardada, leída con el repositorio y validada con `GameRowSchema`.
  - 200 `{ id, version, status, winner, state, lastAction, lastEvents, createdAt, updatedAt, finishedAt }`, sin `lock_token`, `processingUntil` ni `engineVersion`. `lastAction`/`lastEvents` son la acción y los eventos que llevaron a esta versión (`null`/`[]` en la v1).
  - 404 `not_found` si no existe o el id no es UUID (sin consultar la BD); 503 `storage_unavailable` si falla la BD; 500 genérico si la fila no es válida o falta configuración. Siempre `Cache-Control: no-store`.
- `src/lib/http/responses.ts`: `NO_STORE`, `errorResponse()` y `handleRouteError()` (traduce `SupabaseEnvError` y `GameRepositoryError` a 500 o 503 con mensajes genéricos y registra solo tipo y código), compartidos por los Route Handlers.
- `src/lib/game/api.ts` (sin dependencias de servidor): `GameResponseSchema` (contrato de lectura: reutiliza `GameStateSchema`, `GameActionSchema` y `GameEventSchema`), `toGameResponse()` y el tipo `LoadGameResult` (`ok`, `not_found` o `error` con mensaje).
- `src/lib/game/load.ts` (`server-only`): `loadGame(id)` lee con el repositorio, valida con `GameResponseSchema` y traduce los errores a mensajes seguros. Nunca lanza.
- Página `/partida/[id]` (`src/app/partida/[id]/page.tsx`): partida guardada en modo espectador, **leída en el servidor** (Partial Prerender).
  - La página no es async: el componente async `GameLoader` (`await params` + `loadGame`) va dentro de `<Suspense fallback={<GameLoading />}>`. La cabecera y el esqueleto son estáticos y la partida llega en streaming.
  - El HTML ya trae la partida (carga inicial siempre en el servidor). La clave secreta no sale del servidor.
  - `GameLoader` lee `headers()` y después hace `await connection()` antes del límite de lectura (`checkRead`) y de la carga. Con `cacheComponents`, `headers()` también se resuelve al prerenderizar el App Shell de la ruta; sin `connection()`, el limitador (y el `Date.now()` de Upstash) se ejecutaba durante el prerender y Next.js lo avisaba. El límite se sigue aplicando en cada petición real.
  - Después, **en directo** (ver "Partida en directo"): el navegador la hace avanzar y la sigue por Realtime.
  - `src/components/game/`:
    - `GameScreen.tsx`: decide qué mostrar según `LoadGameResult`; con `ok` renderiza `LiveGame`.
    - `GameView.tsx`: aviso de estado (**en curso**: franja verde con el turno; **terminada**: aviso ámbar con el ganador y la clasificación 1º–4º, marco ámbar y sin fichas resaltadas).
      - Reutiliza `ParchisBoard` (posiciones reales; resalta las fichas movibles si hay dado), `DicePanel` (sin botón de tirar), `PlayersPanel` y `TurnLog` ("Última jugada": la acción y sus eventos con `describeEvent`).
      - También los datos de la partida (estado, versión, fechas en hora de Madrid, id).
    - `GameStatus.tsx`: `GameLoading` (esqueleto accesible) y `GameError` (mensaje, `retryable` y *Volver al inicio*).
    - `RetryButton.tsx` (`"use client"`): `router.refresh()` para volver a ejecutar la carga en el servidor.
  - `TurnLog` (HUD) admite `title`, `description` y `emptyText` opcionales. La demo de `/tablero` usa los valores por defecto.
  - La tabla solo guarda los eventos de la **última** acción. En directo, el navegador acumula los de las versiones que va mostrando (8 últimas entradas); al abrir la página solo se ven los de la última. Un historial completo necesitaría una tabla `game_events`, decisión pendiente.
- `POST /api/games/[id]/advance` (`src/app/api/games/[id]/advance/route.ts`): avanza una acción del personaje en turno. Cuerpo: `{ "expectedVersion": <entero ≥ 1> }`.
  - Dado: `crypto.randomInt(1, 7)`, solo en el servidor. Azar de Chispa: `crypto.randomInt(0, 2³²) / 2³²`. Token de reserva: `crypto.randomUUID()`.
  - 200 `{ id, version, status, winner, action, events, state }`.
  - 400 `invalid_body` y 404 `not_found`.
  - 409, sin cambios en la partida y con `currentVersion` cuando se conoce: `version_conflict`, `turn_in_progress`, `game_finished` o `lease_expired`.
  - 503 `storage_unavailable` (fallo de BD o red; reintentable con la misma versión) y 500 genérico. Siempre `no-store`.
  - **Sin duplicados:** un reintento o una petición simultánea con la misma `expectedVersion` nunca repite un movimiento (versión + reserva + trigger).
  - **Respuesta perdida:** si se pierde la respuesta de una confirmación (503 por red), la acción pudo guardarse. Al reintentar se recibe `version_conflict` con la versión nueva.
  - **Comprobado con Supabase real:**
    - Partida `3f39156e-12ec-4bd0-86af-58a5ccf8cd66` jugada completa (v1 → v646, gana `ai-green`); el estado final valida con Zod y la reserva queda libre.
    - 5 peticiones simultáneas: 1 avanza y 4 reciben 409.
    - Un reintento con versión antigua da 409.
    - Hubo un 503 por red cuya confirmación sí se guardó, y no se duplicó nada.
- **Si `next dev` lleva en marcha desde antes de añadir métodos al repositorio, hay que reiniciarlo:** se vio `repository.claim is not a function` porque no recargó el módulo.

## Personajes (fase 8.1)

Cada personaje juega con su propio perfil (`strategy` en `characters.ts`): multiplicadores (≥ 0) sobre `AI_WEIGHTS` y un azar acotado. También tiene un perfil de chat (`chat`: registro, `talkativeness` y frases locales; ver "Chat entre personajes"). La personalidad solo cambia la puntuación: la IA elige siempre entre `getAvailableMoves`, así que nunca hace jugadas ilegales. Al prompt del LLM (fase 8.2b) solo va `chat.voice`: el carácter en una línea, sin frases hechas. `personality` y `chat.register` se conservan en el catálogo pero no se envían, porque repetían lo mismo con matices contradictorios. Las `catchphrases` (coletillas) no se envían al LLM: sirven para detectar repeticiones (ver «Registro de coletillas»).

| | Brava (`ai-pink`) | Don Ernesto (`ai-purple`) | Abuela Pilar (`ai-green`) | Chispa (`ai-blue`) |
|---|---|---|---|---|
| Arquetipo | agresiva, cazadora | estratega, barreras | prudente, segura | imprevisible, corredor |
| Captura | ×1,5 | ×1 | ×0,8 | ×1 |
| Meta | ×1 | ×1 | ×1,25 | ×1 |
| Salir de casa | ×1,25 | ×1 | ×1 | ×1 |
| Entrar al pasillo | ×1 | ×1 | ×1,5 | ×1 |
| Casilla segura | ×0,5 | ×1 | ×2 | ×1 |
| Avance por casilla | ×1 | ×0,7 | ×1 | ×2 |
| Amenaza | ×0,4 | ×1,5 | ×2 | ×1 |
| Barrera | ×1 | ×3 | ×1,5 | ×0,5 |
| Caza | ×3 | ×1 | 0 | ×1 |
| Azar | — | — | — | 15 % |

- Brava, Don Ernesto y Pilar son deterministas. Un id que no está en el catálogo usa `NEUTRAL_STRATEGY` (todo ×1, sin azar).
- **Azar de Chispa:** elige al azar (con `random`) entre las jugadas legales que puntúan como mucho un 15 % por debajo de la mejor. El margen es `0,15 × |mejor|`, así que funciona con puntuaciones negativas, y con la mejor en 0 solo entran los empates. Se descartan las puntuaciones no finitas, y si `random` devuelve un valor fuera de [0, 1) o `NaN`, se acota. `MAX_RANDOMNESS` = 0,15 y el catálogo se valida al cargar.
- **En la práctica, el azar solo reparte entre empates.** Medido en 40 partidas: el 28 % de las decisiones de Chispa tienen varias candidatas, pero nunca hubo una jugada distinta a menos de un 15 % de la mejor, porque los pesos son discretos. Si se quiere un Chispa más imprevisible, hay que ampliar el margen o usar un margen absoluto. **Decisión pendiente.**
- Nombres visibles: los usan el HUD, el registro de jugadas y `/partida/[id]`. La demo de `/tablero` sigue con sus nombres provisionales (`demo.ts`).

## Partida en directo (`/partida/[id]`)

La carga inicial sigue en el servidor. `LiveGame` (cliente) recibe esa partida y, mientras está montado, la hace avanzar y la sigue por Realtime. Si nadie observa, la partida no avanza.

- `src/lib/game/live.ts` (puro): modelo de versiones.
  - `latest` es la versión más alta conocida, `display` la que se muestra, y `queue` las pendientes entre ambas.
  - `receive` ignora las versiones ≤ `latest`: duplicados (la respuesta de `advance` y Realtime traen la misma), reservas y liberaciones. Con la misma versión solo refresca fechas **más recientes** o `finishedAt` (la respuesta de `advance` no trae fechas).
  - `takeDisplayStep`: `display + 1` → `animate` (con `lastEvents`); un hueco de versiones o más de `MAX_QUEUE` (3) pendientes → `jump` sin animar.
  - `parseRealtimeRow` (con `GameRowSchema`) e `interpretAdvance`: 200 → `update`; 409 `version_conflict`/`game_finished` → `resync`; 409 `turn_in_progress`/`lease_expired` → `wait`; 503, 500 o red → `retry`; 404 o 400 → `fatal`.
  - `retryDelay`: 1, 2, 4, 8… s, máximo 15 s.
- `src/lib/game/liveController.ts` (sin React; `fetch`, Realtime y temporizadores inyectados):
  - Bucle de avance: **una petición a la vez**, solo cuando todo lo recibido ya se ha mostrado (animación terminada), tras una pausa de 450 ms, y con `expectedVersion = latest.version`. El servidor impide repetir una versión.
  - Tras un 409 `version_conflict` con `currentVersion`: si esa versión ya llegó por Realtime, no hace nada; si Realtime está conectado, espera hasta 400 ms (`realtimeGraceMs`) a que llegue, sin pedir avances mientras; si no llega, o Realtime está caído, hace `GET`. Así se evita un `GET` por versión cuando hay varios espectadores.
  - Al (re)suscribirse a Realtime, al volver a la pestaña o con el evento `online` del navegador, pide `GET /api/games/[id]`. Una resincronización correcta anula la espera de reintento pendiente y avanza enseguida.
  - Con la pestaña oculta no pide avances (estado `paused`), pero sigue recibiendo por Realtime.
  - Al terminar la partida: una última resincronización (para `finished_at`) y `stop()`. Con un 404: error y `stop()`.
  - `stop()`, al desmontar: cancela la petición en curso (`AbortController`), los temporizadores y la suscripción.
  - Vista (`useSyncExternalStore`): `display`, `animation` (paso con `seq`), `connection` (`connecting`, `live`, `reconnecting`, `paused`, `retrying`, `finished` o `error`), `lastRollVersion` y `log`.
- `src/components/game/realtime.ts`: canal `postgres_changes` (UPDATE de `public.games`, filtro `id=eq.<id>`) con `getBrowserSupabase()` y `postgres_changes_options: { wait: true }`, para que `SUBSCRIBED` signifique que la suscripción ya está activa.
- `src/components/game/useLiveGame.ts`: crea el controlador (`start` al montar, `stop` al desmontar; con `<Activity>` también se detiene al salir de la ruta) y conecta la visibilidad de la pestaña y el evento `online`.
  - Reproduce cada paso con `buildAnimation(from.state, to.lastEvents, to.state)` y `useBoardAnimation` (sin cambiarlos) y avisa al controlador al acabar.
  - Con `prefers-reduced-motion` no anima.
- `src/components/game/LiveGame.tsx`: `GameView` con la prop `live` (tablero en el fotograma actual, ficha en movimiento, dado animado en cada tirada, últimas jugadas y estado de la conexión en el aviso).
- `GameView` sin `live` sigue funcionando igual (estático).
- Sin cambios en el motor, el SQL, los endpoints ni `/tablero`.
- **Comprobado en Chrome** (compilación de producción, Supabase real):
  - Partida `80fd5dd3-34a6-4308-b208-da6dc83099f0` jugada entera desde `/partida/[id]` (v1 → v905, gana `ai-pink`). La página coincide con la BD y, al terminar, no hace más peticiones ni muestra errores.
  - Dos ventanas visibles a la vez se reparten los avances: Σ respuestas 200 = versiones − 1, sin duplicados. Cada una hace unos 3 `GET` gracias al margen de Realtime.
  - Con un corte de red de 40 s, Realtime se reconecta y la partida reanuda a los ~1,1 s.
  - Al cerrar la página, la versión deja de subir.
  - Fichas animadas casilla a casilla (sin saltos de más de ~16 unidades por fotograma).
  - Probado en escritorio (1280) y móvil (390).

## Chat entre personajes (fase 8.2a)

Los personajes comentan los acontecimientos **reales** de la partida. El espectador solo lee. Por defecto, con frases locales (sin LLM ni coste). Con el LLM de la fase 8.2b activado, solo cambia quién escribe el texto de las intervenciones importantes; el director y la persistencia son los mismos.

### Flujo (cola persistente)

1. **Registro en PostgreSQL (trigger tolerante):** el trigger `games_chat_enqueue` (AFTER UPDATE de `games`, solo cuando sube `version`) copia los eventos y el estado de cada versión confirmada a `game_chat_queue`, en la misma transacción que el avance (nunca se encola una versión que no se confirmó). No depende de `after()` ni de la aplicación. **Si el encolado falla, el avance sigue adelante y ese acontecimiento se pierde para el chat** (ver "SQL").
2. **Procesador** (`drainChat`, `service.ts`), que se puede ejecutar desde cualquier sitio y cualquier número de veces:
   1. Reserva el **siguiente lote** de versiones pendientes (hasta 25, en orden), con token y caducidad (`chat_claim`; plazos en `service.ts`).
   2. Para cada versión: director → escritor → validación.
   3. Confirma el lote en una transacción (`chat_commit`): mensajes, borrado de la cola, cursor y liberación.
   4. Repite (hasta 4 lotes) mientras queden pendientes.
3. **Quién lo pone en marcha** (nunca hace falta que una ejecución anterior termine bien: las reservas caducan):
   - Cada avance con algo que comentar (`isChatCandidate`), con `after()` tras responder. Las versiones sin nada que comentar esperan al siguiente lote.
   - Cada `GET /api/games/[id]/messages` que encuentra pendientes (`pending`), también con `after()`.
   - Con la partida **terminada** y pendientes, el navegador vuelve a consultar con espera creciente (2 s → 15 s) hasta que no quede nada. Así se recupera, por ejemplo, la victoria si el último procesador murió y ya no llegan avances.
   - Al abrir una partida terminada con pendientes, el chat se activa aunque la partida ya no avance.
4. **Navegador:**
   - Realtime (INSERT en `game_messages`) y `GET ...?after=<último id>` al (re)suscribirse, al volver a la pestaña y con `online`.
   - Los mensajes se muestran solo cuando `boardVersion` (versión que el tablero **terminó** de animar) ≥ versión del mensaje.

### `src/lib/chat/`

- `config.ts`: **única fuente de verdad** de los límites; los esquemas, el director y el escritor leen de aquí.
  - `CHAT_LIMITS`: 60 por partida y 2 reservados para la victoria, pausas de 8 y 3 versiones, silencio de 40, valoración de ambiente cada 10, rachas (ventana de 60, 3 capturas o 2 seguidas), 50 capturas recordadas, 12 textos recientes, 40 frases recordadas por personaje, similitud 0,6, 160 caracteres, tiempos de la reserva y del escritor (`leaseSeconds`, `workBudgetFraction`, `writerTimeoutMs`, `commitMarginMs` y `minWriterMs`; ver `service.ts`), lotes de 25 y 4 lotes por ejecución, 15 versiones de desfase, 3 intentos, 20 iniciales, páginas de 100 y consulta de pendientes 2–15 s.
  - `CHAT_STORAGE`: copia de las restricciones de `game_messages` en el SQL (texto ≤ 200, `seq` ≤ 3, formato del personaje). `config.test.ts` comprueba que coinciden con el SQL.
  - También `TRIGGER_CHANCE` y `REPLY_CHANCE`. Capturas 0,5, racha 0,7, mala racha 0,65, meta 0,65 y ambiente 0,55; tercer 6 (0,85) y puesto final (0,9) sin cambios. Así, las capturas bajan de ≈63 % a ≈51 % del chat (B4).
- `schemas.ts` (sin servidor): `ChatMessage` (contrato público), `ChatMessageRow` (fila o Realtime), `ChatPage` (con `pending`), `NewChatMessage` (con `version`), `DirectorState` (con `usedLines` y `usedCatchphrases`, que un estado guardado sin ellos lee como vacíos, y con `observedThrough` y `historyGapThrough`, que lee como `null`; ver «Continuidad del historial»), `CHAT_TRIGGERS` y `CHAT_SOURCES` (`local`/`llm`). Sin números repetidos: todos los límites vienen de `config.ts`.
- `director.ts` (puro, azar inyectado):
  - **Disparadores**, por prioridad: victoria (`player_finished` con puesto 1), tercer 6, captura, racha o mala racha, puesto final, ficha en meta y ambiente. Tiradas y movimientos normales: nada.
  - **Rachas** (`streakOf`): para quien captura (racha) o para la víctima (mala racha). Cuenta las capturas en la ventana de 60 versiones y cuántas de las últimas de la partida son suyas sin interrupción. Es racha con 3 en la ventana o 2 seguidas. El mensaje principal de una racha lleva `streak: { count, consecutive }` (`consecutive` solo si todas fueron seguidas), que usan las frases locales. **La réplica no lo hereda** (es la racha de otro personaje).
  - **Hechos de captura** (`captureFacts`, P4): cada intervención de una captura (mensaje o réplica, en los tres disparadores) lleva `captures`, calculado desde **quien habla** a partir del historial de capturas (eventos reales), nunca del texto de otro mensaje:
    - `self` y `rival`: capturas hechas (`made`) y recibidas (`received`) en la ventana (recuento **histórico**: varias capturas en poco tiempo); las hechas desde la última vez que le capturaron (`madeSinceBreak`) y las recibidas desde la última vez que capturó (`receivedSinceBreak`), es decir, el **tramo vivo**; y su racha y mala racha (`streak`, `badStreak`) con su estado: `active`, `ended` o `null`.
    - `selfOnRival` y `rivalOnSelf`: capturas de la pareja en cada dirección (recuento y si fueron seguidas).
    - **Estado, solo sobre el tramo vivo** (`liveSegment`/`liveStreak`): una racha se interrumpe cuando a quien la lleva le capturan; una mala racha, cuando quien la sufre captura. El tramo vivo son las capturas posteriores a la última interrupción, con la misma condición que `streakOf` (3 en el tramo o 2 seguidas).
      - Quien captura: su racha queda `active` si su tramo vivo la forma; su mala racha, si seguía viva justo antes, queda `ended` (con los datos de su tramo).
      - Quien recibe: su mala racha queda `active` si su tramo vivo la forma; su racha de capturas, si seguía viva, queda `ended`.
      - Una captura posterior a una interrupción **empieza un tramo nuevo** y no recupera las del anterior; una racha interrumpida no reaparece como activa ni se interrumpe otra vez. Una misma captura puede hacer crecer una racha e interrumpir otra.
    - **Los disparadores no cambian** (`streakOf` sobre la ventana). Tras un reinicio puede haber `capture_streak` o `bad_streak` por varias capturas en poco tiempo sin racha viva en los hechos. Ejemplo R1: Brava captura en v10, v20 y v30, Chispa la captura en v40 y Brava vuelve a capturar en v50 → `streakOf` {4, no seguidas} (dispara `capture_streak`), `made` 4, `madeSinceBreak` 1 y `streak` `null`. R2, igual con la mala racha.
    - **Ventana de 60 versiones:** una captura entra al procesar su versión (`trackCaptures`, también en las versiones desfasadas, que se observan sin hablar) y deja de contar al procesar la versión `v + 60` (como mucho 50 capturas). «Seguidas» = ninguna otra captura observada entre medias. Una racha que sale de la ventana desaparece (`null`), nunca queda `ended`: solo un evento real la interrumpe. Si sale solo una parte, la interrupción se informa con lo que queda dentro.
    - **Continuidad del historial** (versiones no observadas; `trackCaptures` y `historyComplete`). **Cambio de persistencia:** dos campos en `DirectorStateSchema` (`schemas.ts`), guardados en `director_state` (JSONB) con `chat_commit`. No cambian el SQL, las tablas, `service.ts` ni `store.ts`.
      - **Por qué hacía falta:**
        - La cola recibe todas las versiones desde v2: la partida se crea en v1 con un INSERT y cada avance es exactamente `version + 1` (`games_guard`).
        - El procesador las recorre en orden, pero el director no ve una versión que el trigger no encoló, una defectuosa (`service.ts` la salta sin llamarlo), una victoria defectuosa con eventos inválidos ni las anteriores a un estado inválido (el procesador empieza de cero).
        - Un hueco nunca inventa capturas, pero las oculta: los recuentos bajan, dos capturas separadas por una perdida parecen seguidas y una racha puede parecer activa o interrumpida sin serlo.
      - **Detección:** `trackCaptures` registra siempre la versión. La llaman los caminos de `processItem` que **observan** una versión:
        - el normal, vía `planChat` (`director.ts`, antes de cualquier retorno);
        - las desfasadas;
        - la victoria en modo mínimo con eventos válidos.
      - **Las versiones no observadas no se registran directamente.** Hay dos casos:
        - **No encoladas** (el trigger tolerante falló): nunca llegan a la cola, así que ni `chat_claim` ni `service.ts` las ven. El lote siguiente simplemente no las contiene.
        - **Encoladas pero omitidas por `service.ts`**: datos inválidos, más de 3 intentos o victoria defectuosa con eventos inválidos. `service.ts` las salta devolviendo el director sin cambios (no se modifica), y el lote se confirma igualmente con `chat_commit`: la versión sale de la cola.
        - En los dos casos, el **cursor** (`last_version`) pasa por encima de la versión, mientras `observedThrough` se queda en la última observada (el cursor puede ir por delante);
        - el hueco se detecta **cuando llega la siguiente versión observada**: su `trackCaptures` ve el salto **antes** de calcular ningún hecho, y el estado actualizado se guarda con el `chat_commit` de **ese** lote (`director_state = p_state`, sin condición sobre los mensajes);
        - si no llega ninguna versión posterior, no se calcula ningún hecho nuevo: solo se calculan en `planChat`, después de `trackCaptures`. Nadie más lee `director_state` (no es público).
        - `observedThrough`: la versión más alta observada. **Nunca retrocede.**
        - `historyGapThrough`: la última versión no observada o incierta. **Nunca retrocede.** Sube en estos casos:
          - un salto (v5 tras v3 → 4);
          - un estado sin `observedThrough` (antiguo o reiniciado) cuya primera versión no es v2 (v340 → 339), mientras que una partida nueva que empieza en v2 es completa;
          - una versión repetida, anterior o fuera de orden: se usa el máximo observado, sin añadir sus capturas ni retroceder la ventana;
          - el límite de 50 capturas descarta alguna que aún está en la ventana: se usa la más reciente descartada.
      - **Recuperación tras 60 versiones observadas seguidas:**
        - Todos los hechos usan solo las capturas con `versión − v < 60`, es decir, las versiones V−59…V.
        - Una versión no observada g deja de afectar cuando `V − g ≥ 60`. Con un hueco en v4: en v63 la ventana es v4…v63 (incompleto); en v64 es v5…v64 (completo).
        - Otro hueco o anomalía sube `historyGapThrough` y la cuenta vuelve a empezar.
        - Al recuperarse solo se usan las capturas observadas que siguen en la ventana; no se reconstruye nada.
      - **Con el historial incompleto**, `planChat` decide igual (mismos disparadores, intervenciones y consumo de azar), pero:
        - las intervenciones de captura llevan `captures: { history: "incomplete", selfRole }`, sin recuentos ni rachas;
        - el mensaje principal de una racha no lleva `streak`, así que el escritor local solo elige frases sin `{count}`/`{ritmo}` (hay en todos los tipos y personajes).
      - **Riesgos aceptados:**
        - Las partidas en curso al desplegar (estado sin los campos) quedan incompletas durante 60 versiones.
        - Si se vuelve a una versión anterior del código, Zod descarta los campos y, al volver a desplegar, pasa lo mismo.
        - Si se amplía la ventana de los hechos, hay que revisar la regla de recuperación.
  - **Ambiente:** tras 40 versiones de silencio, solo entre quienes siguen jugando (quien ya terminó no habla ni es el rival del comentario). `ambientCandidates` clasifica por el progreso real, sin depender del orden de los jugadores (un empate no favorece a nadie):
    - **Primero en solitario** (progreso estrictamente mayor que el de todos): `ambient_lead`, el único tipo que afirma ir ganando o en cabeza. Si nombra a un rival, es el último en solitario. **Solo antes de que termine el primer jugador:** tras la primera victoria la partida sigue por los demás puestos (regla original), pero sus frases hablan de la partida entera, así que el primero en solitario entre los que quedan usa las frases neutrales de `ambient_ahead` (con el último en solitario como rival, si lo hay). Las demás categorías y el peso de cada personaje no cambian.
    - **Los demás:** `ambient_ahead` (frase neutral de progreso, sin afirmar posición; si nombra a un rival, es el último en solitario) y, si alguien va por delante de ellos, también `ambient_behind` («voy perdiendo»; si nombra a un rival, es el primero en solitario). «Voy perdiendo» solo lo puede decir quien tenga al menos un rival estrictamente por delante (no hace falta ser el último); los empatados en cabeza no pueden decir que van perdiendo.
    - **Empate en cabeza:** nadie lidera y los empatados no dicen que van por detrás. **Empate total:** solo `ambient_ahead` sin rival, así que la partida no se queda en silencio. Con un empate en la primera o la última posición, no se nombra a ningún «primero» o «último».
    - **Frecuencia:** el peso total de cada personaje sigue siendo su `talkativeness`, repartido entre los tipos que puede usar.
  - Una intervención y, como mucho, **una réplica** (de la otra parte, nunca de sí mismo), en la misma versión (`seq` 0 y 1).
  - Pausas: 8 versiones por personaje (también para replicar) y 3 entre intervenciones. La **victoria** y el último comentario de la partida (`game_finished`) se las saltan.
  - Probabilidad = `TRIGGER_CHANCE` × `talkativeness`: Brava y Chispa 1, Don Ernesto y Pilar 0,6.
  - `recordPublished` actualiza tiempos, textos recientes, frases usadas por cada personaje (`usedLines`, de su `lineId`) y el **registro de coletillas** (`usedCatchphrases`), solo con lo publicado de verdad. `trackCaptures` "observa" una versión sin hablar.
  - `Utterance.important` (victoria, capturas y rachas, con sus réplicas) decide qué intervenciones escribe el LLM cuando está activo (ver "Fase 8.2b").
- `writer.ts`:
  - `ChatWriter`: recibe `usedLines` y `usedCatchphrases` del personaje, `signal` y `timeoutMs` (ver `service.ts`) y devuelve `{ text, source, lineId? }`. Lo implementan el escritor local (`createLocalWriter`) y el escritor LLM (`createGatewayWriter`, ver "Fase 8.2b").
  - `renderLine` rellena `{rival}`, `{count}`/`{Count}` (número real en palabras) y `{ritmo}` ("seguidas" o "en poco tiempo"). Devuelve `null` si a la frase le falta un dato.
  - `createLocalWriter`, entre las frases válidas (con sus datos y sin parecerse a los 12 textos recientes de la partida), **prefiere las que no contienen coletillas que el personaje ya haya publicado** (si todas las tienen, las usa igualmente: nunca se queda sin frase por esto) y, entre ellas, elige al azar una que el personaje **aún no haya usado**; si ya las usó todas, la usada hace más tiempo. Así cada personaje agota las frases de un tipo antes de repetir. Si no queda ninguna válida, calla.
  - `similarity` (Jaccard de trigramas, sin tildes, signos ni **nombres de personajes**: la misma frase a otro rival cuenta como repetida).
  - `validateChatText` (común a cualquier escritor: espacios, longitud, sin `{}`/`<>` y sin repetir).
- `catchphrases.ts` (puro): **registro de coletillas**. `detectCatchphrases(speaker, text)` devuelve los índices de las coletillas de ese personaje (`character.catchphrases`) presentes al inicio de una frase, con variantes («¡A casa con eso!» cuenta como «¡A casa!»; «Vuelve a casa», no). `recordPublished` las añade, por personaje y sin duplicados, a `DirectorState.usedCatchphrases` con lo publicado de verdad (del LLM o local), así que se guardan con `chat_commit` en la misma transacción que los mensajes. Las respuestas rechazadas nunca llegan al registro, y un fallo deja confirmado solo lo anterior (el reintento lo completa). Sin estado global: cada partida tiene el suyo dentro de `director_state`, sin cambios en el SQL.
- `service.ts`: `drainChat(gameId, { store, writer, fallbackWriter, random, newToken, now?, setTimeout?, clearTimeout? })`, que nunca lanza y devuelve `idle`, `done`, `more`, `lease_expired` o `error`. El reloj y los temporizadores se inyectan (por defecto, los globales).
  - `processBatch` recorre el lote en orden y valida eventos y estado con Zod.
  - **Reserva de 30 s, sin renovación** (`leaseSeconds`). El reloj del procesador empieza al recibir la reserva.
  - **Plazo de trabajo del 50 %** (`workBudgetFraction`): pasados 15 s no se empieza otra versión. Se confirma lo hecho y el resto sigue en orden con otra reserva, en la misma ejecución si quedan lotes. La primera versión de cada lote siempre se procesa, así que cada reserva avanza.
  - **Escritor principal:**
    - Cada llamada tiene como máximo `min(8 s, fin de la reserva − 3 s − ahora)` (`writerTimeoutMs`, `commitMarginMs`), así que nunca invade el margen de 3 s para confirmar. Si queda menos de 0,5 s (`minWriterMs`), no se le llama.
    - Al vencer el plazo, la llamada se aborta con `AbortSignal` (`request.signal`, que un escritor con red debe pasar a su petición) y su resultado tardío se ignora: no se repite.
    - El temporizador se limpia tanto si el escritor responde como si rechaza o lanza una excepción síncrona.
    - Si el principal es el mismo que el local (como ahora, con las frases locales), se llama directamente, sin temporizador.
  - **Escritor local** (`fallbackWriter`, obligatorio): se usa, una sola vez por intervención, si el principal falla, agota su tiempo o ya no queda tiempo para él. Si también falla el local, su error se propaga y la versión se trata como fallida (siguiente punto).
  - **Contrato del escritor local:** inmediato, sin red ni esperas, y sin tiempo máximo propio. En el peor caso se ejecuta justo al empezar el margen de confirmación, así que uno que tardara más de 3 s haría caducar la reserva.
  - **Peor caso probado:** con los dos plazos de la última versión agotados, se confirma a los 27 s de 30, con el margen intacto.
  - Con la reserva anterior (10 s, sin plazo de trabajo ni tiempo máximo), un escritor de 4 s por mensaje no avanzaba (6 ejecuciones, 18 llamadas y 0 mensajes guardados). Ahora, 4 capturas (32 s de escritura) se reparten en 2 reservas, sin caducar y con una llamada por mensaje.
  - **Si una versión falla** (por ejemplo, el escritor), se detiene en ella y se confirma lo anterior. La siguiente reserva empieza en ella, así que solo ella acumula `attempts`.
  - **Versión defectuosa** (datos no válidos o más de 3 intentos): se salta sin hablar.
  - **Desfasada** (más de 15 versiones por detrás de la última pendiente): se observa (rachas) sin hablar.
  - **Victoria** (`is_victory`): nunca se descarta ni por desfase ni por intentos, y **siempre puede escribirse con el escritor local**, sin depender del principal:
    - Si el principal falla o tarda, se usa el local.
    - Si es defectuosa, **modo mínimo**: `victory_win` del ganador (leído de los eventos sin validar), directamente con el local.
    - Si todas sus frases "se repiten", se ignora la antirrepetición, también con el local.
  - Una réplica cuyo mensaje se descartó también se descarta.
- `store.ts` (`server-only`): `ChatStore` sobre las funciones SQL (`claim` → `ClaimedBatch` con `items`, `through` y `latest`; `commit(through)` → `{ inserted, hasMore }`; `release`) y lecturas (`pending`, `latest`, `after`). Valida con Zod antes de escribir y al leer. `ChatStoreError` (`database` con código solo para el registro, `invalid_data`).
- `schedule.ts` (`server-only`): `scheduleDrain(gameId)` (`after`, nunca lanza) y `runDrainInBackground` (azar con `crypto`). `chatWriters(env)` elige los escritores (ver "Fase 8.2b").
- `log.ts`: `logChatError`, que registra solo etapa, tipo y código, como mucho una vez por minuto por tipo (por ejemplo, si aún no existen las tablas).
- `load.ts` (`server-only`): `loadChatMessages(id)` → `{ messages, pending }` (los últimos 20 y si quedan pendientes). Nunca lanza: si falla, `[]` y `pending: true` (el navegador lo comprobará).
  - Lee **primero** `pending` y **después** los mensajes, no en paralelo (B2). Como `chat_commit` inserta los mensajes y vacía la cola en la misma transacción, nunca devuelve "sin el último mensaje y sin pendientes", que dejaría sin chat una partida recién terminada.
- `feed.ts` (puro): `mergeMessages` (sin duplicados por id, orden versión → `seq`, máximo 100), `maxMessageId` y `visibleMessages`.
- `chatController.ts` (sin React): Realtime + recuperación por páginas (hasta 5 de 100) tras el último id, una petición a la vez, espera creciente, `Retry-After` en 429, filas de otra partida descartadas y `stop()`. Con `setFinished(true)` comprueba una vez al cabo de 2 s y, mientras haya pendientes, consulta con espera creciente (2 s → 15 s). En curso no consulta: de eso se encargan los avances.

### Personajes (`characters.ts`)

- `chat`: `register`, `voice` (estilo para el prompt del LLM, sin frases hechas; al cargar se comprueba que no contiene ninguna coletilla), `talkativeness` y `lines` (`CHAT_LINE_KINDS`: 13 tipos, entre ellos `ambient_lead`, `ambient_ahead` y `ambient_behind`; ≥ 4 frases cada uno; más en los que más salen, como capturas y rachas). Al cargar el módulo se valida que cada frase use solo sus marcadores: `{rival}` en `LINE_KINDS_WITH_RIVAL`, y `{count}`/`{Count}`/`{ritmo}` en `LINE_KINDS_WITH_STREAK`.
- **Frases como comentarios reales** (limpieza P3): sin jerga de televisión ni de deportes («señores», «en directo», «a cámara», «narrador», «VAR», «¡Gooool!», «golazo», «público», «prensa», «récord»…), ni rebuscamientos («fase completada», «retaguardia», «aperturas», «podio», «caldito»…). Chispa sigue siendo espontáneo, bromista y supersticioso con el dado («mal de ojo», «amuleto», «tocar madera»), pero no comentarista. Se mantienen al menos 4 frases por tipo y sus coletillas. Ninguna frase local dice «racha»: «¡Racha de cazadora!», «¡Racha, racha, racha!» y «Una racha adversa» se podían decir tras un reinicio sin racha viva, y ahora son «¡Hoy estoy de caza!», «¡Otra, otra y otra!» y «El azar me castiga últimamente». Las cifras de las rachas locales (`{count}`, `{ritmo}`) son las de la ventana (capturas en poco tiempo), que siempre son ciertas.
- **Estilo natural de España** (revisión de estilo): frases cortas y coloquiales, como las de cuatro personas jugando al parchís en casa, con el vocabulario de la partida («comer», «ficha», «casa», «meta», «seis», «turno»). Se han sustituido las expresiones artificiales, técnicas o grandilocuentes («Captura ejecutada», «contratiempo táctico», «sin cobertura», «La teoría se confirma en la práctica», «Eficacia demostrada», «Estoy recalculando», «¡Que tiemble el tablero!», «¿necesitas un mapa?», «se ha pasado de entusiasta», «¡Argh!») y las que venían de la televisión o del deporte en Chispa («sin querer… queriendo», «aquí hay partido», «remontadas», «la estaba calentando»). Pilar usa menos refranes (como mucho el 15 % de sus frases) y más diminutivos; Don Ernesto sigue de usted, con cálculo y probabilidad, pero sin tecnicismos; Brava reta, presume y protesta; Chispa reacciona con sorpresa, humor y superstición con el dado. La coletilla de Chispa «Esto es Parchís, señores» (de televisión, y nunca usada en sus frases) pasa a ser «¡Toma ya!» (mismo índice 2 del registro). **Límite:** el chat solo tiene los disparadores actuales (captura, rachas, tres seises, meta, puesto final, victoria y ambiente); no hay intervenciones al salir de casa, al sacar un seis, ante una barrera o una ficha en peligro, porque añadirlas cambiaría los disparadores y la frecuencia.
- **Coherencia de las frases** (comprobada en `writer.test.ts`):
  - Las rachas nunca escriben un número ni "seguidas" a mano.
  - Las frases de tres seises no dicen que una ficha vuelva a casa (a veces no hay ficha que devolver).
  - Meta, puesto final y victoria no hablan de "casa".
  - La victoria (primer puesto, con la partida en marcha) y el puesto final no se despiden ni dan la partida por acabada.
- Las frases son también la **reserva** de 8.2b.

### Interfaz

- `ChatPanel.tsx` (sin hooks): avatar con la ficha del color, nombre en su color, borde de color y "· responde a X" en las réplicas. Es un `role="log"` dentro de `ChatScroll`, alto máximo 18–20 rem. Sin campo de escritura.
- `ChatScroll.tsx` (`"use client"`) y `chatScroll.ts` (B6):
  - **Contenedor:** `flex-col-reverse`, así que empieza abajo y sigue los mensajes nuevos sin JS.
  - **Problema:** WebKit/Safari no tiene anclaje de scroll de CSS. Si el espectador ha subido a leer, cada mensaje nuevo desplazaba lo que leía. Medido en WebKitGTK: 150 px con 3 mensajes; Chrome ya lo compensa solo.
  - **Corrección:** se anota el primer mensaje visible (`data-chat-key`) y su posición, y tras cada cambio se compensa la diferencia. No hace nada si está abajo (ni según lo anotado ni según el estado actual) ni si el navegador ya lo compensó.
  - **Comprobado** en WebKitGTK (motor de Safari, no Safari en sí) y Chrome 145: lo leído no salta (0 px), los mensajes nuevos se ven estando abajo y al volver abajo, y Chrome no corrige dos veces.
- `GameView` recibe `chat` (si no lo recibe, no muestra el panel). Va entre jugadores y últimas jugadas.
- `useLiveChat(gameId, initial, boardVersion, enabled, finished)`: `enabled` si la partida está en curso o, ya terminada, quedan pendientes; si no, solo los mensajes iniciales. Si termina mientras se mira, sigue suscrito hasta desmontar y consulta mientras queden pendientes.
- `LiveGameController` expone `boardVersion`, que solo se actualiza en `animationDone`. Es el único cambio en el controlador de la partida.
- Página: `Promise.all([loadGame, loadChatMessages])`, que pasa `messages` y `chatPending`.
- `realtime.ts`: `subscribeToChat` (canal `chat:<id>`, INSERT con filtro `game_id=eq.<id>`).
- `GET /api/games/[id]/messages`:
  - Sin `after`: los últimos 20. Con `?after=<entero ≥ 0>`: hasta 100 posteriores, con `hasMore`.
  - Siempre `pending`; si es `true`, programa el procesador (`scheduleDrain`).
  - Errores: 404 si el id no es UUID, 400 `invalid_query`, 503 `chat_unavailable` y 500 genérico.
  - Límite `read`, siempre `no-store`.

### SQL (`web/supabase/8.2a-chat.sql`) — **ejecutado y verificado en Supabase**

- Idempotente. **`games`:** sin cambios en sus columnas, sus políticas ni `games_guard`. Se **añade** el trigger `games_chat_enqueue` (decisión: **tolerante**).
  - **Compromiso elegido: la partida antes que el chat.** El INSERT va en un bloque `begin … exception when others then raise warning … end` que cubre **solo** ese INSERT (una subtransacción por versión, coste despreciable). Si falla (cola inexistente, permisos, restricciones u otro error de PostgreSQL), se deshace solo el INSERT, se emite `WARNING: chat: versión N de la partida <id> no encolada (<SQLSTATE>: <mensaje>); el avance continúa` en el registro de PostgreSQL, y la confirmación del avance sigue.
  - **Consecuencia:** **ese acontecimiento se pierde para el chat y no puede recuperarse mediante la cola** (`games` solo guarda los eventos de la última versión). El procesador admite huecos en la cola.
  - **No se ocultan otros errores:** `when others` no incluye la cancelación de la sentencia (`statement_timeout`, cancelación manual) ni los asserts, y los errores del resto del avance (`games_guard`, etc.) no pasan por ese bloque.
  - **Para desactivar el chat:** `drop trigger if exists games_chat_enqueue on public.games;`, recomendado antes de borrar la cola. Sin ella, la partida sigue, pero cada avance emitiría un `WARNING`.
- **`games_chat_enqueue()`:** `security definer`, `search_path = ''`. `AFTER UPDATE OF version ... WHEN (new.version > old.version)`. Inserta `(game_id, version, last_events, state, is_victory)` con `on conflict do nothing` (idempotente), dentro del bloque tolerante. `is_victory` = algún `player_finished` con `place = '1'`, comparado como texto.
- **`game_chat_queue`:** PK `(game_id, version)`, `events`, `state`, `is_victory`, `attempts`, `created_at`. FK con cascada. RLS sin políticas: sin acceso para anon/authenticated.
- **`game_messages`:**
  - Columnas: `id` identity (orden y cursor), `game_id` (FK con cascada), `version`, `seq`, `character_id` (`^ai-[a-z]+$`), `trigger` (lista cerrada), `reply_to_seq` (< `seq`), `text` (1–200), `source` (`local`/`llm`) y `created_at`.
  - `UNIQUE (game_id, version, seq)` e índice `(game_id, id)`.
  - RLS: lectura pública. Escritura solo `service_role`. En la publicación `supabase_realtime`.
  - **Lo que puede hacer la clave publicable** (anon/authenticated; B5, comprobado en las pruebas SQL; no se amplían permisos):
    - **Lee los mensajes de todas las partidas.** La política es `using (true)`, como la lectura pública de `games`: no exige filtrar por `game_id`, así que se pueden listar los de cualquier partida por la API REST o suscribirse por Realtime sin filtro.
    - Solo contienen texto de los personajes, versión, orden, disparador y fecha: ningún dato de usuarios (no los hay).
    - No puede escribir, modificar ni borrar mensajes, ni leer `game_chat` (reserva y estado del director) ni `game_chat_queue`, ni ejecutar `chat_claim`, `chat_commit` o `chat_release`.
    - Realtime publica solo `game_messages`.
- **`game_chat`:** `game_id` (PK, FK con cascada), `last_version` (cursor), `message_count`, `director_state`, `lock_token`, `locked_until`, `locked_through` (fin del lote reservado; restricción que exige los tres a la vez) y `updated_at`. Sin acceso para anon/authenticated. **No** está en Realtime.
- **Funciones** (`security invoker`, `search_path = ''`, `#variable_conflict use_column`, `execute` solo para `service_role`):
  - `chat_claim(game, token, lease, batch)`: si hay pendientes y no hay reserva vigente (las caducadas, con `clock_timestamp()`, se recuperan), reserva el lote `(last_version, locked_through]`. Suma 1 a `attempts` **solo de la primera** versión y devuelve una fila por versión con el estado del chat y `latest`.
  - `chat_commit(game, token, through, state, messages, max)`: exige el token de la reserva vigente y `last_version < through ≤ locked_through` (confirmación parcial si se detuvo en una versión que falló). Error si un mensaje está fuera de ese tramo o se supera el máximo. Inserta sin duplicar, borra la cola hasta `through`, avanza el cursor y libera. Devuelve `(inserted, has_more)` o ninguna fila.
  - `chat_release(game, token)`: el lote sigue pendiente.
- **Pruebas SQL:** `web/supabase/tests/` (`supabase-stub.sql`, `8.2a-chat.test.sql`, `8.2a-chat-commit-state.test.sql` y `run-chat-sql-tests.sh`; comando en "Comandos"). Usan un PostgreSQL 17 desechable en Docker y **no** tocan Supabase. Todas son automáticas (ya no quedan comprobaciones manuales, B7):
  - **Aplicación:** el SQL dos veces (inicial e idempotencia).
  - **43 comprobaciones SQL**, que abortan si fallan:
    - Encolado, victoria, rollback e idempotencia.
    - Fallos del INSERT sin revertir el avance y errores de la guarda no ocultados.
    - Lote con hueco, confirmación y ausencia de duplicados.
    - Límites de `chat_commit` (B1): token ajeno, `through` fuera del lote o ya procesado, mensaje fuera del tramo; sin cambios tras los rechazos.
    - Lote de 25 en orden con intentos solo en la primera.
    - Proceso muerto: reserva caducada recuperada, el muerto ya no confirma y `release`. Reserva de 30 s aceptada y con su caducidad.
    - Permisos de anon/authenticated (B5), publicación de Realtime y cascada.
  - **3 `WARNING`** esperados: 23514, 42P01 y 42501.
  - **17 comprobaciones de `chat_commit` sin mensajes** (`8.2a-chat-commit-state.test.sql`, archivo aparte, con su propia partida). Respaldan la continuidad del historial, porque una versión defectuosa se confirma sin mensajes:
    - con `p_messages = []`, guarda `director_state`, avanza el cursor, libera la reserva y vacía el lote;
    - la confirmación parcial guarda el estado con el cursor en `p_through`;
    - un token ajeno o un error a mitad (mensaje fuera del lote) no cambia ni el cursor ni el estado;
    - la confirmación válida posterior cambia los dos juntos.
  - **6 comprobaciones de concurrencia entre sesiones:**
    - Con una sesión reteniendo la reserva, la otra espera y no obtiene nada.
    - De 10 reservas simultáneas, gana 1.
    - Un avance de la partida se confirma sin esperar al chat (≈80 ms) aunque este confirme sobre la misma cola.
  - Cualquier error de `psql` o comprobación fallida termina con código distinto de cero.

### Aislamiento de errores y garantías

- **Garantías para las versiones que SÍ se encolan** (lo normal: el INSERT solo falla por errores de configuración o de PostgreSQL):
  - No se pierden: están en la cola desde la misma transacción que el avance.
  - Ninguna se procesa dos veces: reserva con token y lote, cursor, borrado en la misma transacción que los mensajes, y `UNIQUE`.
  - Las reservas abandonadas caducan.
  - Una versión defectuosa solo se bloquea a sí misma, como mucho 3 intentos.
  - La victoria siempre se procesa (si se encoló).
- **Si el encolado falla:** el avance continúa y ese acontecimiento (incluida una victoria) **se pierde sin recuperación**. Queda un `WARNING` en el registro de PostgreSQL. No se cumplen las dos garantías a la vez: se ha elegido que el chat nunca detenga la partida.
- **Dependen de que algo ponga en marcha el procesador:** un avance, un GET de mensajes o un navegador con la partida terminada. Si nadie mira la partida, las pendientes esperan en la cola (sin perderse) hasta que alguien la abra.
- El procesador corre después de la respuesta del avance. Sus fallos (BD, escritor) se registran sin datos sensibles y la partida sigue. Los fallos del encolado tampoco detienen la partida (trigger tolerante). En el navegador, el chat tiene su propio controlador.
- **Sin ejecutar el SQL**, la app funciona igual, sin mensajes (un aviso por minuto en el registro). `8.2a-chat.sql` va en una sola transacción: se aplica entero o nada.

### Límites conocidos

- La réplica se publica en la misma versión que su mensaje, así que la pausa global de 3 versiones separa intervenciones, no mensajes sueltos. **Decisión para aprobar.**
- **Carga:** cada versión confirmada escribe una fila en la cola (con su estado, de unos pocos KB), que se borra al procesarse. El procesador hace unas 2 llamadas RPC por versión candidata (unas 150 por partida); las demás se procesan en el mismo lote.
- **Medido en 30 partidas simuladas** (≈1000 versiones cada una), unos 37 mensajes por partida con las probabilidades actuales:
  - Capturas y rachas: ≈51 % del chat (antes 63 %), con más comentarios de meta y de ambiente.
  - Un personaje repite una frase 0,2 veces por partida de media (antes 4,6) y nunca más de 2 veces la misma.
  - Todos los números y "seguidas" de las rachas coinciden con las capturas reales.
  - Tres seises sin ficha devuelta: ninguno de sus mensajes menciona la casa.
- **Auditoría:** todos los puntos resueltos. M3: el SQL se ha ejecutado en Supabase y el chat se ha comprobado en producción (Vercel).

## Fase 8.2b: textos con LLM (Vercel AI Gateway) — implementado; probado en Preview, desactivado en Production

El LLM **solo escribe el texto** de algunas intervenciones; nunca decide movimientos, dados, turnos ni resultados (eso sigue en el motor y la IA heurística). El director, la cola, las reservas, el SQL y el navegador no cambian.

- **Modelo configurado:** `nvidia/nemotron-3.5-lightning-free`, el único en `CHAT_LLM.allowedModels` (`config.ts`).
- **Variables** (solo servidor, nunca con `NEXT_PUBLIC_`; plantilla en `web/.env.example`; en Vercel, Project Settings → Environment Variables):
  - `CHAT_LLM_ENABLED`: solo `true` lo activa; sin ella el LLM está desactivado. En Vercel solo tiene efecto en Preview (ver `readChatLlmConfig`).
  - `AI_GATEWAY_API_KEY`: clave de AI Gateway.
  - `CHAT_LLM_MODEL`: debe estar en la lista permitida.
  - `CHAT_LLM_PROVIDER` (opcional): fija el proveedor.
- **Qué escribe:** solo las intervenciones con `utterance.important`, es decir, victoria (mensaje y réplica), capturas, rachas y malas rachas, también sus réplicas (`createImportantOnlyWriter`). Tercer 6, meta, puesto final y ambiente siguen con las frases locales, sin llamar al modelo.
- **Elección de escritores** (`chatWriters(env)` en `schedule.ts`):
  - El escritor local es siempre la reserva (`fallbackWriter`).
  - Con la configuración válida, el principal envía lo importante al LLM y el resto al local.
  - Si no es válida, el principal es el propio escritor local. Un error de configuración se registra solo con su motivo, sin valores.
- **Sin dependencias:** `fetch` nativo contra la API compatible con OpenAI (`POST https://ai-gateway.vercel.sh/v1/chat/completions`, `Authorization: Bearer <AI_GATEWAY_API_KEY>`). Sin SDK ni streaming.
- `src/lib/chat/llm/env.ts` (puro, nunca lanza ni muestra valores): `readChatLlmConfig(env)`.
  - **Activo solo con `CHAT_LLM_ENABLED=true`**, `AI_GATEWAY_API_KEY` no vacía y `CHAT_LLM_MODEL` permitido; `CHAT_LLM_PROVIDER`, si se indica, debe ser un nombre de proveedor válido.
  - **Solo en Vercel Preview:** en Vercel (`VERCEL=1`) solo se activa con `VERCEL_ENV=preview` (comparación exacta). En Production, Development, cualquier otro valor o sin `VERCEL_ENV` (falla cerrado), queda desactivado con el motivo `not_preview` si se ha pedido activarlo (`CHAT_LLM_ENABLED=true`); sin pedirlo, sigue siendo `off`. Fuera de Vercel (sin `VERCEL=1`: desarrollo local y pruebas) no se aplica y funciona como antes. Ojo: `vercel env pull` escribe `VERCEL="1"` y `VERCEL_ENV="development"` en `.env.local`, lo que desactivaría el LLM en local.
  - Si no, queda desactivado con un motivo: `off`, `not_preview`, `missing_key`, `missing_model`, `model_not_allowed`, `invalid_provider` o `public_secret`. Este último salta si existe `NEXT_PUBLIC_AI_GATEWAY_API_KEY` o `NEXT_PUBLIC_CHAT_LLM_API_KEY`, aunque el LLM no esté activado.
  - Orden de las comprobaciones: `public_secret` → `off` → `not_preview` → clave → modelo → proveedor. `chatWriters` registra (sin valores) cualquier motivo salvo `off`.
- `src/lib/chat/llm/prompt.ts` (puro): `buildChatPrompt(request)`.
  - **Sistema:** corto y sin contradicciones. «Eres X. Juegas una partida de parchís con otros tres y comentas en voz alta lo que acaba de pasar, como una persona más sentada a la mesa», el carácter en una línea (`Tu carácter: ${chat.voice}`) y 6 reglas (7 para Don Ernesto) en positivo:
    - Una sola frase corta en español: como mucho 18 palabras y menos de 120 caracteres (`CHAT_LLM.promptMaxWords`/`promptMaxChars`), por debajo del límite de validación de 140. Sin saludos, explicaciones ni resumen de la jugada.
    - Hablar como se habla en España jugando al parchís en casa: español coloquial y natural, con palabras sencillas de la partida (ficha, dado, comer, casa, meta, seis, turno). Sin metáforas, comparaciones ni frases solemnes; no hace falta ser gracioso.
    - Reaccionar solo a lo que acaba de pasar; el carácter se nota en cómo se dice, no en muletillas fijas.
    - Primera persona; nombrar solo a quien habla y a su rival, siempre con el nombre completo; sin comillas, emojis ni su nombre delante. Si el rival es Abuela Pilar, también se la puede llamar «Abuela» (el validador lo admite cuando participa). A la propia Pilar no se le dice, porque su vocativo «abuela» a otro se rechaza.
    - **Concordancia de género** (`gender` de cada personaje): «Concuerda el género: habla de ti en femenino y de Chispa en masculino.»; sin rival (victoria propia), solo el de quien habla. No sugiere apelativos concretos. Antes el modelo lo adivinaba: Pilar llamaba «hijito» a Brava y «hijita» a Chispa (partida `010c5ace…`).
    - Solo Don Ernesto: tratar siempre de usted (usted, su, le), nunca tutear.
    - Contar solo lo que dice la situación: no inventar jugadas, cifras, posiciones ni rachas.
    - No repetir frases ni muletillas; puede picar o bromear, sin insultos ni comentarios sobre ser una IA.
    - **Sin ejemplos de lo prohibido:** el prompt no nombra juegos, deportes ni expresiones que el validador rechaza (nombrarlos se los sugería al modelo; los tres rechazos de la partida `84d066b1…` fueron de Chispa: dos por «racha» y uno por «fuera de juego»). Ya no lleva arquetipo, personalidad ni forma de hablar por separado, ni las coletillas literales.
    - **Caracteres** (`chat.voice`): Brava, competitiva, directa y desafiante, que pica, presume cuando le sale bien y protesta cuando le sale mal, sin pasarse ni insultar; Don Ernesto, estratega sereno, calculador y educado, siempre de usted, con algo de cálculo y probabilidad pero con naturalidad y sin tecnicismos; Abuela Pilar, prudente, cariñosa y paciente, algo tradicional, con algún refrán o diminutivo sin repetirlos ni abusar de ellos; Chispa, espontáneo, divertido e imprevisible, algo travieso y supersticioso con el dado, que reacciona con sorpresa y humor sin exagerar (ya no es «comentarista» ni «cree en las rachas»).
  - **Usuario:**
    - La situación del tipo de intervención, con el rival y la racha reales y los **papeles explícitos** en capturas y rachas: «Tú capturas y Y pierde la ficha: no te lamentes…» o «Tú pierdes la ficha y Y la captura: no presumas…». En la victoria ajena, «Y acaba de ganar la partida, no tú. La partida no ha terminado: los demás seguís jugando por los otros puestos.» (en la propia, «los demás siguen jugando por los otros puestos»).
    - En las réplicas, a quién responde: «Respondes a lo que acaba de decir Y: «…»» (el rival de una réplica es siempre quien dijo el mensaje; ver `director.ts`).
    - En las capturas (mensajes y réplicas), los hechos de `captures` desde quien habla (`captureContext`). Con el historial incompleto, nada de eso: «No sabes cuántas capturas lleva nadie ni si alguien está de racha: no des cifras ni hables de rachas.» (`INCOMPLETE_HISTORY`), y la situación del mensaje principal tampoco lleva su recuento. Con el historial completo, tras un reinicio distingue las capturas en poco tiempo de la racha: «Brava lleva cuatro capturas en poco tiempo, pero le capturaron entre medias: no está de racha, desde entonces lleva una.» (en su propio mensaje, sin repetir el recuento: «Pero te capturaron entre medias…»); igual con la mala racha. Además: rachas activas («Brava lleva tres capturas seguidas: su racha sigue.», «A Chispa le han capturado dos veces seguidas: su mala racha sigue.»), rachas recién interrumpidas («La racha de Brava (tres capturas) se acaba de cortar.», «Tu mala racha se acaba de cortar (te habían capturado dos veces).») y la pareja si son más de una («Brava te ha capturado dos veces seguidas.»). Sin rachas, nada sobre rachas. La racha propia del mensaje principal no se repite.
    - Los 2 últimos textos del propio personaje (`CHAT_LLM.ownRecentTexts`) y, sin repetirlos, los de los demás de entre los 3 últimos de la partida, recortados a 100 caracteres, para no repetirlos.
    - Termina con «Tu frase (una sola y corta):».
  - Nunca el estado de la partida ni identificadores internos.
  - **Tamaño:** como máximo `CHAT_LLM.maxPromptChars` (2800 caracteres, sistema + usuario). Con el prompt simplificado, el peor caso realista medido (réplica, historial completo de textos largos, textos propios y todas las reglas) es de 1752 caracteres, con Don Ernesto por su regla de usted; antes eran 2698. Con todos los hechos de captura a la vez (más de los que pueden coincidir, también los de reinicio), 2112. Con las reglas de estilo y Abuela Pilar como rival (nombre más largo y regla de «Abuela»), 2476. Son unos 600–700 tokens de entrada, con un modelo gratuito y `max_tokens: 60`. El límite de 2800 no cambia.
- `src/lib/chat/llm/gatewayWriter.ts`: `createGatewayWriter({ config, fetch, breaker, now?, onFailure? })`.
  - **Petición:** una por intervención, sin reintentos. Cuerpo: `model`, `messages`, `max_tokens: 60`, `temperature: 0.8`, `stream: false` y `reasoning_effort: "none"` (en la raíz del cuerpo).
    - `reasoning_effort: "none"` desactiva el razonamiento de Nemotron: sin él, gastaba los 60 tokens razonando y devolvía `content` vacío (`finish_reason=length`). `chat_template_kwargs.enable_thinking` no tuvo efecto a través de AI Gateway.
    - Sin `models`: AI Gateway no cambia a otro modelo.
    - Con `CHAT_LLM_PROVIDER`, `providerOptions.gateway.only`: tampoco cambia de proveedor.
    - La clave va solo en la cabecera.
  - **Cancelación:** `AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)])`, con `timeoutMs` acotado a 8 s. Respeta la cancelación del servicio y su propio plazo.
  - **Respuesta truncada:** si `finish_reason` es `length` y hay texto, se rechaza (`respuesta truncada`) sin llamar a `cleanLlmText`: la frase puede estar a medias. No se amplía `max_tokens`. Sin texto (`content` nulo o vacío), se sigue informando como `respuesta sin texto`.
  - **Respuesta:** `cleanLlmText` limpia el texto y exige, en este orden:
    - **Etiqueta** (`splitLabel`): al principio de la frase, el nombre completo **o un alias** de cualquier personaje del catálogo (`ALIASES` de `quality.ts`: «Ernesto», «Pilar»), como `Nombre:`, `Nombre —` (también `-` o `–`) o `(Nombre)` (con o sin dos puntos detrás), sin distinguir mayúsculas.
      - Si es de quien habla, se quita («Pilar: …», «Abuela Pilar — …», «(Pilar) …»).
      - Si es de otro personaje, también del rival, se rechaza (`habla como otro personaje`).
      - Solo cuentan nombres del catálogo: cualquier otra palabra seguida de dos puntos no es una etiqueta («Ojo: esa ficha…», «Lo dicho: …»), ni una palabra que solo empieza por un nombre («Pilares de la casa: …»). Etiquetas genéricas como «Respuesta:» no se tratan.
    - **Primera línea:** se usa la primera línea no vacía. Si es solo la etiqueta de quien habla, la frase es la línea siguiente, que pasa por las mismas comprobaciones (si es de otro personaje, se rechaza). Si la primera línea tiene texto, las demás se ignoran.
    - **Comillas exteriores:** se quitan solo si envuelven todo el texto y están emparejadas (`"…"`, `«…»`, `“…”`, `'…'`, `‘…’`, y `"…”`), nunca un extremo suelto. La etiqueta y las comillas se resuelven en dos pasadas, en cualquier orden («Pilar: "…"» o «"Pilar: …"»).
    - Que quede texto (`texto vacío`): una etiqueta sola, «Pilar: ""» o una etiqueta seguida de líneas en blanco se rechazan.
    - **Comillas equilibradas** (`comillas descompensadas`): número par de `"` y de `'`, y tantas de apertura como de cierre en `“”`, `«»` y `‘’`. Así nunca se publica una comilla sobrante. Las comillas equilibradas dentro de la frase se conservan («Ay, «Chispa», a casita.»). Un apóstrofo suelto («Pa’ casa») también se rechaza y se usa la frase local.
    - Como mucho 140 caracteres (si es más larga, se rechaza; no se corta).
    - Sin URL ni formato.
    - Solo los nombres de quien habla y su rival, como palabra completa (límites Unicode: «bravata» o «chispazo» no cuentan), y tampoco los alias de los demás (ver `quality.ts`).
    - Que pase `validateChatText` (repeticiones).
    - Que pase las comprobaciones de calidad de `quality.ts` (`checkQuality`). Van después de todas las anteriores, que no cambian.
    - Los nombres, la repetición (`validateChatText`) y las reglas de calidad se comprueban siempre sobre el texto **ya limpio**, así que una etiqueta no permite eludir la detección de coletillas (que mira el inicio de la frase: «Ernesto: Previsible» se rechaza igual que «Previsible» si ya la publicó) ni de textos repetidos.
    - **Regresión de la partida `1130dc37…` (v382):** se publicó `Pilar: "Qué pena, Chispa; ya tenía la tuya en casa.`. «Pilar» (alias) no se reconocía como prefijo, y la limpieza quitaba las comillas de cada extremo por separado: se conservaba la de apertura (detrás de «Pilar: ») y se quitaba la de cierre. Ahora se publica `Qué pena, Chispa; ya tenía la tuya en casa.`, y la variante sin la comilla de cierre se rechaza.
  - **Cualquier problema lanza `ChatLlmError`** (`cooldown`, `http` con `status`, `network`, `aborted` o `invalid_response`), y el servicio usa la frase local.
  - **Corte temporal**, en memoria del proceso y compartido (`createLlmBreaker`); mientras dura, falla al instante sin llamar:
    - 401, 402, 403 y 404: 10 min.
    - 429: `Retry-After` en segundos si es válido (máximo 1 h); si no, 60 s.
    - 5xx: 30 s.
    - 400, red y abortos: sin corte.
  - **Registro:** `onFailure` → `logChatError("escritor LLM")`, como mucho una vez por minuto por tipo (y, en `invalid_response`, por motivo). Nunca la clave, la cabecera `Authorization`, el prompt, el texto del modelo ni su razonamiento. Incluye:
    - El tipo y el código HTTP.
    - En `invalid_response`, el motivo del rechazo (solo uno de los textos fijos de `INVALID_RESPONSE_REASONS`, que incluye `comillas descompensadas` y `respuesta truncada`) y un resumen estructural saneado de la respuesta (`describeCompletion`): `finish_reason`, tipo y longitud de `content`, líneas, razonamiento presente y su longitud, `usage` y `model`. Si nombra a un personaje ajeno, también el nombre del catálogo y la coincidencia: la forma, si es el nombre completo, o `alias:<alias>`. En las reglas de calidad, `termino=<término de la lista>`.
    - En errores HTTP, un resumen saneado (`describeHttpError`, cuerpo leído como mucho 2 KB): `content-type`, `x-vercel-id` y `error.type`/`code`/`message`, con la clave, `Bearer …` y las cadenas con aspecto de token enmascaradas.
- `src/lib/chat/llm/quality.ts` (puro): comprobaciones de calidad, a partir de los problemas de la partida de Preview `707c3c6d…`. Cada una devuelve un motivo fijo (`QUALITY_REASONS`, incluidos en `INVALID_RESPONSE_REASONS`) y el término de su propia lista que coincidió, nunca el texto del modelo.
  - **Idioma** (`idioma no permitido`): una expresión inglesa inequívoca («who laughs last», «game over», «let's go»…), una contracción («it's», «don't»…) o dos palabras inglesas distintas de una lista sin ambigüedades. Una palabra suelta como «game» no basta.
  - **Alias:** «Ernesto» es Don Ernesto y «Pilar» es Abuela Pilar. «abuela» solo cuenta como Abuela Pilar cuando el contexto la identifica («la abuela», «¡Abuela!», «abuela,»), no en usos genéricos («mi abuela», «una abuela», «como abuela»). Un alias de quien no participa se rechaza como `nombra a un personaje ajeno a la intervención`.
  - **Nombres cruzados** (`mezcla nombres de personajes`): un tratamiento delante del nombre de otro personaje («la abuela Brava», «don Chispa», «doña Brava»), aunque los dos participen.
  - **Usted** (`tutea (Don Ernesto)`): solo si habla Don Ernesto, marcas de tuteo como palabra completa (tú, tu, te, ti, contigo, eres, estás, tienes, has, vas…), distinguiendo tildes («estas fichas» no es tuteo). Se ignoran las citas entre comillas y lo que sigue a «dice:».
  - **Coletillas** (`expresión característica repetida`): una expresión característica que **empieza una frase**, aunque siga con más palabras («¡A casa!», «¡A casa, Chispa!» y «¡A casa con eso!» son la misma; «Vuelve a casa», no), solo se rechaza si ese mismo personaje ya la ha publicado en **la partida** (registro `usedCatchphrases`) o la tiene en sus textos recientes. Si la dijo otro, no cuenta. La detección es la de `catchphrases.ts`, compartida con el director y el escritor local; entre las palabras de una coletilla admite cualquier separador («Ay, hijo, qué prisas» lleva comas y antes nunca se detectaba).
  - **Tercera persona propia** (`habla de sí mismo en tercera persona`): solo con el nombre o alias de **quien habla**, nunca con los de los rivales.
    - Con artículo o contracción («la Chispa», «al Ernesto», «la Pilar», «la Abuela Pilar»).
    - Su nombre seguido de un verbo en tercera persona, de una lista cerrada («Chispa ha caído», «Brava nunca falla», «Don Ernesto nunca se equivoca»).
    - Narración de su propia frase: un verbo de habla de una lista cerrada (dijo, dice, comenta, responde, contesta, exclama, añade, murmura, grita, suspira, replica…) delante o detrás de su nombre o alias («…, dijo Pilar», «dice Abuela Pilar», «exclamó Chispa», «Brava dijo: …»). Término `narración+<nombre>`. La narración de otro personaje («Ya lo dijo Chispa», dicho por Pilar) o sin nombre («Como dice mi nieto») se acepta.
    - Se permiten «¡Gol de Chispa!» y «Soy Brava». Excepción: Pilar puede llamarse «la abuela», que es parte de su personaje y lo usan sus frases locales («La abuela también sabe»).
  - **Ajeno al parchís** (`expresión ajena al parchís`):
    - Reglas o situaciones de otros juegos (`OTHER_GAMES`), prohibidas para todos: tres en raya, jaque mate (antes que «jaque», para informar del término más específico), jaque, ajedrez, fuera de juego, penalti, tarjeta roja, naipes, ruleta, bingo, la oca…
    - Metáforas deportivas de comentarista (`SPORTS_METAPHORS`: gol, golazo, por la escuadra, triple, canasta, fútbol, baloncesto, tenis): **solo las puede usar Chispa** (`COMMENTATOR`). Es solo un permiso del validador, que no se debilita: el prompt ya no las sugiere a nadie y las frases locales de Chispa ya no las usan.
  - **Afirmaciones sin respaldo** (`afirmación no respaldada`):
    - «racha(s)» solo si el disparador es `capture_streak` o `bad_streak` (también en la réplica dentro de una racha). «seguidas/os» y «consecutivas/os» exigen además una racha consecutiva respaldada (ver «Cifras de capturas»).
    - Eliminación («estás fuera», «eliminada»), posición («voy ganando», «vas el último», «a punto de ganar»).
    - El resultado («he ganado», «ha perdido la partida») solo en la victoria.
    - Se aceptan las expresiones de competición («Voy a por ti», «Esta partida es mía») y los hechos de la captura («Has perdido una ficha»).
    - **Cifras de capturas** (`checkCountClaims`), frase a frase (hasta `.`, `!`, `?`, `;`, `:` o `…`), comparadas con el recuento real `utterance.streak.count`:
      - **Qué cuenta como cifra:**
        - Un número en cifra o palabra (hasta cincuenta: dieciséis, veintidós, treinta…, y «un par de») seguido de «captura(s)», «veces», «vez», «seguidas/os» o «consecutivas/os».
        - «N fichas» (también «N de mis fichas») solo si las rige un verbo de captura de la frase («me has comido tres fichas», «me has mandado tres fichas a casa»); «dos fichas en casa» o «llevo dos fichas en la meta» no son cifras.
        - Cifras sin sustantivo tras «van», «llevo», «llevas», «lleva», «son»…, al final o antes de una coma, «y», «ya» o un ritmo («¡Ya van tres!», «Ya llevo dos en poco tiempo»): se validan contra su sujeto o, sin él, contra la racha que provocó la intervención; si no hay ninguna, no son un hecho y se rechazan. Con un sustantivo detrás («llevo dos fichas en la meta», «ya son las tres»), no cuentan.
        - Con «capturas» se admite una palabra intercalada («tres buenas capturas»), salvo que sea de tiempo o turno (turnos, tiradas, rondas, jugadas…) o que «capturas» lleve complemento («capturas otra», «capturas mi ficha»): entonces es el verbo, no una cifra.
        - «doble captura» (2) y «triple captura» (3).
        - Ordinales en palabra o en cifra con sufijo, seguidos de «captura» o «vez»: «la tercera captura», «por segunda vez», «2ª captura», «3º captura», «3er captura». Las cifras sin sufijo pegado («2 a casa», «de 1 a 3 casillas», «3 o 4») no son ordinales.
      - **«veces» y «vez» solo cuentan si la misma frase tiene una señal de captura** (palabras completas): formas de capturar, pillar o cazar, «comido(s)», «a casa», «en poco tiempo», «racha(s)», «seguidas/os» o «consecutivas/os». Así, «Me has pillado dos veces» o «Por segunda vez me pillas» son cifras, y «Piénsalo dos veces» o «Te lo he dicho dos veces» no.
      - **«una vez» y «la primera vez» son recuentos** y se validan como los demás («me has capturado una vez», «es la primera vez que me pillas», «te he capturado una vez»): con 0 o 3 capturas de esa pareja, se rechazan; sin datos, también. Solo quedan fuera las expresiones hechas «una vez más», «de una vez», «por una vez», «una vez que», «otra vez» y «alguna vez».
      - **«una captura» / «una ficha»** (artículo indefinido) se admite solo como la captura de esta versión: sin sujeto, o con el sujeto que le corresponde (quien captura la hace, quien la recibe la recibe). Con el papel cambiado («te he comido una ficha» dicho por la víctima) se valida y se rechaza. En la victoria, no. Los ordinales («la primera captura», «mi tercera captura») son recuentos.
      - **Atribución (P4):** cada cifra se compara con el recuento **al que se refiere**, con su sujeto y su dirección (`captures`, también en las réplicas). La señal gramatical más cercana a la cifra lo decide:
        - «desde entonces llevas una», «desde entonces te han capturado una vez» → el tramo vivo (`madeSinceBreak`, `receivedSinceBreak`);
        - «me has capturado / me pillas» → del rival a quien habla; «te he capturado / te pillo / capturo a» (y «le/la/lo he…») → de quien habla al rival;
        - «llevo», «he capturado», «mis capturas» → hechas por quien habla; «llevas», «lleva», «has capturado», «tus/sus capturas» → hechas por el rival;
        - «me han capturado» → recibidas por quien habla; «te/le han capturado» → recibidas por el rival;
        - «mi/tu/su racha», «mi/tu/su mala racha» → esa racha (también recién interrumpida).
        - **Sin sujeto** («¡Tres capturas ya!»): la racha que provocó la intervención (en `capture_streak`, la de quien captura; en `bad_streak`, la mala racha de quien recibe). En una captura simple no hay ninguna.
        - **El recuento global de una racha nunca respalda una cifra de pareja**: «Brava, me has capturado tres veces» con tres capturas de Brava, pero una a Chispa, se rechaza (`cifra 3 (real 1, del rival a quien habla)`).
        - Si ese recuento no existe en la intervención (victoria, datos antiguos), la cifra no es verificable y se rechaza (`cifra N (sin datos, …)` o `cifra N (real sin racha)`).
      - **«seguidas/os» y «consecutivas/os»,** con cifra o sin ella, exigen que **ese mismo recuento** sea de capturas consecutivas. Diagnóstico: `seguidas (real en poco tiempo)` o `seguidas (sin racha)` sin sujeto, y `seguidas (no seguidas, …)` o `seguidas (sin datos, …)` con sujeto.
      - Vale igual para las rachas y las malas rachas (veces que le han capturado).
      - No cuentan las expresiones hechas con «vez», «a veces», «mil veces» ni las cifras de otras cosas («cinco casillas», «dos fichas en casa», «un 5»).
      - **Límites asumidos:**
        - Una cifra con «veces» sin señal de captura en la frase («Ay, tres veces ya») o un número suelto sin verbo («Tres en poco tiempo y aún tengo hambre») no se comprueba.
        - La atribución es por señales gramaticales cercanas: una frase enrevesada puede atribuirse al recuento equivocado (y entonces se rechaza si no coincide).
        - Las cifras se comparan con el historial observado, y solo si es completo (ver «Continuidad del historial» en el director).
      - **Historial incompleto:** solo es un hecho la captura de esta versión («una captura más», «te he comido una ficha» dicho por quien captura). Cualquier otra cifra («una vez», ordinales, fichas, cifras sin sustantivo), «seguidas» y cualquier mención de una racha (continuidad, fin, mención, deseo o pregunta) se rechazan con los términos `cifra N (historial incompleto)`, `seguidas (historial incompleto)` y `racha (historial incompleto)`. También se ignora el `streak` del mensaje principal si llegara.
        - Una cifra sobre el futuro («Dos capturas más y gano») se trata como afirmación.
  - **Género del destinatario** (`no concuerda el género del destinatario`, motivo nuevo): un apelativo con género en vocativo se dirige a la otra parte de la intervención (el rival; en una réplica, quien dijo el mensaje) y debe tener su género (`gender`). Término `<apelativo> (<nombre>: femenino|masculino)`.
    - Apelativos (lista cerrada): hijo/hija, hijito/hijita, niño/niña, niñito/niñita, guapo/guapa, majo/maja, chiquillo/chiquilla, querido/querida, chaval/chavala, campeón/campeona, rey/reina; también con «mi» delante o «mío/mía» detrás.
    - Vocativo: al principio, tras un signo o tras una interjección («ay», «oye», «mira», «venga», «anda», «uy», «hala»), y seguido de un signo o del final.
    - No cuentan los plurales («hijos»), los neutros («cariño», «cielo», «tesoro»), los adjetivos frecuentes («bonito», «pequeño») ni los usos que no son vocativos («te ha querido», «una hija de la suerte»). Sin rival (victoria propia) no se comprueba: no hay destinatario con el que comparar («Ay, hijo, qué partida más larga» es ahí una interjección).
    - Límites: los adjetivos fuera del vocativo («estás muy confiada, Chispa») solo los frena el prompt; «Ay, hijo, qué prisas» (coletilla de Pilar) dicha a Brava se rechaza como vocativo masculino.
  - **Final de la partida** (`afirmación no respaldada`, término `fin de la partida`): con el **estado real** en juego (`gameStatus: "playing"`), no se puede decir que la partida ha terminado («la partida ha terminado», «se acabó la partida», «se terminó la partida», «esta partida ya terminó», «partida acabada», «fin de la partida», «juego terminado»…). La victoria es del primero en llegar y los demás siguen por los otros puestos (réplica de Brava en la v745 de `010c5ace…`: «No esperaba la partida terminada así», con la partida aún en juego en la v928).
    - Se aceptan la victoria individual («¡He ganado la partida!», «la partida es mía»), las jugadas, movimientos, turnos o fichas terminados, la negación («la partida no ha terminado», «todavía no se ha acabado») y el final para uno mismo («se acabó la partida para mí»). Solo cuentan «partida» y «juego».
    - El estado lo pasa el servicio: `processItem` (`service.ts`) añade a la petición `gameStatus` (`state.status` de la cola, validado con Zod; campo opcional de `ChatWriteRequest`). Sin estado válido (victoria en modo mínimo) no se envía, y con la partida terminada de verdad (`finished`) no se comprueba: no se concluye nada sin datos.
  - **Longitud** (`demasiadas frases`): como mucho dos frases (`countSentences`). Cuenta los cierres (`.`, `!`, `?`, `…`) seguidos de otra frase que empieza en mayúscula o con `¡`/`¿`. No cortan frase los puntos suspensivos seguidos de minúscula ni las abreviaturas («Sra.», «Dña.», «etc.»…).
  - **«Don» truncado** (`mezcla nombres de personajes`, término `don`): «Don» o «Dón» con mayúscula usado como nombre, sin «Ernesto» detrás («¡Dón, te vas a quedar…!»). No cuentan «Don Ernesto» ni el nombre común («un don», «qué don»).
  - **Pilar llamando «abuela» a otro** (`mezcla nombres de personajes`, término `abuela (vocativo)`): solo si habla Pilar y usa «abuela» como vocativo («…, abuela.», «Abuela, …», «¡Ay, abuela!»). «la abuela», «esta abuela» o «mi abuela» siguen permitidas.
  - **Rachas: fin, continuidad y mención** (`checkStreakEnd`, `afirmación no respaldada`; P4), contra el estado real de `captures`:
    - **Fin** (término `fin de racha`): «se acabó tu racha», «se te acabó la racha», «tu racha se ha terminado», «ha llegado a su fin», «fin de su racha», «adiós a tu racha»… Solo si esa racha **se acaba de interrumpir** (`ended`); si sigue o no existe, se rechaza. Sin hechos de captura no es verificable: se rechaza.
    - **Continuidad** (término `racha que sigue`): «tu racha sigue», «mi racha no se acaba», «no se acabó tu racha». Solo si está activa.
    - **Mención** (término `racha`): «mi racha», «tu mala racha», «¡Vaya racha!». Solo si esa racha existe (activa o recién interrumpida). Además, `checkGameTalk` admite «racha» y «seguidas» solo en los disparadores de racha o con alguna racha en los hechos (antes, solo en los disparadores).
    - **Dueño y tipo:** «mi»/«me» es quien habla; «tu», «su», «te», «le», el rival; sin dueño, cualquiera de los dos. «mala racha», «racha mala/negra/adversa/de mala suerte» es la mala racha; si no, la racha de capturas (una mención sin dueño ni «mala», cualquiera).
    - **Hipótesis por cláusula** (`clauseAround`, `inQuestion`): un deseo o una hipótesis («ojalá», «a ver si», «si», «cuando», «hasta que», «quizá», «tal vez», «puede que») solo cuenta en la **misma cláusula** que la mención y su verbo (delante o detrás); las comas, paréntesis, rayas y «pero», «aunque», «y», «o», «mientras», «porque», «pues» separan cláusulas.
      - Afirman (y se validan): «Si quieres, se acabó tu racha», «Quizá mañana gane, pero se acabó tu racha», «Si me preguntas, tu racha ya se acabó», «Si, se acabó tu racha» (con coma, como «sí»), «Se te acaba la racha», «Se acabó tu racha, ¿verdad?».
      - No afirman: «Si se acaba tu racha, lo celebraré», «Tu racha se acaba si te pillo», «A ver si se acaba tu racha», «¿Se te ha acabado la racha?» (pregunta: tras un «¿» sin cerrar, o una frase que acaba en «?» sin «¿»). Los subjuntivos y futuros («ojalá se acabe», «puede que se haya terminado», «se acabará») no coinciden con los verbos de fin.
      - Las negaciones son continuidad: «Tu racha no se ha terminado», «No se te acaba la racha».
  - Ninguna frase local de capturas, rachas y victoria de los cuatro personajes incumple estas reglas: 644 frases ya rellenadas, con todos sus rivales y rachas de 2 y 3, consecutivas o no.
- **Reserva local garantizada** (sin cambios en el servicio ni en las reservas):
  - El servicio aplica su tiempo máximo (≤ 8 s y respetando el margen de 3 s) y su `AbortSignal`.
  - Si el escritor LLM lanza un error o agota el tiempo, se usa el escritor local una sola vez.
  - La victoria en modo mínimo, y cuando todas sus frases "se repiten", va directamente al local.
- **Comprobado con pruebas automáticas** (LLM simulado, sin llamar a la API real):
  - Con un LLM simulado que falla (402, 500, red o respuesta inválida), que se cuelga o que está caído, cada mensaje se publica con la frase local.
  - La cola se vacía y la reserva se libera; si se cuelga, el aborto llega dentro del margen.
  - En partidas completas con un LLM inestable: victoria siempre, sin duplicados, LLM solo en lo importante y exactamente una petición HTTP por texto pedido.
  - El navegador no recibe la URL, la clave ni el modelo (comprobado en `.next/static` tras el build).
- **Pruebas reales en Preview** (con `CHAT_LLM_ENABLED`, la clave, el modelo y `CHAT_LLM_PROVIDER=nvidia` configurados solo en Preview):
  - Un 403 inicial de AI Gateway quedó resuelto.
  - Nemotron gastaba los 60 tokens razonando (`finish_reason=length`, `reasoning_tokens=60`, `content` vacío); con `reasoning_effort: "none"` genera texto sin razonamiento.
  - En Supabase, 7 de 12 mensajes de una partida se guardaron con `source = 'llm'` y el resto con la frase local.
  - Rechazos vistos en los registros: `texto demasiado largo` (de ahí el prompt de una sola frase de menos de 120 caracteres) y `nombra a un personaje ajeno a la intervención` (de ahí la búsqueda de nombres como palabra completa).
  - Partida `707c3c6d-98c4-4069-9f32-ea2b4aaea4a1`: 25 mensajes, 11 del LLM (todos en capturas y rachas) y 14 locales.
    - Un `LLM aborted` a las 17:05:19 fue el tiempo máximo de 8 s de la llamada; la réplica se publicó una vez con la frase local.
    - Problemas del LLM: una frase en inglés, «la abuela Brava», «racha» en una captura simple, Don Ernesto tuteando, coletillas copiadas, «tres en raya» y «ya casi estás fuera». De ahí las reglas del prompt y de `quality.ts`.
  - **Pendiente de comprobar en Preview:** el prompt corto y las reglas de calidad.
- **Antes de activarlo en producción (manual):**
  1. Verificar que Upstash funciona en producción (ver "Seguridad"). Sin límite de creación de partidas, cualquiera podría crear y hacer avanzar partidas y consumir llamadas.
  2. En AI Gateway: un presupuesto (Budget) para el proyecto o la clave (al superarlo, 402 → frase local) y la recarga automática desactivada.
  3. Comprobar en el panel que `nvidia/nemotron-3.5-lightning-free` está en el plan gratuito y anotar su proveedor si se quiere fijar con `CHAT_LLM_PROVIDER`.
  4. Configurar las variables en Vercel y, cuando se decida activarlo, `CHAT_LLM_ENABLED=true` en el entorno Preview (en Production el código no lo activa: `not_preview`).
  5. Probar primero en un despliegue de prueba: mensajes con `source = 'llm'` en `game_messages`, registros `[chat] escritor LLM` y el consumo en el panel de AI Gateway.
- **Límites conocidos:**
  - La comprobación de nombres puede rechazar frases válidas que usen «brava» o «chispa» como palabra suelta, o «la abuela» en sentido genérico cuando Abuela Pilar no participa (entonces se usa la frase local).
  - Las contradicciones de papeles (quién captura y quién pierde) solo se mitigan con el prompt; las reglas detectan los casos con marcas claras («racha», nombres cruzados).
  - Las listas de inglés, otros juegos y afirmaciones son cerradas: no cubren todas las variantes.
  - Las coletillas se recuerdan durante toda la partida (registro `usedCatchphrases`), pero solo las del catálogo (3 por personaje). Muletillas nuevas que invente el modelo solo las frena la similitud con los 12 textos recientes.
  - Cada respuesta rechazada consume su llamada y se sustituye por la frase local; conviene vigilar en Preview la proporción `llm`/`local`.
  - No se puede validar que el modelo no invente algún dato; lo limitan el prompt y la comprobación.
  - Cada proceso de Vercel tiene su propio corte temporal.
  - La documentación de AI Gateway no aclara si cancelar una petición evita su cobro (con `max_tokens: 60`, el coste es mínimo).

## Selector estratégico con LLM (fase 8.3) — F1 a F5 hechas; desactivado salvo en Vercel Preview con Upstash, y sin probar contra AI Gateway real

Objetivo: que cada personaje pueda elegir con el LLM qué ficha mueve cuando tiene varias opciones legales. El motor sigue siendo la única autoridad: el LLM solo elige un identificador de una lista cerrada, y si falla se usará la estrategia local (`chooseMove`). **Hechas F1 (módulos puros), F2 (cliente de AI Gateway propio), F3 (integración en `advanceGame` y en la ruta de avance) y F4 (cupo de 20 consultas por partida en Upstash).** El motor, `ai.ts` (`decideAction`/`chooseMove`), las reglas, el chat y su configuración no cambian. Sin `MOVES_LLM_*` configuradas (como ahora en todos los entornos) no se crea el selector y todo funciona exactamente como antes.
- **Pendiente (F6):** añadir las variables en Vercel (solo Preview; F5 las ha documentado, pero no se han configurado: en este entorno no hay CLI de Vercel ni proyecto enlazado); la prueba real contra AI Gateway y Upstash en Preview (latencia, proporción LLM/local, formato real de Nemotron, registros `[move-llm]` y el contador `parchis:rl:preview:moves-llm:<id>`); y revisar si los límites de avance (`advanceGame`/`advanceIp`, abiertos si falla Upstash) deben cerrarse con el LLM activo.

- **Decisiones acordadas:** sin la recomendación de la estrategia local en el prompt; timeout de 3 s; como mucho 20 llamadas por partida con un contador persistente en Upstash (F4); sin saltar llamadas por ventaja local clara en la primera versión; la respuesta solo lleva `choice`.
- `src/lib/game/moveSelector/options.ts` (puro): `buildMoveDecision(state)`, `simulateOption(state, pieceIndex)` y `pieceForOption(decision, id)`.
  - **Origen de las opciones:** solo `getAvailableMoves(state)`, que ya aplica las obligaciones del 5 y del 6 y usa el bonus pendiente si lo hay (`getMoveDistance`). Cada opción se **simula con `applyAction`**; si el motor la rechazara, no se ofrece. Nunca se incluyen opciones ilegales.
  - **Hechos de cada opción** (`MoveFacts`), todos de la simulación o de funciones del motor: desde y hasta (casa, recorrido con sus casillas de 0 a 63, pasillo 1–7, meta), avance, sale de casa, captura (con el jugador capturado, de `piece_captured`), llega a la meta, entra en el pasillo, casilla segura (`isSafeCell`), forma o rompe una barrera propia (`getBlockades` antes y después), bonus ganado (`bonus_granted`: +20 o +10; si el motor lo pierde, `bonus_lost`, no se anuncia) y repite tirada (`roll_again`).
  - **Amenazas y presas** (estimaciones, no certezas; `null` si la ficha no queda en el recorrido común):
    - Amenazas: fichas de los rivales que siguen jugando que **podrían** capturar la ficha movida en su próxima tirada. Para cada rival y cada valor del dado (1–6), se simula su jugada con el motor en un estado hipotético con su turno y ese dado, sin bonus pendiente ni seises acumulados (`capturersOf`).
    - Presas: fichas rivales que esa ficha **podría** capturar en la siguiente tirada de quien mueve, simulada igual.
    - **Límites:** solo la tirada siguiente con un dado de 1 a 6; no tienen en cuenta los bonus encadenados (por ejemplo, el +20 de una captura que se juega antes de que tiren los rivales), el orden real de los turnos, los tres seises ni las fichas propias que quedan expuestas al moverse otra (por ejemplo, la compañera de una barrera que se rompe). Cuestan unos 15 ms por decisión.
  - **Obligaciones:** si alguna ficha que el motor dejaría mover por sí sola (`canMovePiece`) no está entre las legales y todas las opciones salen de casa, la obligación es «sacar ficha de casa»; si todas abren una barrera propia, «abrir una barrera propia».
  - **Identificadores y fichas:** las opciones se identifican con `A`–`D`, en orden de ficha. La correspondencia con `pieceIndex` vive solo en la `MoveDecision` del servidor: el prompt envía los identificadores y los hechos, nunca la ficha. `pieceForOption` traduce un identificador exacto (sin cambiar mayúsculas) o devuelve `null`.
  - Sin decisión (`null`): partida terminada, sin dado ni bonus o sin movimientos legales. Con una sola opción, la decisión tiene una opción (la integración no llamará al LLM en ese caso).
- `src/lib/game/moveSelector/prompt.ts` (puro): `buildMovePrompt(state, decision)` (sistema y usuario) y `describeStrategy(strategy)`.
  - Personaje que decide, su título («la agresiva», «el estratega», «la prudente», «el imprevisible») y su perfil **generado a partir de sus multiplicadores reales** («Te importa mucho…», «bastante», «poco», «No te importa…»); con azar, «De vez en cuando eliges una jugada distinta de la más evidente» (solo Chispa). Perfil neutro: «Juegas equilibrado».
  - Estado (JSON): qué se juega (dado o bonus con su motivo), la obligación, el progreso de cada jugador (`getPlayerSummaries`: fichas por zona, progreso y puesto) y las opciones con sus hechos.
  - Explica que amenazas y presas son posibilidades («podrían») y que capturas, meta, barreras y bonus son lo que produce ese movimiento.
  - **Nunca** la recomendación ni la puntuación de `chooseMove`/`scoreMove`, ni `pieceIndex`.
  - Pide responder solo con el formato `{"choice":"<identificador>"}`, con un marcador y nunca con un identificador real: el ejemplo anterior (`por ejemplo {"choice":"A"}`, siempre el primero) podía inclinar al modelo hacia la opción A (**corregido**). Sin texto ni Markdown.
- `src/lib/game/moveSelector/parse.ts` (puro): `parseMoveChoice({ content, finishReason }, decision)` → `{ ok: true, id, pieceIndex }` o `{ ok: false, reason }`.
  - **Contrato estricto, sin reparar ni adivinar:** `finishReason: "length"` → `respuesta truncada` (aunque el texto parezca válido); contenido que no es texto o vacío → `respuesta sin texto`; sin los espacios de los extremos, debe empezar por `{` y terminar por `}` (texto alrededor, Markdown o arrays → `no es solo un objeto JSON`); `JSON.parse` (→ `JSON inválido`); sin claves repetidas en el objeto exterior (→ `clave duplicada`); `z.strictObject({ choice: z.string() })` (claves de más o tipos incorrectos → `formato no válido`); y `choice` debe ser exactamente uno de los identificadores enviados (minúsculas, espacios o el `pieceIndex` → `opción inexistente`). Motivos fijos (`MOVE_PARSE_REASONS`), sin el contenido del modelo.
  - **Claves duplicadas (corregido):** `JSON.parse` se queda con el último valor de una clave repetida sin avisar (antes, `{"choice":"A","choice":"B"}` se aceptaba como B). `topLevelKeys` recorre el texto ya validado respetando las cadenas y sus escapes, y toma solo las claves del objeto exterior, decodificadas (`"\u0063hoice"` es `choice`). Si alguna se repite, con el mismo valor o con otro, se rechaza con `clave duplicada`. «choice» como valor o en un objeto anidado no cuenta.
  - Las secuencias de escape del valor (`"\u0042"` = `B`) se aceptan como el identificador que representan.
- **F2 · cliente de AI Gateway para movimientos**, independiente del chat (sin tocar `CHAT_LLM`, `readChatLlmConfig`, `createGatewayWriter`, su corte temporal ni su registro):
  - `src/lib/game/moveSelector/config.ts`: `MOVES_LLM`. Mismo endpoint de AI Gateway; el único modelo, `nvidia/nemotron-3.5-lightning-free` (identificador exacto); 3 s como máximo; `max_tokens: 20`; `temperature: 0.3`; cortes temporales con los mismos valores que el chat (401–404: 10 min; 429: `Retry-After` hasta 1 h, o 60 s; 5xx: 30 s).
  - `src/lib/game/moveSelector/env.ts` (puro, nunca lanza ni muestra valores): `readMoveLlmConfig(env)`. Variables propias: `MOVES_LLM_ENABLED` (solo `true`), `MOVES_LLM_MODEL` (debe ser exactamente el modelo acordado), `MOVES_LLM_PROVIDER` (opcional), y la misma `AI_GATEWAY_API_KEY` que el chat. **Solo en Vercel Preview** (`VERCEL=1` y `VERCEL_ENV=preview`, comparación exacta): en Production, Development, otro valor, sin `VERCEL_ENV` **o fuera de Vercel** (a diferencia del chat, tampoco en local) queda desactivado con `not_preview`. Motivos: `off`, `not_preview`, `missing_key`, `missing_model`, `model_not_allowed`, `invalid_provider` y `public_secret` (si existe `NEXT_PUBLIC_AI_GATEWAY_API_KEY` o `NEXT_PUBLIC_MOVES_LLM_API_KEY`, aunque no esté activado). Activar el chat no activa los movimientos ni al revés.
  - `src/lib/game/moveSelector/gateway.ts` (`server-only`): `createMoveSelector({ config, fetch, breaker, now?, timeoutMs?, onFailure? }).select(state, decision, { signal? })` → `{ ok: true, id, pieceIndex }` o `{ ok: false, error: MoveLlmError }`. **Nunca lanza.**
    - Una petición por decisión, **sin reintentos**: `model`, `messages` (`buildMovePrompt`), `max_tokens`, `temperature`, `stream: false`, `reasoning_effort: "none"` y, con proveedor, `providerOptions.gateway.only`. Sin `models` (AI Gateway no cambia de modelo). La clave va solo en la cabecera `Authorization`.
    - **Tiempo máximo:** `AbortSignal.timeout`, como mucho 3 s aunque se pida más (`timeoutMs` solo puede bajarlo, para las pruebas), combinado con la señal de quien llama (`AbortSignal.any`). Si ya venía cancelada, no se llama. Una respuesta que llega después del tiempo o de la cancelación no se usa.
    - **Respuesta:** `choices[0]` con `parseMoveChoice` (F1) contra la decisión enviada, así que solo puede devolver una ficha de esas opciones legales.
    - **Errores** (`MoveLlmError`, con mensajes fijos): `cooldown` (corte activo, sin llamar), `http` (con `status` y el resumen saneado de `describeHttpError`), `network`, `timeout`, `aborted` e `invalid_response` (motivo de `MOVE_INVALID_REASONS`: los del parser y `respuesta ilegible`, con `describeCompletion`, sin el texto del modelo).
    - **Corte temporal propio** (`createMoveBreaker`, en memoria del proceso): un 429 de los movimientos no corta el chat ni al revés. 400, red, timeout y cancelación no cortan.
    - Del chat solo reutiliza funciones puras y sin estado para sanear el registro: `describeHttpError` (con `redactSecrets`) y `describeCompletion`.
  - `src/lib/game/moveSelector/log.ts`: `logMoveError(stage, error)` → `[move-llm] <etapa>: LLM <tipo> (<código>)[: <motivo fijo>] <resumen saneado>`, una vez por minuto por tipo y motivo; un mensaje que no es un motivo conocido se registra como `motivo desconocido`. Nunca la clave, el prompt ni el texto del modelo.
  - **Límites (F2):** sin cupo por partida todavía; el corte temporal es por proceso (cada instancia de Vercel tiene el suyo); no se ha probado contra AI Gateway real (las pruebas usan `fetch` simulado). La compilación de producción no incluye el endpoint ni `MOVES_LLM_ENABLED` en `.next/static` (comprobado tras el build).

- **F3 · integración** (`src/lib/game/moveSelector/decide.ts`, `advance.ts` y `app/api/games/[id]/advance/route.ts`):
  - `decideActionWithSelector(state, { rollDie, random, selector?, signal?, onFallback? })` → `{ action, source: "llm" | "local" }`. Solo cambia cómo se elige la ficha con **dos o más** movimientos legales:
    - **Sin selector**, partida terminada, **tirada** (sin dado ni bonus), **sin movimientos** (`timeout`) o **una sola opción**: exactamente `decideAction` (sin consultar al LLM).
    - **Dos o más opciones:** `buildMoveDecision` (F1) y `selector.select(state, decision, { signal })` (F2). La elección se valida: el identificador **y** la ficha deben ser los de una opción de esa decisión (`opción no válida`), la ficha debe seguir en `getAvailableMoves` del estado reservado y `applyAction` debe aceptarla (`movimiento ilegal`).
    - **Ante cualquier fallo** (error HTTP, red, timeout, cancelación, corte temporal, respuesta no válida, `opción no válida`, `movimiento ilegal` o una excepción del selector, `excepción del selector`): `decideAction` → `chooseMove` **exactamente una vez**, con el mismo azar que antes. El aviso `onFallback(motivo)` lleva un texto fijo (`MoveFallbackReason`).
  - `advanceGame`: dependencias opcionales nuevas `moveSelector`, `signal` y `onMoveFallback`. La decisión ocurre **tras la reserva** (paso 3), sobre `claimed.state`, así que la respuesta del LLM solo puede aplicarse a esa versión. Después, `applyAction` y `commit` como siempre: si la reserva caduca mientras responde el LLM, `lease_expired` y no se guarda nada; si otro proceso ya avanzó, tampoco se aplica la respuesta tardía. Si la estrategia local falla tras el selector, se libera la reserva como antes.
  - **Ruta de avance:** crea el selector en cada petición solo si `readMoveLlmConfig(process.env)` lo activa (Vercel Preview, `MOVES_LLM_ENABLED=true`, la clave y el modelo exacto), con un corte temporal del módulo (`moveBreaker`, propio del proceso y distinto del del chat). Pasa `request.signal` (si el navegador cancela, se usa la jugada local y la partida avanza) y `logMoveError` para los fallos del selector (`selector`), los rechazos de la validación (`estrategia local`; no repite «fallo del selector», que ya registra el selector) y la configuración incorrecta (`configuración`, sin valores; `off` no se registra).
  - **Coste en el avance:** con el selector activo, cada decisión con dos o más opciones (mientras quede cupo) puede tardar hasta 3 s más (el navegador espera la respuesta: una petición a la vez). Muy por debajo de la reserva de 20 s.
- **F4 · cupo de 20 consultas por partida** (`src/lib/game/moveSelector/quota.ts`, `server-only`):
  - **Contador persistente y compartido** entre instancias en Upstash Redis, con las mismas credenciales que el limitador (`UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` o `KV_REST_API_URL`/`KV_REST_API_TOKEN`). Clave `<prefijo del entorno>:moves-llm:<id de la partida>`, con el prefijo de `rateLimitPrefix` (Preview, Production, Development y local no comparten contadores). En Redis solo hay un número por partida: ni IP, ni usuarios, ni prompts.
  - **Atómico:** `QUOTA_SCRIPT`, un único `EVAL` en Lua (Redis lo ejecuta sin intercalar nada): lee el contador, devuelve `-1` si ya está en el límite y, si no, `INCR` y, solo en la primera consulta, `PEXPIRE`. Dos peticiones simultáneas no pueden superar las 20, y una vez agotado el contador no sigue creciendo. Las pruebas usan un doble en memoria con la misma semántica: la atomicidad real la garantiza Redis.
  - **Caducidad:** 7 días desde la primera consulta (`MOVES_LLM_QUOTA.ttlMs`), sin renovarse. Una partida normal dura minutos; una abandonada no deja la clave para siempre. Si una partida siguiera viva más de 7 días, recibiría como mucho otras 20.
  - `createMoveQuota(redis, { prefix, timeoutMs?, limit?, ttlMs? }).tryConsume(gameId)` → `allowed` (con el número de la consulta, 1–20), `exhausted` o `unavailable`. Nunca lanza. `unavailable` si Redis falla (también de forma síncrona), tarda más de 1 s (`MOVES_LLM_QUOTA.timeoutMs`) o responde algo que no es `-1` ni un entero de 1 a 20, y si el id no es un UUID (sin tocar Redis). `getMoveQuota(env)`: el cupo de la aplicación (un cliente por proceso) o `null` sin credenciales válidas.
  - **Dónde se consume** (`decideActionWithSelector`): solo con selector, dado o bonus pendiente, **dos o más** movimientos legales, el selector disponible (`isAvailable()`, nuevo en F2: sin corte temporal activo) y la petición sin cancelar; justo antes de construir las opciones y llamar al modelo. Nunca al tirar, sin movimientos, con una sola opción ni sin selector. La consulta consumida **cuenta aunque el modelo falle o agote el tiempo**.
  - **Sin cupo** (`cupo agotado`) o sin poder confirmarlo (`cupo no disponible`: Redis falla, tarda, responde algo inesperado o no hay cupo), estrategia local sin consultar al modelo (falla cerrado; nunca se asume que hay cupo) y sin errores para el usuario. Las opciones de F1 solo se construyen con el cupo concedido, así que una partida que ha agotado el cupo no paga sus simulaciones.
  - `advanceGame`: dependencia opcional `moveQuota`; sin ella, el selector no se consulta aunque exista. Ruta de avance: sin Upstash no crea el selector y registra `configuración sin_upstash` (sin valores). Los motivos `cupo agotado` y `cupo no disponible` se registran con `logMoveError("estrategia local", …)`, como mucho una vez por minuto.
  - **Sin cambios** en el límite general de avance ni en los limitadores del chat (`rateLimit.ts` no cambia; solo se reutiliza `rateLimitPrefix`).
- **F5 · variables de entorno** (`web/.env.example`, sección «Selector de movimientos con LLM»; sin cambios en el código):
  - `MOVES_LLM_ENABLED=false` (solo `true` lo activa), `MOVES_LLM_MODEL=nvidia/nemotron-3.5-lightning-free` (exacto) y `MOVES_LLM_PROVIDER` (opcional). La clave es la **misma** `AI_GATEWAY_API_KEY` del chat (no hay otra), y el cupo usa las credenciales de Upstash del limitador (`UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` o `KV_REST_API_URL`/`KV_REST_API_TOKEN`). `VERCEL` y `VERCEL_ENV` son variables de sistema de Vercel: no se crean.
  - El timeout (3 s) y el cupo (20) no son variables. Ninguna clave con `NEXT_PUBLIC_`. Solo valores de ejemplo.
  - **Efecto lateral:** las credenciales de Upstash en Preview también activan allí los límites de peticiones (con el prefijo `parchis:rl:preview`, sin tocar los de Production).
  - **Variables que hay que añadir en Vercel, solo en el entorno Preview** (Project Settings → Environment Variables): `MOVES_LLM_ENABLED=true`, `MOVES_LLM_MODEL=nvidia/nemotron-3.5-lightning-free`, opcionalmente `MOVES_LLM_PROVIDER=nvidia` (como el chat), `AI_GATEWAY_API_KEY` si Preview no la tiene ya, y las credenciales de Upstash si Preview no las tiene. Nada en Production.

## Seguridad: límites de peticiones (fase 7)

**Estado real:** el código está listo y probado, pero **en producción solo protege si Upstash está configurado** (ver más abajo). Sin las variables, el limitador queda desactivado (en Vercel lo avisa el log `[rate-limit] DESACTIVADO`). En local no hace falta.

- **Proveedor:** Upstash Redis + `@upstash/ratelimit` 2.2.0 y `@upstash/redis` 1.40.0 (versiones exactas). Contadores compartidos entre instancias de Vercel y ventana deslizante. Un limitador en memoria no serviría: Vercel ejecuta varias instancias.
  - Se descartó el WAF de Vercel: en Hobby solo admite 1 regla por proyecto, configurada en el panel, con contadores por región y ventana fija, y sin hora de liberación para `Retry-After`.
- `src/lib/security/clientIp.ts`: `getClientIdentity(headers)`.
  - Solo en Vercel (`VERCEL=1`) usa `x-vercel-forwarded-for`, luego `x-real-ip` y luego el primero de `x-forwarded-for`. Vercel sobrescribe esas cabeceras y no deja pasar IP externas.
  - Fuera de Vercel no se fía de ninguna: la clave es `local`.
  - IPv6 se agrupa por /64, la IPv4 mapeada se convierte a IPv4 y, sin una IP válida, la clave es `unknown`.
- `src/lib/security/rateLimit.ts` (`server-only`):
  - Reglas, `loadRules` (permite cambiarlas por entorno) y `createUpstashLimiter`.
  - Timeout de 1 s: el `reason: "timeout"` de Upstash se trata como proveedor caído.
  - Identificadores `<prefijo>:<regla>:<sha256 de la clave>`: no se guardan IP en claro.
  - Prefijo por entorno (`rateLimitPrefix`), para que los entornos no compartan contadores aunque usen la misma base de Upstash: Production `parchis:rl` (sin cambios), Preview `parchis:rl:preview`, Development `parchis:rl:development`, local (sin `VERCEL=1`) `parchis:rl:local` y `VERCEL_ENV` ausente o desconocido `parchis:rl:unknown`.
  - `checkRateLimits`: si se supera un límite, gana el `Retry-After` mayor. Si el proveedor falla, se aplica la política de cada regla.
  - `rateLimitResponse`: 429 `{ error: { code: "rate_limited" } }` con `Retry-After`, o 503 `temporarily_unavailable` con `Retry-After: 30`. Ambas `no-store` y sin IP ni detalles internos.
  - `getRateLimiter()`: Upstash si hay credenciales; si no, desactivado.
- `src/lib/security/guards.ts`: `guardCreate`, `guardAdvance`, `guardRead` y `checkRead`. Se llaman **antes** de leer el cuerpo o tocar la BD.

| Regla | Dónde | Clave | Límite por defecto | Si Upstash falla |
|---|---|---|---|---|
| `create` | `POST /api/games` | IP | 5 cada 10 min | **cerrado**: 503 (escribe en la BD y es fácil de abusar) |
| `advanceGame` | `POST /api/games/[id]/advance` | IP + partida | 180/min | abierto |
| `advanceIp` | `POST /api/games/[id]/advance` | IP (todas las partidas) | 600/min | abierto |
| `read` | `GET /api/games/[id]`, `GET /api/games/[id]/messages` y la página `/partida/[id]` | IP | 120/min | abierto |

- **Por qué estos números:** cada pestaña que observa envía ~1 petición por versión (~1 cada 1,2 s, medido en Chrome), y las que pierden la carrera reciben 409.
  - 180/min por partida permite 3 pestañas tras la misma IP (NAT o varias pestañas) sin 429. Está probado durante 5 minutos simulados.
  - Los 409 cuentan, pero el margen los absorbe: no se devuelve cupo, para no añadir otra ida y vuelta a Redis.
  - Espectadores con IP distinta y partidas distintas tienen cupos independientes.
- **Por qué abierto en avance y lectura:** un fallo de Upstash no debe congelar todas las partidas. El servidor sigue limitando a un avance por versión (reserva, versión y trigger). Antes de activar el LLM de la fase 8.2b (coste por llamada), **reconsiderar** `advanceGame`/`advanceIp` como cerrados.
- **Cambiar los límites:** `RATE_LIMIT_CREATE`, `RATE_LIMIT_ADVANCE_GAME`, `RATE_LIMIT_ADVANCE_IP` y `RATE_LIMIT_READ` con `"<n>/<segundos>"`. Los valores inválidos se ignoran con un aviso.
- **Navegador:** `interpretAdvance` trata el 429 como `retry` con el `Retry-After` (5 s si falta o no es válido). El controlador no reintenta antes de ese plazo y la resincronización `GET` también lo respeta.
- **Configuración y verificación en producción** (manual; no se ha verificado que Upstash esté configurado y funcionando en el despliegue de Vercel):
  1. Crear una base de datos Upstash Redis (Vercel → Marketplace → Upstash for Redis, o console.upstash.com). Una región cercana a la de las funciones.
  2. Añadir en Vercel (Project Settings → Environment Variables), solo en el servidor y **sin** `NEXT_PUBLIC_`: `UPSTASH_REDIS_REST_URL` y `UPSTASH_REDIS_REST_TOKEN`. También sirven `KV_REST_API_URL`/`KV_REST_API_TOKEN`, que puede crear la integración del Marketplace. Plantilla en `web/.env.example`.
  3. Volver a desplegar. Comprobar que el log no muestra `[rate-limit] DESACTIVADO` y que la 6.ª creación de partida desde la misma IP en 10 min responde 429.
- **Limitaciones:**
  - La página `/partida/[id]` aplica el límite de lectura, pero al superarlo muestra un mensaje de error (no un 429 HTTP).
  - Realtime y la API REST de Supabase con la clave publicable no pasan por la app: dependen de los límites de Supabase (y RLS impide escribir).
  - Sin la clave real de Upstash no se ha probado contra un Redis real: el adaptador está probado con `@upstash/ratelimit` simulado.

## Estado de las fases

1. ✅ Esqueleto: Next.js, Tailwind, shadcn y Git.
2. ✅ Motor en TypeScript con pruebas.
3. ✅ Tablero visual: `src/lib/board/`, `src/components/board/` y la demo en `/tablero`.
4. ✅ HUD de jugadores y panel de dados: `src/lib/hud/` y `src/components/hud/`, integrados en `/tablero`.
5. ✅ Animación de las fichas casilla a casilla: `journey.ts`, `animation.ts` y `useBoardAnimation.ts`.
6. Supabase:
   - ✅ 6.1 Tabla `games` y conexión.
   - ✅ 6.2 Crear y guardar partidas (`POST /api/games`).
   - ✅ 6.3 Recuperar y ver partidas guardadas: `GET /api/games/[id]` (con `lastAction`/`lastEvents`) y `/partida/[id]`, leída en el servidor, con un aviso de en curso o terminada y la última jugada.
   - ✅ 6.4 Avance automático en el servidor con IA heurística (`POST /api/games/[id]/advance`).
   - ✅ 6.5 Partida en directo en `/partida/[id]`: avance desde el navegador que observa, Realtime y animaciones.
7. 🟡 Seguridad: límites de peticiones con Upstash. Implementado y probado en local; **no se ha verificado que Upstash funcione en producción** (sin él, producción no tiene límites).
8. Personajes:
   - ✅ 8.1 Personalidades y estrategias diferenciadas (`characters.ts`, `ai.ts`).
   - ✅ 8.2a Chat entre personajes con frases locales (director, cola persistente con trigger tolerante, Realtime y `ChatPanel`). SQL ejecutado en Supabase y chat comprobado en producción.
   - 🟡 8.2b Textos del chat con LLM vía Vercel AI Gateway (`nvidia/nemotron-3.5-lightning-free`), solo para las intervenciones importantes. Implementado, probado en local con un LLM simulado y con llamadas reales en Preview; **desactivado en Production** (`CHAT_LLM_ENABLED` solo en Preview; el código no lo activa en Production: `not_preview`). Pendiente: los pasos manuales de "Fase 8.2b" antes de activarlo en producción.
   - 🟡 8.3 Selector estratégico de movimientos con LLM: **F1** (opciones, prompt y parser, puros), **F2** (cliente de AI Gateway propio, solo Preview, 3 s, sin reintentos, corte temporal propio), **F3** (integración en `advanceGame` tras la reserva, solo con 2+ opciones, validación con el motor y estrategia local ante cualquier fallo) y **F4** (cupo atómico de 20 consultas por partida en Upstash, falla cerrado) implementadas y probadas sin llamar a AI Gateway ni a Redis; **F5**: variables documentadas en `web/.env.example`. Pendiente (F6): configurarlas en Vercel Preview y la prueba real. Ver «Selector estratégico con LLM».
9. ✅ Despliegue en Vercel y portada con «Nueva partida».
10. ⏳ Pendiente: animación de victoria.

## Pruebas y validación (desde `web/`)

811 pruebas en 48 archivos (Vitest, configuración en `vitest.config.mts` con el alias `@/`):

- **Límite conocido:** con el equipo muy cargado, alguna prueba que juega partidas completas puede superar el tiempo por defecto de Vitest (5 s) y fallar por `Test timed out` (visto en `personalities.test.ts`: unos 3,3 s sola). Ocurre también sin las pruebas de F4; vuelve a pasar con menos carga. No es un fallo de la lógica.

- `src/lib/engine/__tests__/rules.test.ts` (85): reglas, correcciones del motor original y tramo final (entrada + 7 + meta) en los cuatro colores. Además:
  - Barreras: detección (mismo color en normal, distinto color en normal no, cualquier pareja en seguro), nadie las atraviesa ni cae en ellas, salir de una la rompe, máximo 2 por casilla, entrada del pasillo y bonus bloqueados.
  - Salida con 5: casilla vacía, una propia, una rival, propia + rival, dos de otros colores (captura a la última llegada según `arrivalOrder`, no según el orden de los jugadores, también en una barrera de dos colores), dos propias, obligación de salir (también llamando directamente a `getLegalMoves`) y nunca más de 2.
  - Apertura con 6: barrera propia en normal y de dos colores en seguro (y las dos a la vez), sin otras jugadas si hay apertura, reglas normales si no la hay (y `applyAction` acepta el movimiento normal), sin obligación con barreras solo rivales y bonus sin obligación.
- `src/lib/engine/__tests__/simulation.test.ts` (3): 60 partidas completas con semilla (2, 3 y 4 jugadores); comprueba que terminan y que el estado es coherente en cada acción.
- `src/lib/board/__tests__/layout.test.ts` (12): geometría, pasillos y entradas, 16 fichas sin duplicar, apilado dentro de la casilla y tamaño en los círculos de casa.
- `src/lib/board/__tests__/animation.test.ts` (14):
  - Recorrido continuo y pasos de cada movimiento.
  - Fotogramas de salida de casa, recorrido, esquinas y entrada al pasillo (cada salto a una casilla contigua), meta, captura (también al salir de casa), bonus de 20 con duración acotada y tercer seis.
  - Ficha en movimiento sin apilar.
  - Simulación de 5 partidas: la animación acaba siempre en el estado del motor, con saltos de una casilla.
- `src/lib/supabase/__tests__/env.test.ts` (8): validación de las variables (faltan, formato incorrecto, URL con ruta, clave secreta en `NEXT_PUBLIC_`, sin mostrar valores) y que `server.ts` no se pueda importar fuera del servidor.
- `src/lib/game/__tests__/schemas.test.ts` (7): los esquemas aceptan todos los estados, acciones y eventos de 5 partidas completas (tras pasar por JSON) y rechazan estados, filas, acciones y eventos corruptos.
- `src/lib/game/__tests__/repository.test.ts` (10): con un cliente falso.
  - `create` (con `engine_version`, sin escribir estados inválidos) y `get`.
  - Errores de Supabase sin exponer su mensaje; el fallo de red se identifica como tal.
  - `claim`, `commit` y `release`: filtros exactos y `55P03` → `null`. `commit` no escribe resultados inválidos.
  - `parseGameRow`.
- `src/lib/game/__tests__/ai.test.ts` (13):
  - Heurística: capturar, salir de casa, llegar a la meta y evitar dejar una ficha a tiro; solo jugadas legales; desempate.
  - `decideAction`: tirar, mover, bonus, `timeout` sin movimientos y partida terminada.
  - 10 partidas completas de 4 IA aceptadas por el motor.
  - Barreras: 12 partidas completas (con bonus) en las que ninguna jugada atraviesa ni cae en una barrera y nunca hay más de 2 fichas por casilla.
  - La IA recibe los mismos movimientos que `getLegalMoves` con un 5 (solo salidas) y con un 6 (solo aperturas).
  - Oráculo independiente (sin `getLegalMoves` ni `getBlockades`) en 15 partidas completas: `getAvailableMoves` coincide con él en cada decisión, la IA elige dentro y `applyAction` rechaza cada jugada excluida con `MUST_EXIT_HOME` o `MUST_BREAK_BLOCKADE`.
- `src/lib/game/__tests__/personalities.test.ts` (15): personajes.
  - Catálogo: ids, orden de colores, nombres, solo Chispa con azar (15 %), perfiles distintos y perfil neutro.
  - Estilos: captura arriesgada (Pilar va al seguro y el resto captura), barrera (solo Don Ernesto la forma), caza (solo Brava se acerca al rival). `decideAction` usa el perfil por id, no por color. Los deterministas no cambian aunque reciban `random`.
  - Azar: `candidateMoves` (margen del 15 % con puntuaciones positivas, negativas, cero e infinitas), misma semilla → mismas elecciones, valores extremos de `random` y Chispa sin `random`.
  - Legalidad: `chooseMove` ignora índices ilegales y falla si no queda ninguno. En 8 partidas completas, cada jugada es legal, los deterministas eligen su óptimo, Chispa queda dentro del 15 % y se aparta del desempate determinista. Con la misma semilla, la partida es idéntica.
- `src/lib/game/__tests__/advance.test.ts` (13), con `memoryRepository.ts`, que reproduce el trigger (versión, token y reserva de 20 s con reloj controlable):
  - Casos normales: tirar, mover, sin movimientos, tercer seis y una partida completa (cada versión es exactamente `applyAction` sobre la anterior).
  - Errores: no existe, partida terminada (no reserva), fallo tras reservar (libera) y reserva caducada (no guarda).
  - Concurrencia: reintento → `version_conflict`; 2 y 10 peticiones simultáneas → solo 1 avanza; reserva ajena vigente y caducada.
- `src/app/api/games/[id]/advance/__tests__/route.test.ts` (11): 400 por cuerpos inválidos; forma del 200 con `no-store`; el dado del servidor da 1..6 y los tokens son distintos; 404 y los 409 con `currentVersion`; 500 y 503 sin detalles; el procesador del chat se programa solo con 200 y algo que comentar. Selector de movimientos: sin configurar, no se pasa; en Preview con la configuración válida y Upstash, se pasan el selector, el cupo, la señal de la petición y el aviso; en Preview sin Upstash, ni selector ni cupo, y se registra `sin_upstash` sin valores; en Production o con otro modelo, no se pasa y se registra la configuración sin la clave; activar el chat no lo activa.
- `src/lib/game/__tests__/advanceSelector.test.ts` (24), con el repositorio en memoria y sin llamar a AI Gateway (cliente de F2 con `fetch` simulado o selectores inyectados; se cuenta cada uso de `decideAction`; con un cupo que siempre concede, porque desde F4 sin cupo no se consulta):
  - Activado: con dos opciones se aplica la elección del LLM (distinta de la local), sin usar la estrategia local, y lo guardado es exactamente el resultado de `applyAction`; con una opción no se llama; ni para tirar ni cuando la tirada no deja movimientos; sin selector, `chooseMove`.
  - Fallos → estrategia local **exactamente una vez**, la partida avanza y la reserva queda libre: timeout, HTTP 500 y 429, red, respuesta inválida, identificador inexistente, truncada y cancelación de la petición. Con el circuito abierto, además, no se llama al selector ni se consume cupo.
  - Validación: identificador y ficha que no se corresponden, identificador de otra decisión y ficha fuera de las opciones (`opción no válida`); un selector que altera la decisión para mover una ficha ilegal (`movimiento ilegal`: nunca se aplica); un selector que lanza; y si la estrategia local también falla, se libera la reserva sin cambiar el estado.
  - Respuestas antiguas: reserva caducada mientras responde (`lease_expired`, nada guardado); otro proceso avanza entre medias (se guarda su jugada, no la tardía); reintento con versión antigua (`version_conflict` sin consultar al selector).
  - Partidas completas: con un selector que siempre falla, la partida es **idéntica** a la de sin selector (tiradas, turnos, bonus y reglas); con uno que elige siempre la última opción, solo se le consulta con 2+ opciones legales y dado o bonus, y todas las jugadas son legales.
- `src/lib/game/__tests__/advanceQuota.test.ts` (11), F4 dentro de `advanceGame` con el repositorio en memoria y un doble de Redis con el script atómico:
  - No se consume cupo al tirar, sin movimientos, con una sola opción, sin selector ni con la petición ya cancelada; sí al intentar una consulta real, aunque el modelo responda 503 o agote el tiempo (y entonces, jugada local).
  - Cupo agotado, Redis caído, respuesta inesperada de Redis y un cupo que lanza: jugada local sin llamar al selector, con su motivo, y la partida avanza con la reserva libre. Un selector sin cupo no se consulta.
  - Partida completa: el modelo se consulta exactamente 20 veces y la partida termina con la estrategia local; dos partidas en paralelo sobre el mismo Redis tienen 20 cada una; con un selector que siempre falla se consumen las 20 y la partida sigue avanzando.
- `src/app/api/games/[id]/messages/__tests__/route.test.ts` (4): últimos 20 y posteriores con `hasMore`; 404 y 400 sin consultar la BD; 503 y 500 sin detalles; `pending` y procesador en marcha si hay pendientes.
- `src/lib/chat/__tests__/` (con `memoryChatStore.ts`, que reproduce la semántica del SQL: cola, `enqueue` como el trigger, lotes, intentos en la cabeza, confirmación parcial, reloj controlable, fallos antes de aplicar y respuestas perdidas):
  - `director.test.ts` (41): sin mensajes en jugadas normales; captura, victoria, tercer 6, rachas (número real y consecutividad, la réplica sin la racha del mensaje principal y con sus propios hechos de captura, la captura simple sin rachas, con capturas intercaladas, 3 en la ventana, 3 seguidas, 4 con solo las 2 últimas seguidas y como víctima), meta, puesto final y ambiente (sin jugadores ya terminados); réplicas nunca a sí mismo; pausas de 8 y 3; límite de 60 con reserva para la victoria; habladores frente a reservados; `usedLines`; reproducible con semilla. Además: registro de coletillas (por personaje, de mensajes del LLM y locales, sin duplicados, cientos de versiones después, sin palabras comunes; cada partida el suyo; estado antiguo sin el campo) y ambiente (primero en solitario, segundo, tercero y último; empate en cabeza, total y en el último puesto; sin sesgo a favor de Brava; el peso de cada personaje sigue siendo su `talkativeness`). Tras la primera victoria nadie recibe `ambient_lead` (gane quien gane, también con dos terminados); el primero entre los que quedan usa `ambient_ahead`, el resto conserva sus categorías, los empates se comportan igual y los activos mantienen su `talkativeness`. Hechos de captura (P4): racha y mala racha que continúan, interrumpidas de verdad (desde los dos lados) y ya interrumpidas, sin racha, la pareja sin heredar el recuento global y una captura que hace crecer una racha e interrumpe otra; reinicios R1 y R2 (cuatro capturas en la ventana, tramo vivo de una, sin racha activa y con el disparador sin cambios; un tramo nuevo de 2 seguidas sí es racha); una racha que sale de la ventana (ni activa ni interrumpida) o sale en parte; y un historial con una versión no observada, que la continuidad detecta. **Continuidad del historial:**
    - versiones consecutivas (completo);
    - un salto, con el límite exacto de recuperación (v63 incompleto, v64 completo);
    - varios huecos sucesivos sin que `historyGapThrough` retroceda;
    - versiones repetidas, anteriores y fuera de orden (sin retroceder ni añadir capturas);
    - estados antiguos (v2 completo, una partida avanzada incompleta) e inválidos;
    - el límite de 50 capturas dentro y fuera de la ventana;
    - la recuperación solo con capturas observadas;
    - R1 con un hueco;
    - disparadores, intervenciones y consumo de azar idénticos con y sin hueco.
  - `writer.test.ts` (30): frases de los 4 personajes (tipos, marcadores permitidos, longitud con cualquier nombre y racha, sin repeticiones ni casi repeticiones), estilo distinto de cada uno, `renderLine` con `{count}`/`{Count}`/`{ritmo}`, antirrepetición global (también con otro rival) y por personaje (agota las frases antes de repetir), validación y coherencia (tres seises, casa frente a meta, victoria sin despedidas, rachas sin números escritos a mano); la frase de ambiente de Chispa «{rival} va a toda máquina» (antes «va lanzado», que no concordaba con Brava ni Pilar) con los cuatro nombres, sin «lanzado/a» en ninguna frase local; ninguna frase local usa jerga de televisión, deportes ni rebuscamientos (P3), y Chispa no es comentarista (al menos 8 frases de superstición o dado); escritor local y coletillas (prefiere frases sin las ya publicadas y, si todas las tienen, responde igualmente); y frases de ambiente (solo `ambient_lead` afirma ir ganando o en cabeza, las neutrales no dicen ir por detrás y cada tipo tiene frases sin rival); ninguna frase de `ambient_ahead` ni de `ambient_behind` afirma una buena posición propia (con un patrón que se comprueba con ejemplos que no están en el catálogo, como «llevo ventaja» o «estoy liderando», y con frases neutrales legítimas que deben pasar) y las de liderazgo siguen disponibles para el primero en solitario, con y sin rival. Historial incompleto: cada personaje tiene frases sin datos en cada tipo de captura y racha, ninguna afirma cifras ni rachas, y el escritor local elige una de ellas.
  - `style.test.ts` (17): estilo de las frases locales y del prompt. Ninguna frase usa expresiones artificiales o grandilocuentes, de otras variedades del español o calcos del inglés, ni de televisión o deportes (tampoco Chispa); plural de confianza con «vosotros» (salvo Don Ernesto, de usted); frases cortas; en cada personaje y tipo, al menos la mitad de las frases usa el vocabulario de su evento, y capturas, meta y puesto final no se mezclan; personalidad (Brava y Chispa con exclamaciones, retos y superstición; Don Ernesto sin exclamaciones, de usted, sin tutear y con cálculo; Pilar cariñosa, con refranes en como mucho el 15 % de sus frases); ninguna coletilla en más de dos frases de su personaje ni más de tres frases con el mismo comienzo; las frases de captura, racha y victoria de los cuatro personajes, con cada rival y rachas de 2 y 3 (seguidas o no), pasan `checkQuality` con los hechos reales de `captureFacts` (536 frases rellenadas, sin relajar el validador); y el prompt pide español coloquial de España, el vocabulario del parchís, reaccionar solo a lo que acaba de pasar y permite «Abuela» solo cuando Abuela Pilar es la otra parte. Con el flujo real del escritor LLM (`cleanLlmText` y, sobre su resultado, `checkQuality`), «Abuela» y «Abuela Pilar» se aceptan cuando Abuela Pilar participa en la intervención y se rechazan («nombra a un personaje ajeno a la intervención») cuando no participa. **Concordancia de género:** ninguna frase local de ningún personaje, con ningún rival, usa un apelativo del género contrario al del destinatario (690 combinaciones de frase y rival), y el género de cada personaje es el previsto.
  - `catchphrases.test.ts` (4): detección de las coletillas de cada personaje por su índice; variantes al inicio de una frase («¡A casa con eso!») frente a «Vuelve a casa»; solo las de quien habla; «Ay, hijo, qué prisas» con comas; y el registro sin duplicados y acotado.
  - `load.test.ts` (3): la carga inicial mira la cola antes que los mensajes y nunca devuelve "sin el último mensaje y sin pendientes", aunque el lote se confirme durante la carga (B2); errores y id no válido.
  - `config.test.ts` (6): `config.ts` coincide con el SQL (disparadores, orígenes, longitud, `seq`, formato del personaje, rangos de reserva y lote) y los esquemas aplican exactamente esos límites (incluido el estado del director sin `usedLines`).
  - `service.test.ts` (42): cola en orden; fuera de orden; reserva ocupada sin descartar; 10 procesadores simultáneos → 1, sin duplicados ni pérdidas; varios lotes; proceso interrumpido tras reservar (recuperado al caducar); respuesta perdida al reservar y al confirmar; fallo durante la confirmación; reserva caducada; versión defectuosa (sola o en medio del lote, sin penalizar a las demás); versiones desfasadas; victoria pendiente (antigua, con intentos agotados y datos dañados en modo mínimo, junto a una defectuosa, con todas sus frases "repetidas"); y 6 partidas completas con caos (procesadores sin esperar, concurrentes, `after()` perdidos, fallos, respuestas perdidas e interrupciones), donde no se pierde la victoria, no hay duplicados, la cola acaba vacía y se cumplen pausas, réplicas y límites. En esas partidas, cada texto es una frase del propio personaje, y la coherencia se comprueba contra los eventos reales, calculados aparte: el número y "seguidas" de cada racha, y ninguna mención a la casa en tres seises sin ficha devuelta. Además, en 8 partidas, las capturas son menos del 56 % del chat, pero se siguen comentando, y la victoria siempre (B4). Y con un escritor principal lento o que falla: reparto en varias reservas sin caducar ni repetir llamadas, tiempo máximo dentro del margen de su reserva, aborto y escritor local si no responde, local si falla o ya no queda tiempo, y victoria con el local. Temporizador del principal: se limpia y no vence si responde a tiempo, si falla o si lanza de forma síncrona (el local se usa una vez por intervención); si vence, aborta y usa el local una vez; si también falla el local, el error se propaga, lo anterior se confirma y esa versión queda pendiente sin reintentar en la misma ejecución; y en el peor caso (dos plazos agotados en la última versión) se confirma justo al empezar el margen (27 s); registro de coletillas: se guarda con la confirmación, una versión que falla deja solo lo confirmado y el reintento lo completa sin duplicar, y un estado guardado sin el campo se sigue usando. **Continuidad de punta a punta** (procesador real, sin cambios en `service.ts`): historial completo con todas las versiones; versión no encolada, defectuosa por eventos inválidos o por intentos, estado inválido y estado antiguo, detectados al observar la versión siguiente y guardados con la confirmación de ese lote;
    - versión **no encolada** (la 6): hueco en la 6 detectado al observar la 7, que no desaparece al observar las versiones posteriores dentro de la ventana (sigue en 6 hasta la 65);
    - versión defectuosa como **última del lote**: estado persistido inmediatamente después (cursor en la 6, `observedThrough` en la 5, sin hueco) y hueco registrado en el drain siguiente;
    - **más de 3 intentos en mitad de la partida**, como primera del lote siguiente: detectado por el salto;
    - **dos defectuosas seguidas** (6 y 7): hueco en la última (7), y la recuperación cuenta desde ella (en v66 el escritor recibe hechos incompletos; en v67, completos);
    - **historial incompleto con frases locales** (hueco en la 3 y capturas hasta la 62, 6 semillas): ningún mensaje con cifras, «seguidas» ni rachas; los disparadores de racha siguen ocurriendo (comprobado con la semilla 1).
  - `store.test.ts` (5): parámetros de las RPC (lote, confirmación, `pending`), validación antes de escribir, lecturas y errores sin detalles.
  - `chatController.test.ts` (9): feed (duplicados, orden, límite, visibilidad por versión) y controlador (carga inicial + recuperación + Realtime sin duplicados, reconexión con páginas, sin red, 429, filas ajenas y `stop()`). Además, **partida terminada con el procesador interrumpido: consulta hasta recuperar la victoria**; en curso no consulta por pendientes.
  - `schedule.test.ts` (7): `after()` con el procesador de esa partida, fallo al programar, BD caída sin lanzar y registro limitado; `chatWriters`: sin activar, todo local y sin registros; activo, solo lo importante llama a AI Gateway; mal configurado (modelo no permitido o clave pública), local y un registro sin la clave.
- `src/lib/chat/llm/__tests__/`:
  - `env.test.ts` (13): solo el modelo permitido; configuración válida; desactivado salvo `CHAT_LLM_ENABLED=true`; falta la clave o el modelo; proveedor no válido; modelo no permitido; clave con `NEXT_PUBLIC_`; en Vercel solo Preview (Production, Development, otros valores y sin `VERCEL_ENV` → `not_preview`; Production sin activarlo → `off`); local sin `VERCEL=1` como antes; en Preview se mantienen las demás comprobaciones; ningún resultado contiene la clave.
  - `prompt.test.ts` (19): estilo de cada personaje y reglas; una sola frase de menos de 120 caracteres (por debajo del límite de validación de 140), sin relleno y con recordatorio final; situación de los 13 tipos con el rival y la racha reales; réplica (con quién la dijo) y solo los 3 últimos textos recortados; sin datos de la partida ni identificadores internos; personaje desconocido. Además: reglas de calidad para los cuatro personajes (español, primera persona, nombres permitidos, coletillas, parchís, afirmaciones), regla de usted solo para Don Ernesto, papeles explícitos en capturas, rachas y victoria ajena, textos propios recientes, y **tamaño en el peor caso realista** (todos los personajes y los 6 tipos que escribe el LLM, con réplica, historial completo de textos largos y textos propios) por debajo de `CHAT_LLM.maxPromptChars`; prompt sin contradicciones (no nombra deportes, retransmisiones ni otros juegos, ni «comentarista»); hechos de captura desde quien habla (P4: racha activa del rival en la réplica sin heredar su recuento, mala racha, pareja solo si es real, rachas interrumpidas desde los dos lados, sin rachas en la captura simple y sin repetir la racha del mensaje principal), con el peor caso de tamaño incluyendo todos los hechos de captura y los de reinicio; R1 y R2 (cuatro capturas en poco tiempo y «no está de racha, desde entonces lleva una», sin repetir el recuento en el mensaje principal ni decir que la racha sigue); sin coletillas literales (estilo con `chat.voice`, distinto para cada personaje, manteniendo personalidad y forma de hablar) y situaciones de ambiente (liderar solo en `ambient_lead`). Historial incompleto: el aviso `INCOMPLETE_HISTORY` y ningún dato de cifras ni rachas, tampoco el recuento del mensaje principal. Concordancia de género en los dos sentidos (seis parejas, también con Don Ernesto), solo la de quien habla sin rival y sin apelativos sugeridos. La victoria ajena y la propia dicen que los demás siguen jugando por los otros puestos.
  - `gatewayWriter.test.ts` (64): petición (URL, `Authorization`, cuerpo mínimo sin `models`, `reasoning_effort: "none"` en la raíz y sin `chat_template_kwargs`, clave solo en la cabecera, `providerOptions.gateway.only` con proveedor fijado, sin reintentos); diagnóstico de errores HTTP (content-type, `x-vercel-id` y `error.type`/`code`/`message` con secretos enmascarados, cuerpos HTML, vacíos, ilegibles o enormes) y de respuestas rechazadas (motivo y resumen estructural sin texto del modelo), con el registro limitado a uno por minuto; nombres ajenos como palabra completa (sin falsos positivos como "bravata" o "chispazo") con el nombre detectado en el diagnóstico; cancelación por la señal del servicio y por su propio `timeoutMs`; 401, 402, 403, 404 y 500 con su corte temporal (sin llamar durante el corte), 429 con `Retry-After` válido, inválido o excesivo, y 400 y red sin corte; registro sin clave ni prompt; respuestas ilegibles, vacías o sin texto; limpieza de comillas, prefijo propio y líneas; demasiado largas, con formato o repetidas; habla como otro personaje o nombra a ajenos; solo lo importante usa el LLM; integración con `drainChat` (captura con el LLM y meta con el local; fallos → local con la cola vacía y la reserva libre; LLM colgado → aborto y local dentro del margen; victoria con el LLM caído; partidas completas con un LLM inestable); un rechazo de calidad (inglés) usa la frase local una sola vez por intervención, con `termino=…` y el resumen estructural en el diagnóstico, sin el texto del modelo; registro de coletillas de punta a punta: cientos de versiones después, la coletilla de Pilar se rechaza aunque esté fuera de la ventana de recientes, se usa la frase local y el texto rechazado no entra en el registro. Continuidad: la misma respuesta del LLM («¡Tres capturas seguidas!») se publica con el historial completo y, con un hueco, se rechaza y se usa la frase local. **Etiquetas, comillas y truncado** (regresión de la v382):
    - la cadena de la v382 se publica limpia, y sin la comilla de cierre se rechaza;
    - etiquetas propias (Pilar y Abuela Pilar con dos puntos, raya, guion, paréntesis y minúsculas, dentro y fuera de las comillas; Ernesto y (Don Ernesto)) y de otros personajes, también del rival;
    - etiquetas vacías y etiqueta en la primera línea con la frase en la segunda (que también se comprueba);
    - comillas emparejadas (seis formas), equilibradas dentro de la frase y descompensadas (ocho formas);
    - dos puntos de frases naturales y palabras que empiezan por un nombre;
    - narración propia («dijo Pilar») en el flujo completo;
    - coletilla ya publicada rechazada con y sin etiqueta, y repetición de un texto reciente con y sin etiqueta;
    - `finish_reason: "length"` (rechazo sin corte temporal; con `stop`, el mismo texto se acepta) y los motivos nuevos en la lista que se registra;
    - integración con `drainChat` en cuatro casos (etiqueta sola, comillas descompensadas, etiqueta ajena y truncada): una llamada al LLM y **exactamente una frase local por intervención**, sin publicar nada de la respuesta rechazada y con la cola vacía.
    - **Final de la partida:** una victoria con el estado en juego y el LLM diciendo «Se acabó la partida…» se rechaza (`termino=fin de la partida`), se usa la frase local una vez por intervención y el escritor recibe `gameStatus: "playing"`; con un estado no válido (victoria en modo mínimo), la petición no lleva `gameStatus`.
  - `quality.test.ts` (103), por regla:
    - **Regresión de Preview** (partida `707c3c6d…`): inglés, «la abuela Brava», «racha» en una captura simple, Don Ernesto tuteando, coletilla repetida, «tres en raya» y «estás fuera». También se comprueba que el resto de mensajes del LLM de esa partida y otros mensajes naturales se siguen aceptando (Don Ernesto de usted y con citas, «abuela» genérica, competición, préstamos sueltos y victoria).
    - **Idioma, nombres y usted:** cada regla por separado.
    - **Otros juegos y metáforas deportivas:** frases naturales de Chispa, y **cada término por separado** en una frase sin ningún otro término (que sin él se acepta). Los 8 de `SPORTS_METAPHORS` los acepta Chispa y los rechazan los otros tres; los 18 de `OTHER_GAMES` los rechazan los cuatro, cada uno informado con su propio término («jaque mate» como tal, no como «jaque»).
    - **Coletillas con variantes:** «¡A casa!» y «¡A casa con eso, Chispa!» en los dos órdenes, sin historial, dichas por otro, «Vuelve a casa», y variantes de Chispa y Don Ernesto.
    - **Tercera persona propia:** rechazos para los cuatro personajes con nombres, alias, artículos, contracciones y verbos. Aceptados «¡Gol de Chispa!», «Soy Brava», rivales en tercera persona, «la abuela» dicha por Pilar, «mi abuela» y «brava» como adjetivo. Narración de su propia frase («dijo Pilar», «dice Abuela Pilar», «exclamó Chispa», «Brava dijo», «contestó Don Ernesto», «respondió Ernesto») rechazada; la de otro personaje o sin el propio nombre, aceptada.
    - **Pruebas de cifras** (incluidas las tablas A, B y C de la auditoría):
      - Recuento y ritmo reales en rachas y malas rachas, en palabras y en cifra; «seguidas» y «consecutivas», con cifra y sin ella, con racha no consecutiva y en réplicas.
      - «una captura» en capturas, rachas, réplicas y victoria; «la primera vez»; ordinales en palabra y en cifra con sufijo; números mayores que diez; «un par de»; «doble/triple captura»; adjetivo intercalado.
      - «veces»/«vez» solo con señal de captura en la misma frase: «Piénsalo dos veces» y «Te lo he dicho dos veces» se aceptan; «Me has pillado dos veces», «Me has mandado a casa dos veces» y «Por segunda vez me pillas» cuentan. Señales sin coincidencias accidentales.
      - «capturas» como verbo frente a sustantivo, y cifras que no hablan de capturas ni son ordinales («cinco casillas», «2 a casa», «3 o 4»).
    - **Registro de la partida:** los casos reales #24 (Pilar) y #20 (Don Ernesto) de la partida `4e120c1e…` se rechazan aunque el texto anterior esté fuera de la ventana; el registro es por personaje y no afecta a expresiones comunes ni a coletillas no usadas.
    - **Longitud y nombres (P2):** como mucho dos frases (con abreviaturas, puntos suspensivos y signos que no cortan frase); «Dón»/«Don» truncado frente a «Don Ernesto», «un don» o «qué don»; Pilar llamando «abuela» a otro frente a «la abuela», «esta abuela» o «mi abuela».
    - **Rachas y cifras con el estado real (P4)**, con los hechos que calcula el director (`captureFacts`): los dos falsos positivos de la auditoría (Chispa, réplica en `capture_streak`: «Brava, me has capturado tres veces» con 3 capturas globales de Brava y 1 a Chispa; Brava, réplica en `bad_streak`: «Te he capturado dos veces seguidas, Chispa» sin dos capturas seguidas suyas a Chispa); racha y mala racha que continúan; racha y mala racha interrumpidas de verdad (se pueden afirmar desde los dos lados) y ya interrumpidas; sin racha ni datos (ni rachas ni cifras); fin de racha falso y correcto en réplicas, con variantes («se te acabó», «ha llegado a su fin», «adiós a tu racha», «Sí, se acabó…»); preguntas, deseos, hipótesis, futuros y negaciones; recuento global frente a pareja en cada dirección (correcto, incorrecto, ritmo y dirección cambiada) y dos cifras con sujetos distintos en una frase; réplicas de `capture_streak` y `bad_streak` desde su propio punto de vista.
    - **Auditoría final de P4:** afirmaciones con una cláusula hipotética aparte («Si quieres, …», «Quizá…, pero…», «Si me preguntas, …», «Si, …», «Sí, …», «…, ¿verdad?», «Se te acaba la racha»), rechazadas con la racha activa y aceptadas con la racha interrumpida; hipótesis, deseos y preguntas en la misma cláusula, aceptados en los dos casos; negaciones como continuidad; «una vez» y «la primera vez» con 0, 1 y 3 capturas de la pareja, en las dos direcciones y sin datos; expresiones hechas con «vez» y la captura de ahora («una ficha», «una captura más»), con el papel cambiado rechazado; fichas regidas por un verbo de captura (y fichas incidentales que no cuentan); dieciséis, veintidós y treinta; cifras sin sustantivo con y sin contexto, y números incidentales; R1 y R2 desde los dos lados; y «seguidas» con historial completo y con un hueco (historial incompleto: rechazado). **Historial incompleto:** cifras (también «una vez», ordinales, fichas y sin sustantivo) y «seguidas» rechazadas, el `streak` del mensaje principal ignorado, cualquier mención de racha rechazada, y aceptadas la captura de ahora con el papel correcto y las expresiones hechas.
    - **Cifras anteriores con la atribución de P4:** «Me has pillado dos veces», «Me has mandado a casa dos veces», «Por segunda vez me pillas» y «Me has pillado dos veces seguidas» ya no se aceptan con la mala racha global (eran el falso positivo de la auditoría): se aceptan con el recuento real de la pareja y se rechazan sin él.
    - **Regresión de la partida `84d066b1…`:** se rechazan los casos #16, #26, #7 y #17, y se aceptan #4, #10, #21 y #28.
    - Los motivos nuevos están en la lista que se registra.
    - **Género del destinatario:** regresión de la partida `010c5ace…` por el flujo completo («…, hijito» de Pilar a Brava y «…, hijita, …» a Chispa, rechazadas, y aceptadas con el género correcto); los dos sentidos con los cuatro destinatarios, también Don Ernesto («hijo mío»/«hija mía», «mi niño»/«mi niña», «querida»/«querido», «guapo»/«guapa», «maja»/«majo», «campeón»/«campeona»); réplicas (el destinatario es quien dijo el mensaje); plurales, neutros, usos que no son vocativos y victoria sin rival, aceptados; el motivo nuevo en la lista que se registra. «Ay, mi niña, con dos seguidas…» (Pilar a Chispa, mensaje real de Preview) pasa de aceptado a rechazado, y con «mi niño» se acepta.
    - **Final de la partida:** con `gameStatus: "playing"`, la réplica de la v745 de `010c5ace…` y ocho formas de decir que la partida ha terminado, rechazadas; la victoria individual, las jugadas, movimientos, turnos y fichas terminados, la negación y «para mí», aceptados; sin estado o con la partida terminada (`finished`), no se comprueba.
- `src/app/api/games/__tests__/route.test.ts` (5): 201 con los 4 personajes, cuerpo `{}`, 400 y errores 503 o 500 sin detalles (con el repositorio simulado).
- `src/app/api/games/[id]/__tests__/route.test.ts` (5): 200 validable con `GameResponseSchema` y sin datos internos (con `lastAction`/`lastEvents`); partida terminada con ganador; 404 si no existe o el id no es válido; 503 y 500 sin detalles.
- `src/lib/game/__tests__/load.test.ts` (4): `loadGame` con un repositorio falso: `ok` con el contrato validado; `not_found`; cada error → mensaje seguro sin lanzar; contrato incoherente → error.
- `src/lib/game/__tests__/live.test.ts` (7): modelo en directo.
  - `receive`: duplicados, versiones antiguas, otra partida y fechas solo si son más recientes.
  - `takeDisplayStep`: animar la siguiente, salto por hueco o por cola larga.
  - `parseRealtimeRow`, `interpretAdvance` (todos los códigos, con `currentVersion`) y `retryDelay`.
- `src/lib/game/__tests__/liveController.test.ts` (12): contra un mundo falso (servidor con el `advanceGame` real sobre el repositorio en memoria, Realtime que difunde cada cambio y reloj falso).
  - Partida completa con 1 espectador (cada versión animada una vez, en orden; al terminar se detiene) y con 3 a la vez (sin duplicados ni desorden; ningún `GET` por versión).
  - 409 con versión ya recibida, dentro del margen, sin Realtime y con Realtime caído.
  - `stop()`, pestaña oculta, red caída con espera creciente, recuperación inmediata con `online`, reconexión de Realtime con resincronización, partida ya terminada, partida borrada (404) y 429 con `Retry-After` (no reintenta antes de tiempo).
  - `boardVersion` solo avanza al terminar la animación.
- `src/components/game/__tests__/GameScreen.test.tsx` (9): HTML con `react-dom/server` (`next/navigation` simulado).
  - No encontrada y error con *Reintentar*.
  - En curso: v1, posiciones reales, dado y última jugada, fichas resaltadas.
  - Terminada: ganador, clasificación, sin "En curso" ni fichas resaltadas, fecha en hora de Madrid.
  - Chat: nombre, avatar, réplica, sin campo de escritura; no muestra mensajes de versiones posteriores; texto de espera.
- `src/lib/security/__tests__/clientIp.test.ts` (4): fuera de Vercel no se fía de las cabeceras; orden de preferencia en Vercel; valores no válidos → siguiente o `unknown`; IPv6 /64 e IPv4 mapeada.
- `src/lib/security/__tests__/rateLimit.test.ts` (20), con `@upstash/ratelimit` simulado y `fakeLimiter.ts` (ventana deslizante exacta, solo para pruebas):
  - Reglas por defecto y por entorno.
  - Dentro y fuera del límite con `Retry-After`; claves independientes; la regla más restrictiva gana.
  - Proveedor caído (cerrado/abierto) y sin proveedor.
  - 429/503 sin datos internos.
  - Adaptador: éxito, límite, timeout y error; una instancia por regla; sin IP en claro.
  - `getRateLimiter` con y sin credenciales.
  - Prefijo de las claves por entorno (`rateLimitPrefix`): Production `parchis:rl`, Preview, Development, local y `unknown`; `getRateLimiter` usa el del entorno.
- `src/lib/security/__tests__/guards.test.ts` (9): camino completo ruta → guard → limitador → adaptador, con `VERCEL=1` y la IP en `x-vercel-forwarded-for`.
  - Crear partida: 5 por IP, después 429; con el proveedor caído, 503 sin crear nada.
  - Avance: cupo por IP + partida (aislado entre partidas y entre IP), 600/min por IP y abierto con el proveedor caído.
  - Lectura: 120/min y abierta con el proveedor caído.
  - Regresión de contratos.
  - Espectadores reales: 1 y 3 pestañas tras la misma IP sin 429 en 5 min; 6 pestañas sí se limitan.
- `src/components/hud/__tests__/chatScroll.test.ts` (4): con un contenedor simulado (Vitest corre sin DOM), compensa exactamente el desplazamiento de WebKit, no corrige dos veces si el navegador ya lo hizo, no toca nada estando abajo (tampoco con una posición antigua) y no hace nada sin posición o sin el mensaje (B6).
- `src/lib/home/__tests__/newGame.test.ts` (12): respuestas de `POST /api/games` (201 válido, 429 con espera en segundos, minutos o sin cabecera, 503, 500, 400 y 201 sin id o con un id no UUID); el controlador entra en carga y hace el POST, navega a `/partida/[id]` y sigue en carga; varios clics durante la creación o la navegación hacen una sola petición; error y reintento con éxito; sin red, límite de creación y respuesta no JSON (no se queda bloqueado). Volver a la portada (Next.js la conserva con `<Activity>`): sin `reset` el botón se queda en carga (el fallo original); con `reset` al ocultarse vuelve a reposo y crea otra partida sin duplicar; una respuesta tardía tras `reset` no navega ni muestra un error; `reset` en reposo no notifica.
- `src/components/home/__tests__/NewGameButton.test.tsx` (5): el botón en reposo, creando (desactivado, `aria-busy` y estado anunciado) y con error (alerta y «Reintentar» activo); la portada muestra «Nueva partida» y el enlace al tablero, sin login ni campos de entrada; `NewGameButton` se renderiza en el servidor.
- `src/lib/game/moveSelector/__tests__/` (selector estratégico, F1, F2 y F4):
  - `envExample.test.ts` (6): lee el `web/.env.example` real: variables propias con el modelo exacto y desactivado por defecto, una sola `AI_GATEWAY_API_KEY` (la del chat) y las de Upstash; con el ejemplo en Preview y `MOVES_LLM_ENABLED=true`, selector activo y con cupo; Production, Development y local, desactivado con todas las variables; sin Upstash, sin cupo; las variables del chat no lo activan; sin secretos ni `NEXT_PUBLIC_` para claves, y el timeout y el cupo no son variables.
  - `quota.test.ts` (13), con un doble de Redis en memoria que ejecuta el script de forma atómica, con latencia y reloj controlable: el script (GET, límite, INCR y PEXPIRE solo la primera vez); de 0 a 20 (la 20 se concede, la 21 y siguientes se rechazan y el contador no pasa de 20); una sola llamada a Redis por consulta, con la clave, el límite y la caducidad; partidas y entornos con contadores independientes; 30 peticiones concurrentes desde tres clientes: exactamente 20 concedidas (1…20) y 10 rechazadas; caducidad fijada en la primera consulta, sin renovarse, y cupo recuperado al caducar; error de Redis (asíncrono y síncrono), once respuestas inesperadas y Redis que no responde → `unavailable`; id que no es UUID sin tocar Redis; `getMoveQuota` sin credenciales (o no válidas) y con ellas (también las de KV), un cupo por proceso.
  - `env.test.ts` (7): modelo y tiempo acordados; configuración válida en Preview (con y sin proveedor); desactivado salvo `MOVES_LLM_ENABLED=true`, también con el chat activado; `not_preview` en Production, Development, «Preview», «preview » (con espacio), sin `VERCEL_ENV`, sin `VERCEL` y fuera de Vercel; falta la clave o el modelo, modelos distintos (otros, sin `-free`, en mayúsculas o con sufijo) y proveedor no válido; claves con `NEXT_PUBLIC_`; ningún resultado contiene la clave.
  - `gateway.test.ts` (28), con `fetch` simulado y sin llamar al modelo: petición (endpoint, clave solo en la cabecera, cuerpo exacto con el prompt de F1, sin `models`, una sola llamada) y proveedor fijado; diez respuestas rechazadas (JSON inválido, texto alrededor, Markdown, identificador inexistente, clave duplicada, clave adicional, truncada, sin texto, sin `choices` y cuerpo que no es JSON) con su motivo fijo, sin corte y sin el texto del modelo en el diagnóstico; 401, 402, 403, 404, 500 y 503 con su corte (sin llamar mientras dura, y vuelve a llamar al acabar) y sin la clave en el diagnóstico; 429 con `Retry-After` válido, excesivo, no válido o ausente; 400 y red sin corte; el corte de un selector no afecta a otro; `isAvailable` refleja el corte temporal; timeout (aborta y sin corte); el tiempo nunca pasa de 3 s; cancelación durante la petición y ya cancelada (no llama); una respuesta válida que llega tras la cancelación no se usa; registro (motivos fijos, `motivo desconocido`, uno por minuto y sin la clave); nunca lanza.
  - `options.test.ts` (13): una opción (A → su ficha) y varias (A, B… en orden de ficha, correspondencia exacta con `pieceIndex` y `pieceForOption`, que no repara minúsculas); captura con su jugador y el +20, comprobada con `applyAction`; meta con el +10 concedido y con el +10 perdido (`bonus_lost`, comprobado con `applyAction`); entrada al pasillo y casilla segura; barrera formada; amenazas y presas (1 y 1), con la comprobación independiente de que el motor produce esas capturas; bonus pendiente de +20 y de +10; obligación del 5 (solo salidas, igual que `getAvailableMoves`) y del 6 (solo abrir la barrera); sin obligación; partida terminada, sin dado y sin movimientos. **Propiedad:** en 75 decisiones de cada una de 2 partidas simuladas, las fichas de las opciones son las de `getAvailableMoves` y cada hecho (desde, hasta, avance, captura, meta, bonus, repite tirada y si hay amenazas) coincide con los eventos reales de `applyAction`.
  - `parse.test.ts` (30): JSON correcto (también con espacios en los extremos); 23 rechazos (claves duplicadas con el mismo valor, con otro, con un valor inexistente, escritas con escapes y con otra clave entre medias; JSON inválido, comillas simples, dos objetos, texto antes o después, Markdown, solo el identificador, array, clave adicional, sin `choice`, `choice` numérico o nulo, identificador inexistente, minúscula, con espacios, el `pieceIndex`, vacía y solo espacios); contenido que no es texto; `finish_reason: "length"` aunque el texto parezca válido; motivos fijos sin el contenido. Además, `topLevelKeys` solo cuenta las claves del objeto exterior («choice» como valor o en un objeto anidado no es una repetición, y las comillas y barras escapadas no confunden el recorrido), y las secuencias de escape del valor se aceptan como su identificador.
  - `prompt.test.ts` (6): quién decide, la respuesta pedida con el marcador `{"choice":"<identificador>"}` (sin ningún identificador real como ejemplo) y solo los identificadores legales; estado (jugada, obligación, jugadores con su progreso y opciones con los mismos hechos que la decisión); bonus pendiente; nunca `pieceIndex`, «ficha N», recomendaciones ni puntuaciones (en los cuatro personajes); el perfil de cada personaje según sus multiplicadores, y solo Chispa con azar; perfil neutro.
- `src/lib/hud/__tests__/hud.test.ts` (19): progreso de las fichas, resumen de jugadores (zonas, puestos, ganador), fases del turno (tirar, mover, bonus, fin) y textos de los eventos.

Comandos:

- `npm run dev`: desarrollo en http://localhost:3000 (demo del tablero en `/tablero`)
- `npm test`: pruebas (`npm run test:watch` en modo observación)
- `npm run lint`: ESLint
- `npx tsc --noEmit`: comprobación de tipos
- `bash supabase/tests/run-chat-sql-tests.sh`: pruebas del SQL del chat (43 SQL, 3 `WARNING`, 17 de `chat_commit` sin mensajes y 6 de concurrencia) en un PostgreSQL desechable (Docker; no toca Supabase)
- `npm run build`: compilación de producción

## Restricciones

- No hacer commits ni push salvo petición expresa.
- Avanzar por fases; no adelantar trabajo de la fase siguiente.
- `web/AGENTS.md` lo genera Next.js: indica consultar `web/node_modules/next/dist/docs/`, porque esta versión de Next.js tiene cambios de API.
