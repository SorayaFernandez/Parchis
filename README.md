# Parchís IA

**Cuatro personajes controlados por inteligencia artificial juegan al parchís entre ellos. Tú miras la partida y lees lo que se dicen.**

🌐 **Demo:** [https://parchis-gamma.vercel.app](https://parchis-gamma.vercel.app)

## Qué es

Parchís IA es una aplicación web en la que el usuario es **espectador**: pulsa «Nueva partida» y cuatro personajes, cada uno con su forma de jugar y de hablar, juegan una partida completa de parchís. El tablero se anima ficha a ficha y los personajes comentan en un chat lo que va ocurriendo (capturas, rachas, fichas que llegan a la meta, la victoria…).

No hay registro, inicio de sesión ni jugadores humanos en la partida.

## Funcionalidades

- **Partida en directo** (`/partida/[id]`): se guarda en Supabase, avanza una acción cada vez desde el navegador que la está viendo y se sincroniza por Realtime entre todos los espectadores.
- **Demostración sin servicios externos** (`/tablero`): una partida real de los cuatro personajes calculada en el navegador, con la misma pantalla que la partida en directo, controles de reproducción y sin base de datos, API ni modelos de IA.
- **Tablero animado**: las fichas recorren el tablero casilla a casilla, con capturas, barreras, pasillos de color y meta.
- **Panel de juego**: dado, jugadores con su progreso, últimas jugadas y clasificación final.
- **Chat entre personajes**: comentarios sobre los acontecimientos reales de la partida, con la personalidad de cada uno.
- **Portada** (`/`) con el botón «Nueva partida» y el acceso a la demostración.

## Los personajes

| Personaje | Color | Carácter | Cómo juega |
|---|---|---|---|
| **Brava** | Rosa | Agresiva y competitiva. Pica, presume y protesta. | Prioriza capturar y perseguir fichas rivales; le importan poco las casillas seguras y el peligro. |
| **Don Ernesto** | Morado | Estratega, calculador y educado. Siempre trata de usted. | Prioriza formar barreras y evitar amenazas; avanza con menos prisa. |
| **Abuela Pilar** | Verde | Prudente, cariñosa y paciente. | Prioriza las casillas seguras, no dejar fichas expuestas, entrar en el pasillo y llegar a la meta; no persigue a nadie. |
| **Chispa** | Azul | Espontáneo, alegre e imprevisible. | Prioriza avanzar casillas; elige al azar entre las jugadas que puntúan como mucho un 15 % por debajo de la mejor. |

La personalidad de juego se define con multiplicadores sobre una puntuación común de las jugadas (`web/src/lib/game/characters.ts` y `web/src/lib/game/ai.ts`). Nunca cambia las reglas: cada personaje elige siempre entre las jugadas legales que calcula el motor.

## Tecnologías

| Área | Tecnología |
|---|---|
| Aplicación | **Next.js 16** (App Router), **React 19**, **TypeScript** |
| Estilos e interfaz | **Tailwind CSS 4** y **shadcn/ui** (estilo `base-nova`, sobre Base UI) |
| Datos y tiempo real | **Supabase** (PostgreSQL, RLS y Realtime) con `@supabase/supabase-js` |
| Modelos de IA | **Vercel AI Gateway** (API compatible con OpenAI, llamada con `fetch` desde el servidor) |
| Límites de peticiones | **Upstash Redis** con `@upstash/ratelimit` |
| Validación | **Zod** |
| Pruebas | **Vitest**, más pruebas SQL en PostgreSQL y de Redis real en Docker |
| Despliegue | **Vercel** |

## Arquitectura

```
web/
├── src/app/                 Rutas de Next.js (páginas y Route Handlers)
│   ├── page.tsx             Portada
│   ├── tablero/             Demostración local
│   ├── partida/[id]/        Partida guardada, en directo
│   └── api/games/…          Crear, leer, avanzar y leer el chat de una partida
├── src/lib/engine/          Motor del parchís (TypeScript puro)
├── src/lib/game/            Personajes, IA, acceso a la base de datos y selector de jugadas con LLM
├── src/lib/chat/            Director del chat, escritores, validador y cola persistente
├── src/lib/llm/             Límite global de llamadas a AI Gateway
├── src/lib/security/        Límites de peticiones y protección de los POST
├── src/lib/supabase/        Clientes de Supabase (navegador y servidor)
├── src/components/          Tablero, HUD, chat y pantallas
└── supabase/                Esquema SQL y sus pruebas
```

**Cómo avanza una partida:**

1. `POST /api/games` crea la partida en Supabase con los cuatro personajes.
2. La página `/partida/[id]` se renderiza en el servidor con el estado guardado y, en el navegador, pide avances uno a uno con `POST /api/games/[id]/advance`.
3. El servidor tira el dado, decide la acción del personaje en turno, la valida con el motor y guarda la versión siguiente. Una reserva con versión y un *trigger* de PostgreSQL impiden aplicar dos veces la misma acción, aunque varios espectadores pidan avanzar a la vez.
4. Cada versión nueva llega a todos los espectadores por Supabase Realtime y se anima en el tablero.
5. La partida solo avanza mientras alguien la está mirando.

## El motor del parchís

El motor (`web/src/lib/engine/`) es TypeScript puro: no depende de React, Next.js, la base de datos ni servicios externos, y no usa azar ni temporizadores (el dado lo tira el servidor y se pasa como dato).

- `getAvailableMoves(state)` calcula las jugadas legales del jugador en turno; `applyAction(state, action)` valida y aplica una acción sin modificar el estado de entrada.
- Reglas implementadas: salir de casa con un 5 (obligatorio si alguna ficha puede salir), como máximo dos fichas por casilla, barreras que nadie puede atravesar, obligación de abrir una barrera propia con un 6, capturas fuera de las casillas seguras con +20, meta con tirada exacta y +10, repetir tirada con un 6 y penalización por tres seises seguidos.
- **Ninguna jugada se aplica sin pasar por el motor**: ni las de la IA heurística ni las que elige un modelo de lenguaje.

## Inteligencia artificial

### Decisión de las jugadas

- **Siempre disponible:** una IA heurística (`web/src/lib/game/ai.ts`) puntúa cada jugada legal simulándola con el motor y aplica el perfil del personaje.
- **Selector con LLM (solo en Vercel Preview):** cuando hay dos o más jugadas legales, el modelo recibe las opciones (con identificadores `A`–`D` y sus consecuencias calculadas por el motor) y debe responder solo con `{"choice":"…"}`. El servidor comprueba que la opción existe, que sigue siendo legal y que el motor la acepta. Ante cualquier fallo (tiempo agotado, error, respuesta no válida, límite o cupo agotado) se usa la jugada de la IA heurística.

### Chat

- **Por defecto, frases locales:** cada personaje tiene su propio catálogo de frases por tipo de acontecimiento.
- **Con LLM (en Vercel, solo en Preview):** el modelo escribe únicamente las intervenciones importantes (capturas, rachas y victoria). Todo lo demás, y cualquier respuesta rechazada o fallida, usa la frase local.

### Cómo se usa Vercel AI Gateway

- Llamadas `POST` a `https://ai-gateway.vercel.sh/v1/chat/completions` con `fetch` nativo, solo desde el servidor y con la clave en la cabecera `Authorization`. No hay SDK ni *streaming*.
- Modelo: `nvidia/nemotron-3.5-lightning-free` (la variante gratuita), el único permitido por el código para el chat y para las jugadas.
- Una petición por intervención o por decisión, sin reintentos, con tiempo máximo (8 s en el chat y 3 s en las jugadas).
- **Límite global compartido** en Upstash Redis: como mucho 4 llamadas por minuto entre chat y jugadas (2 cada uno) y 20 consultas de jugadas por partida. Si el proveedor responde 429, se bloquean las llamadas de todos durante el tiempo indicado.
- Sin Upstash, o fuera de Preview en Vercel, no se llama al modelo.

## El chat contextual

1. Al confirmarse cada versión, un *trigger* de PostgreSQL la copia a una cola (`game_chat_queue`) en la misma transacción.
2. Un procesador en el servidor (lanzado con `after()` tras responder) recorre la cola en orden. Un **director** decide si alguien habla y quién, según los acontecimientos reales y las ganas de hablar de cada personaje, con pausas para no saturar el chat.
3. El texto lo escribe el catálogo local o el modelo. **Toda respuesta del modelo pasa por un validador** que rechaza, entre otras cosas, otros idiomas, nombres que no participan, que el personaje diga su propio nombre, el tuteo de Don Ernesto, cifras o rachas que no coinciden con las capturas reales, una dirección de la captura contraria a la real, afirmaciones de posición que no coinciden con la clasificación real («voy ganando» solo si va primero) y una lista de expresiones retiradas.
4. Los mensajes se guardan en `game_messages` y llegan al navegador por Realtime. Se muestran cuando el tablero ha terminado de animar la jugada que comentan.

## Supabase y tiempo real

- **Tabla `games`:** estado de la partida (JSONB), versión, reserva del turno y la última acción con sus eventos. Su esquema está en `web/supabase/6.1-games.sql`.
- **Chat:** `game_messages`, la cola `game_chat_queue`, el estado del chat (`game_chat`) y las funciones de reserva y confirmación, en `web/supabase/8.2a-chat.sql`.
- **Seguridad en la base de datos:** RLS de solo lectura pública para `games` y `game_messages`; solo la clave secreta del servidor (`service_role`) puede escribir. La cola y el estado del chat no son accesibles con la clave publicable.
- **Realtime:** el navegador se suscribe a los cambios de su partida y a los mensajes nuevos, y se resincroniza al reconectar o al volver a la pestaña.

## Seguridad

- **Renderizado en el servidor:** la página de la partida lee el estado en el servidor; la portada y la demostración son estáticas.
- **Separación cliente/servidor:** los módulos que usan claves privadas importan `server-only`. Al navegador solo llegan la URL de Supabase y la clave publicable, que son públicas por diseño y están limitadas por RLS.
- **Claves:** la aplicación rechaza claves secretas en variables `NEXT_PUBLIC_` (la de Supabase y las de AI Gateway) y nunca escribe claves, prompts ni textos del modelo en los registros.
- **Validación de entradas:** cuerpos con esquemas estrictos, identificadores comprobados como UUID antes de consultar la base de datos y errores genéricos con `Cache-Control: no-store`.
- **Protección de los POST:** se rechazan las peticiones de otros sitios (`Origin` ajeno o `Sec-Fetch-Site: cross-site`, 403) y las que no envían `Content-Type: application/json` (415).
- **Límites de peticiones** por IP con Upstash Redis: crear partidas (5 cada 10 minutos), avanzar (180 por minuto por partida y 600 por minuto en total) y leer (120 por minuto). Si Upstash no está configurado, el limitador queda desactivado.

## Variables de entorno

La plantilla está en [`web/.env.example`](web/.env.example). Ningún valor de este README es real.

**Públicas** (llegan al navegador; en Vercel deben estar configuradas antes de compilar):

| Variable | Uso | ¿Obligatoria? |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | URL del proyecto de Supabase | Sí |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Clave publicable (lectura y Realtime, limitadas por RLS) | Sí |

**Privadas** (solo en el servidor; nunca con el prefijo `NEXT_PUBLIC_`):

| Variable | Uso | ¿Obligatoria? |
|---|---|---|
| `SUPABASE_SECRET_KEY` | Escritura en las partidas y el chat | Sí |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Límites de peticiones y límite global de IA. También valen `KV_REST_API_URL` y `KV_REST_API_TOKEN`, que crea la integración de Upstash en Vercel | No: sin ellas no hay límites ni IA. Recomendadas en producción |
| `RATE_LIMIT_CREATE`, `RATE_LIMIT_ADVANCE_GAME`, `RATE_LIMIT_ADVANCE_IP`, `RATE_LIMIT_READ` | Cambiar los límites por defecto (`<peticiones>/<segundos>`) | No |
| `AI_GATEWAY_API_KEY` | Clave de Vercel AI Gateway (la misma para chat y jugadas) | Solo para usar la IA |
| `CHAT_LLM_ENABLED`, `CHAT_LLM_MODEL`, `CHAT_LLM_PROVIDER` | Chat con LLM (`true`, el modelo permitido y, opcionalmente, el proveedor) | No |
| `MOVES_LLM_ENABLED`, `MOVES_LLM_MODEL`, `MOVES_LLM_PROVIDER` | Selector de jugadas con LLM | No |

`VERCEL` y `VERCEL_ENV` las pone Vercel automáticamente.

**Por entorno:**

- **Desarrollo local:** bastan las tres de Supabase. El chat con LLM puede activarse en local (con la clave, `CHAT_LLM_ENABLED=true`, el modelo y Upstash); el selector de jugadas con LLM, no.
- **Vercel Preview:** Supabase, Upstash y, para probar la IA, la clave y las variables `CHAT_LLM_*` y `MOVES_LLM_*`.
- **Vercel Production:** Supabase y Upstash. Los LLM permanecen desactivados: el código no los activa fuera de Preview aunque existan sus variables.

## Instalación y ejecución local

**Requisitos:** Node.js 22 y npm (la versión con la que se desarrolla y prueba el proyecto), un proyecto de Supabase y, para las pruebas SQL y de Redis, Docker.

```bash
git clone https://github.com/SorayaFernandez/Parchis.git
cd Parchis/web
npm install
cp .env.example .env.local   # y rellena las tres variables de Supabase
```

**Base de datos:** en el editor SQL de Supabase, ejecuta `web/supabase/6.1-games.sql` y después `web/supabase/8.2a-chat.sql`. Los dos archivos son idempotentes. Sin el segundo, la aplicación funciona sin chat.

```bash
npm run dev      # desarrollo en http://localhost:3000
npm run build    # compilación de producción
npm run start    # servir la compilación
```

La demostración de `/tablero` funciona sin Supabase ni servicios externos.

## Pruebas

Desde `web/`:

```bash
npx vitest run --maxWorkers=2                     # suite completa (Vitest)
npx tsc --noEmit                                  # comprobación de tipos
npm run lint                                      # ESLint
bash supabase/tests/run-chat-sql-tests.sh         # SQL en un PostgreSQL 17 desechable (Docker)
bash tests/redis/run-llm-limiter-redis-tests.sh   # limitador de IA contra un Redis 7 real (Docker)
```

- La suite de Vitest tiene más de mil pruebas: motor, rutas de la API, IA, chat y validador, Realtime simulado y seguridad. Las pruebas de Redis real se omiten en la suite normal y se ejecutan con su propio script.
- Las pruebas SQL y de Redis usan contenedores desechables y no tocan Supabase ni Upstash.
- `npm test` también ejecuta la suite, pero en un equipo muy cargado alguna prueba que juega partidas completas puede superar el tiempo por defecto de Vitest (5 s). Con `--maxWorkers=2` no ocurre.

## Despliegue en Vercel

1. Importa el repositorio en Vercel con **Root Directory** `web` (el código de la aplicación está en esa carpeta).
2. Configura las variables de entorno de cada entorno (ver «Variables de entorno»). Las `NEXT_PUBLIC_` deben existir antes de compilar.
3. Para los límites de peticiones, añade una base de Upstash Redis (por ejemplo, desde el Marketplace de Vercel).
4. El proyecto no necesita `vercel.json`.

## Estado del proyecto y limitaciones

**Implementado y desplegado:** motor completo, partida en directo con Supabase y Realtime, chat con frases locales, demostración, portada, protección de los POST y límites de peticiones (si Upstash está configurado).

**Solo en Vercel Preview:** el chat escrito por el modelo y el selector de jugadas con LLM. En Production están desactivados por código.

**Limitaciones conocidas:**

- La partida solo avanza mientras alguien la está mirando.
- La base de datos solo guarda los eventos de la última acción: al abrir una partida se ven las jugadas desde ese momento, no el historial completo.
- El validador del chat usa listas cerradas: una expresión nueva del modelo que no coincida solo la frenan el prompt y la comprobación de repeticiones. Los mensajes ya guardados no se corrigen retroactivamente.
- El modelo gratuito tiene un límite bajo de peticiones (de ahí el límite global de 4 por minuto), así que muchas intervenciones usan la frase o la jugada local.
- Reglas no implementadas: contar 7 con un 6 cuando todas las fichas están fuera.

---

**Desarrollado por Soraya Fernández.**
