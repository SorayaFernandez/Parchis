# Parchís IA

Nueva versión del Parchís online: cuatro personajes controlados por IA juegan entre ellos y el usuario es **espectador** (ve el tablero y el chat).

## Estructura

- `web/`: **nueva aplicación**. Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS v4 y shadcn/ui (estilo `base-nova`, sobre Base UI). Requiere Node ≥ 20.9.
- `frontend/`, `backend/`, `nginx/`, `vault/`, `docker-compose.yml`, `Makefile`: **proyecto original** (ft_transcendence). Solo de referencia. **No modificar ni eliminar.**

## Referencias del proyecto original

- Motor del juego: `backend/game/`
  - `constants.js` (recorrido de 68, pasillo de 7, salidas, seguros, bonus 20/10)
  - `gameEngine.js` (executeMove / executeBonusMove), `rules/`, `validators/canMovePiece.js`, `utils/getRealBoardPosition.js`
  - Coordenadas del tablero: `utils/boardMap.js`, `utils/homeStretchMap.js` (viewBox 1600×1600)
  - Errores conocidos que hay que corregir al portar: dado sin resetear cuando un jugador termina (`gameEngine.js` ~103-140), bonus encadenado solo dentro de `if (won)` en `executeBonusMove`, tres 6 sin movimientos no pasan el turno, `nextTurn` no salta a los jugadores abandonados.
- Frontend del juego: `frontend/src/game/` (tablero, fichas, dados, HUD, chat) y recursos en `frontend/public/` (`board/`, `pieces/`, `ui/dice-*.svg`).
  - `pieces/GamePieces.tsx` tiene un `groups.forEach` anidado que duplica las fichas apiladas.

## Decisiones de arquitectura

- Sin registro, login ni jugadores humanos en la partida.
- El servidor tira el dado y valida todo con el motor; la IA **solo elige** entre los movimientos legales que calcula el motor.
- El motor se portará a TypeScript puro (sin I/O ni temporizadores) dentro de `web/`.
- Stack previsto para fases posteriores (todavía **no instalado**): Supabase (BD + Realtime), Vercel AI Gateway (LLM), despliegue en Vercel.
- Las claves privadas solo existen en el servidor (nunca con el prefijo `NEXT_PUBLIC_`).

## Comandos (desde `web/`)

- `npm run dev`: desarrollo en http://localhost:3000
- `npm run build`: compilación de producción
- `npm run lint`: ESLint

## Restricciones

- No hacer commits salvo petición expresa.
- Avanzar por fases; no adelantar trabajo de la fase siguiente.
- `web/AGENTS.md` lo genera Next.js: indica consultar `web/node_modules/next/dist/docs/`, porque esta versión de Next.js tiene cambios de API.
