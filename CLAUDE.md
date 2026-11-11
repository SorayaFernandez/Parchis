# Parchís IA

Nueva versión del Parchís online: cuatro personajes controlados por IA juegan entre ellos y el usuario es **espectador** (ve el tablero y el chat).

## Estructura

- `web/`: **nueva aplicación**. Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS v4, shadcn/ui (estilo `base-nova`, sobre Base UI) y Vitest. Requiere Node ≥ 22.
  - `src/lib/engine/`: motor del Parchís en TypeScript puro (ver abajo).
  - `src/lib/board/` y `src/components/board/`: tablero visual (ver abajo).
  - `src/lib/hud/` y `src/components/hud/`: HUD de jugadores y panel de dados (ver abajo).
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

- Se sale de casa con un 5 y se captura a una ficha rival en la propia salida. En la salida caben como máximo 2 fichas.
- Las barreras (2 fichas del mismo color) no se pueden atravesar ni ocupar, sean propias o rivales. Con un 6 es obligatorio abrir una barrera propia.
- Se captura en casillas normales; nunca en casillas seguras ni en barreras. Si hay varias fichas candidatas, se captura la que llegó la última.
- Máximo 2 fichas en una casilla segura y 4 en una casilla normal.
- Para llegar a la meta hace falta la tirada exacta.
- Bonus: +20 por captura y +10 por llegar a la meta. Se juegan antes de volver a tirar, se pueden encadenar y se pierden si ninguna ficha puede usarlos.
- Con un 6 se vuelve a tirar. Si el bonus venía de un movimiento con 6, también se vuelve a tirar después de usarlo.
- Tres seises seguidos: al sacar el tercer 6, la última ficha movida por ese jugador vuelve a casa y pasa el turno. **Regla confirmada; no cambiarla.**
- Orden de turno: pink → blue → purple → green. Se saltan los colores ausentes y los jugadores que han terminado. La partida acaba cuando solo queda un jugador sin terminar.

### Decisiones pendientes / no implementado

Ninguna de estas reglas existía en el original; no se ha inventado nada.

- **Salida obligatoria con 5:** no implementada. Con un 5 se puede sacar ficha, pero no es obligatorio.
- **Contar 7 con un 6 cuando todas las fichas están fuera:** no implementado.
- **Barrera que no se puede abrir:** con un 6 y una barrera propia bloqueada, el jugador se queda sin movimientos aunque otra ficha pudiera moverse. Es el comportamiento original y está documentado en una prueba.
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
  - `createShowcaseState()`: estado de ejemplo con un caso de cada (casa, salida, barrera, dos colores en un seguro, pasillos y meta).

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
- Componentes shadcn usados: `ui/progress.tsx` (Base UI, sin dependencias nuevas) y `ui/button.tsx`.

## Página `/tablero` (`src/app/tablero/page.tsx`)

- Server Component con tema oscuro (clase `dark`) que muestra `BoardDemo`. La portada (`/`) enlaza aquí.
- **Disposición:** en escritorio (`lg`), el tablero va a la izquierda y el HUD en una columna de 21 rem a la derecha (dado y turno, jugadores, últimas jugadas). En móvil, el HUD va debajo del tablero y de los botones.
- `BoardDemo` (`"use client"`) usa el motor real (`applyAction`, `getAvailableMoves`) con un dado aleatorio (`Math.random`) y mueve siempre la primera ficha legal. **No es la IA del juego.**
  - Guarda el estado real, las últimas 6 jugadas (de los eventos de cada acción) y el número de tiradas, que reinicia la animación del dado.
  - Cada acción lanza `buildAnimation` con `useBoardAnimation`.
  - Resalta en el tablero las fichas que se pueden mover, excepto durante la animación.
  - Botones: *Siguiente acción*, *Automático/Pausar* (espera a la animación y luego 450 ms), *Ejemplo* (vuelve al estado de muestra), *Partida nueva* y *Lanzar dado* (en el panel del dado; se oculta en modo automático).

## Referencias del proyecto original (para las próximas fases)

- Interfaz pendiente de portar: chat (`frontend/src/game/hud/ChatPanel.tsx`) y animación de victoria (`frontend/src/game/animations/VictoryAnimation.tsx`, que usa `react-confetti`).

## Decisiones de arquitectura

- Sin registro, login ni jugadores humanos en la partida.
- El servidor tira el dado y valida todo con el motor; la IA **solo elige** entre los movimientos legales que calcula el motor.
- Supabase (BD + Realtime): tabla `public.games` creada y conexión configurada (ver "Supabase"). Pendientes: Vercel AI Gateway (LLM) y despliegue en Vercel.
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
  - `characters.ts`: catálogo de los 4 personajes, con ids estables `ai-pink`, `ai-purple`, `ai-green` y `ai-blue` (en el orden de `COLORS`) y nombres visibles provisionales.
  - `schemas.ts`: esquemas Zod tipados contra el motor (`z.ZodType<GameState>`, `GameAction`, `GameEvent`) y `GameRowSchema`, que exige que `status` y `winner` coincidan con `state`. También `toStoredGame` (camelCase, sin `lock_token`) y `ENGINE_STATE_VERSION = 1`.
  - `repository.ts` (`server-only`): operaciones sobre el cliente de servidor. Valida antes de escribir y al leer. Errores `GameRepositoryError` (`not_found`, `invalid_data`, `unsupported_version` y `database`; código de PostgreSQL solo para el registro; sin código = fallo de red, con su mensaje técnico).
    - `create(state)` y `get(id)`.
    - `claim(id, version, token)`: `UPDATE lock_token` con filtro por `id`, `version` y `status = 'playing'`. El plazo de 20 s lo fija el trigger.
    - `commit(id, version, token, { state, action, events })`: versión + 1 con el mismo token en `SET` y `WHERE`. Valida antes con Zod.
    - `release(id, token)`.
    - `55P03` (reserva vigente o caducada) o 0 filas → `null`, que el servicio trata como conflicto.
  - `ai.ts` (puro): IA heurística sin LLM.
    - `scoreMove`: simula cada jugada legal con `applyAction` (sin duplicar reglas) y puntúa: captura 1000, meta 800, salir de casa 400, entrar al pasillo 250, casilla segura 120, +1 por casilla, −150 por cada rival a 1-6 casillas detrás y +60 por barrera propia.
    - `chooseMove`: desempata por el índice más bajo.
    - `decideAction(state, rollDie)`: sin dado ni bonus → `roll` con el valor de `rollDie`; con dado o bonus → `move`; sin movimientos legales (estado anómalo) → `timeout`.
  - `advance.ts`: `advanceGame(id, expectedVersion, { repository, rollDie, newToken })` aplica **una** acción por llamada.
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
  - Dado: `crypto.randomInt(1, 7)`, solo en el servidor. Token de reserva: `crypto.randomUUID()`.
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
- Pendiente: IA con LLM (AI Gateway) y chat.

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
  - Identificadores `parchis:rl:<regla>:<sha256 de la clave>`: no se guardan IP en claro.
  - `checkRateLimits`: si se supera un límite, gana el `Retry-After` mayor. Si el proveedor falla, se aplica la política de cada regla.
  - `rateLimitResponse`: 429 `{ error: { code: "rate_limited" } }` con `Retry-After`, o 503 `temporarily_unavailable` con `Retry-After: 30`. Ambas `no-store` y sin IP ni detalles internos.
  - `getRateLimiter()`: Upstash si hay credenciales; si no, desactivado.
- `src/lib/security/guards.ts`: `guardCreate`, `guardAdvance`, `guardRead` y `checkRead`. Se llaman **antes** de leer el cuerpo o tocar la BD.

| Regla | Dónde | Clave | Límite por defecto | Si Upstash falla |
|---|---|---|---|---|
| `create` | `POST /api/games` | IP | 5 cada 10 min | **cerrado**: 503 (escribe en la BD y es fácil de abusar) |
| `advanceGame` | `POST /api/games/[id]/advance` | IP + partida | 180/min | abierto |
| `advanceIp` | `POST /api/games/[id]/advance` | IP (todas las partidas) | 600/min | abierto |
| `read` | `GET /api/games/[id]` y la página `/partida/[id]` | IP | 120/min | abierto |

- **Por qué estos números:** cada pestaña que observa envía ~1 petición por versión (~1 cada 1,2 s, medido en Chrome), y las que pierden la carrera reciben 409.
  - 180/min por partida permite 3 pestañas tras la misma IP (NAT o varias pestañas) sin 429. Está probado durante 5 minutos simulados.
  - Los 409 cuentan, pero el margen los absorbe: no se devuelve cupo, para no añadir otra ida y vuelta a Redis.
  - Espectadores con IP distinta y partidas distintas tienen cupos independientes.
- **Por qué abierto en avance y lectura:** un fallo de Upstash no debe congelar todas las partidas. El servidor sigue limitando a un avance por versión (reserva, versión y trigger). Si se añade una IA con coste por llamada, **reconsiderar** `advanceGame`/`advanceIp` como cerrados.
- **Cambiar los límites:** `RATE_LIMIT_CREATE`, `RATE_LIMIT_ADVANCE_GAME`, `RATE_LIMIT_ADVANCE_IP` y `RATE_LIMIT_READ` con `"<n>/<segundos>"`. Los valores inválidos se ignoran con un aviso.
- **Navegador:** `interpretAdvance` trata el 429 como `retry` con el `Retry-After` (5 s si falta o no es válido). El controlador no reintenta antes de ese plazo y la resincronización `GET` también lo respeta.
- **Configuración pendiente (manual) para producción:**
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
7. 🟡 Seguridad: límites de peticiones con Upstash. Implementado y probado; **pendiente de configurar Upstash en Vercel** (sin eso, producción no tiene límites).
8. ⏳ Pendiente:
   - Animación de victoria.
   - Personajes con IA (Vercel AI Gateway) y chat.
   - Despliegue en Vercel.

## Pruebas y validación (desde `web/`)

219 pruebas en 20 archivos (Vitest, configuración en `vitest.config.mts` con el alias `@/`):

- `src/lib/engine/__tests__/rules.test.ts` (57): reglas, correcciones del motor original y tramo final (entrada + 7 + meta) en los cuatro colores.
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
- `src/lib/game/__tests__/ai.test.ts` (10):
  - Heurística: capturar, salir de casa, llegar a la meta y evitar dejar una ficha a tiro; solo jugadas legales; desempate.
  - `decideAction`: tirar, mover, bonus, `timeout` sin movimientos y partida terminada.
  - 10 partidas completas de 4 IA aceptadas por el motor.
- `src/lib/game/__tests__/advance.test.ts` (13), con `memoryRepository.ts`, que reproduce el trigger (versión, token y reserva de 20 s con reloj controlable):
  - Casos normales: tirar, mover, sin movimientos, tercer seis y una partida completa (cada versión es exactamente `applyAction` sobre la anterior).
  - Errores: no existe, partida terminada (no reserva), fallo tras reservar (libera) y reserva caducada (no guarda).
  - Concurrencia: reintento → `version_conflict`; 2 y 10 peticiones simultáneas → solo 1 avanza; reserva ajena vigente y caducada.
- `src/app/api/games/[id]/advance/__tests__/route.test.ts` (5): 400 por cuerpos inválidos; forma del 200 con `no-store`; el dado del servidor da 1..6 y los tokens son distintos; 404 y los 409 con `currentVersion`; 500 y 503 sin detalles.
- `src/app/api/games/__tests__/route.test.ts` (5): 201 con los 4 personajes, cuerpo `{}`, 400 y errores 503 o 500 sin detalles (con el repositorio simulado).
- `src/app/api/games/[id]/__tests__/route.test.ts` (5): 200 validable con `GameResponseSchema` y sin datos internos (con `lastAction`/`lastEvents`); partida terminada con ganador; 404 si no existe o el id no es válido; 503 y 500 sin detalles.
- `src/lib/game/__tests__/load.test.ts` (4): `loadGame` con un repositorio falso: `ok` con el contrato validado; `not_found`; cada error → mensaje seguro sin lanzar; contrato incoherente → error.
- `src/lib/game/__tests__/live.test.ts` (7): modelo en directo.
  - `receive`: duplicados, versiones antiguas, otra partida y fechas solo si son más recientes.
  - `takeDisplayStep`: animar la siguiente, salto por hueco o por cola larga.
  - `parseRealtimeRow`, `interpretAdvance` (todos los códigos, con `currentVersion`) y `retryDelay`.
- `src/lib/game/__tests__/liveController.test.ts` (11): contra un mundo falso (servidor con el `advanceGame` real sobre el repositorio en memoria, Realtime que difunde cada cambio y reloj falso).
  - Partida completa con 1 espectador (cada versión animada una vez, en orden; al terminar se detiene) y con 3 a la vez (sin duplicados ni desorden; ningún `GET` por versión).
  - 409 con versión ya recibida, dentro del margen, sin Realtime y con Realtime caído.
  - `stop()`, pestaña oculta, red caída con espera creciente, recuperación inmediata con `online`, reconexión de Realtime con resincronización, partida ya terminada, partida borrada (404) y 429 con `Retry-After` (no reintenta antes de tiempo).
- `src/components/game/__tests__/GameScreen.test.tsx` (6): HTML con `react-dom/server` (`next/navigation` simulado).
  - No encontrada y error con *Reintentar*.
  - En curso: v1, posiciones reales, dado y última jugada, fichas resaltadas.
  - Terminada: ganador, clasificación, sin "En curso" ni fichas resaltadas, fecha en hora de Madrid.
- `src/lib/security/__tests__/clientIp.test.ts` (4): fuera de Vercel no se fía de las cabeceras; orden de preferencia en Vercel; valores no válidos → siguiente o `unknown`; IPv6 /64 e IPv4 mapeada.
- `src/lib/security/__tests__/rateLimit.test.ts` (10), con `@upstash/ratelimit` simulado y `fakeLimiter.ts` (ventana deslizante exacta, solo para pruebas):
  - Reglas por defecto y por entorno.
  - Dentro y fuera del límite con `Retry-After`; claves independientes; la regla más restrictiva gana.
  - Proveedor caído (cerrado/abierto) y sin proveedor.
  - 429/503 sin datos internos.
  - Adaptador: éxito, límite, timeout y error; una instancia por regla; sin IP en claro.
  - `getRateLimiter` con y sin credenciales.
- `src/lib/security/__tests__/guards.test.ts` (9): camino completo ruta → guard → limitador → adaptador, con `VERCEL=1` y la IP en `x-vercel-forwarded-for`.
  - Crear partida: 5 por IP, después 429; con el proveedor caído, 503 sin crear nada.
  - Avance: cupo por IP + partida (aislado entre partidas y entre IP), 600/min por IP y abierto con el proveedor caído.
  - Lectura: 120/min y abierta con el proveedor caído.
  - Regresión de contratos.
  - Espectadores reales: 1 y 3 pestañas tras la misma IP sin 429 en 5 min; 6 pestañas sí se limitan.
- `src/lib/hud/__tests__/hud.test.ts` (19): progreso de las fichas, resumen de jugadores (zonas, puestos, ganador), fases del turno (tirar, mover, bonus, fin) y textos de los eventos.

Comandos:

- `npm run dev`: desarrollo en http://localhost:3000 (demo del tablero en `/tablero`)
- `npm test`: pruebas (`npm run test:watch` en modo observación)
- `npm run lint`: ESLint
- `npx tsc --noEmit`: comprobación de tipos
- `npm run build`: compilación de producción

## Restricciones

- No hacer commits ni push salvo petición expresa.
- Avanzar por fases; no adelantar trabajo de la fase siguiente.
- `web/AGENTS.md` lo genera Next.js: indica consultar `web/node_modules/next/dist/docs/`, porque esta versión de Next.js tiene cambios de API.
