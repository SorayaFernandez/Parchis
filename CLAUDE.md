# Parchís IA

Nueva versión del Parchís online: cuatro personajes controlados por IA juegan entre ellos y el usuario es **espectador** (ve el tablero y el chat).

## Estructura

- `web/`: **nueva aplicación**. Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS v4, shadcn/ui (estilo `base-nova`, sobre Base UI) y Vitest. Requiere Node ≥ 22.
  - `src/lib/engine/`: motor del Parchís en TypeScript puro (ver abajo).
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
- `steps` es relativo a cada color: −1 en casa, 0–63 en el recorrido, 68–74 en el pasillo final y 75 en la meta. Las casillas globales van de 0 a 67.

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

## Referencias del proyecto original (para las próximas fases)

- Coordenadas del tablero: `backend/game/utils/boardMap.js` y `homeStretchMap.js` (viewBox 1600×1600). Todavía no se han migrado.
- Interfaz: `frontend/src/game/` (tablero, fichas, dados, HUD, chat) y recursos en `frontend/public/` (`board/`, `pieces/`, `ui/dice-*.svg`).
  - `pieces/GamePieces.tsx` tiene un `groups.forEach` anidado que duplica las fichas apiladas; hay que corregirlo al portarlo.

## Decisiones de arquitectura

- Sin registro, login ni jugadores humanos en la partida.
- El servidor tira el dado y valida todo con el motor; la IA **solo elige** entre los movimientos legales que calcula el motor.
- Stack previsto para fases posteriores (todavía **no instalado**): Supabase (BD + Realtime), Vercel AI Gateway (LLM), despliegue en Vercel.
- Las claves privadas solo existen en el servidor (nunca con el prefijo `NEXT_PUBLIC_`).

## Comandos (desde `web/`)

- `npm run dev`: desarrollo en http://localhost:3000
- `npm run build`: compilación de producción
- `npm run lint`: ESLint
- `npm test`: pruebas con Vitest (`npm run test:watch` en modo observación)
- `npx tsc --noEmit`: comprobación de tipos

## Restricciones

- No hacer commits ni push salvo petición expresa.
- Avanzar por fases; no adelantar trabajo de la fase siguiente.
- `web/AGENTS.md` lo genera Next.js: indica consultar `web/node_modules/next/dist/docs/`, porque esta versión de Next.js tiene cambios de API.
