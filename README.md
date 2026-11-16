# Parchís IA

**Cuatro personajes juegan al parchís entre ellos. Un modelo de lenguaje elige sus jugadas y escribe sus intervenciones en el chat. Tú miras la partida y lees lo que se dicen.**

[![Next.js](https://img.shields.io/badge/Next.js-16.4-000000?logo=nextdotjs&logoColor=white)](https://nextjs.org)
[![React](https://img.shields.io/badge/React-19.3-149eca?logo=react&logoColor=white)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-4.3-06b6d4?logo=tailwindcss&logoColor=white)](https://tailwindcss.com)
[![Supabase](https://img.shields.io/badge/Supabase-PostgreSQL_+_Realtime-3ecf8e?logo=supabase&logoColor=white)](https://supabase.com)
[![Vercel](https://img.shields.io/badge/Vercel-AI_Gateway-000000?logo=vercel&logoColor=white)](https://vercel.com)

**Demo:** [parchis-gamma.vercel.app](https://parchis-gamma.vercel.app) 

## Contenido

- [Sobre el proyecto](#sobre-el-proyecto)
- [Características](#características)
- [Personajes](#personajes)
- [Stack tecnológico](#stack-tecnológico)
- [Arquitectura](#arquitectura)
- [Instalación y ejecución local](#instalación-y-ejecución-local)
- [Pruebas](#pruebas)
- [Despliegue](#despliegue)
- [Seguridad](#seguridad)

## Sobre el proyecto

Parchís IA es una aplicación web en la que el usuario es **espectador**. Al pulsar «Nueva partida», cuatro personajes, cada uno con su forma de jugar y de hablar, juegan una partida completa de parchís. Los movimientos de las fichas se representan mediante animaciones en el tablero y los personajes comentan en un chat lo que va ocurriendo.
No hay registro, cuentas de usuario ni jugadores humanos. La partida la juegan siempre los cuatro personajes.

## Características

- **Partidas persistentes de cuatro jugadores:** se guardan en Supabase y cualquiera puede seguirlas en directo desde su enlace (`/partida/[id]`).
- **Reglas del parchís en un motor propio:** salida obligatoria con un 5, como máximo dos fichas por casilla, barreras que nadie atraviesa y obligación de abrir la propia con un 6, capturas fuera de las casillas seguras y de las barreras (+20), meta con tirada exacta (+10), nueva tirada con un 6 y, al tercer 6 seguido, la última ficha movida vuelve a casa. Gana quien mete antes sus cuatro fichas. Los demás siguen hasta completar la clasificación.
- **Cuatro personajes** con una estrategia de juego y una forma de hablar propias.
- **Jugadas decididas por un modelo de lenguaje** cuando hay varias opciones legales y el modelo está disponible, con una **estrategia local de respaldo** para cada personaje.
- **Chat contextual:** los personajes comentan los acontecimientos reales de la partida y se contestan entre ellos.
- **Sincronización en tiempo real** entre todos los espectadores y persistencia de cada versión de la partida.
- **Validación en el servidor:** ninguna jugada se aplica sin pasar por el motor del juego.
- **Control del uso del modelo:** límites por minuto, cupo por partida, tiempos máximos y respaldo local ante cualquier fallo.
- **Demostración** (`/tablero`): una partida de ejemplo de los cuatro personajes.

## Personajes

| Personaje | Carácter | Cómo juega |
|---|---|---|
| **Brava** | Agresiva y competitiva | Busca capturar y persigue las fichas rivales. |
| **Don Ernesto** | Estratega y formal; siempre trata de usted | Forma barreras y evita dejar fichas amenazadas. |
| **Abuela Pilar** | Prudente y cariñosa | Prefiere las casillas seguras, el pasillo y la meta. |
| **Chispa** | Espontáneo e imprevisible | Prioriza avanzar y varía entre jugadas de valor parecido. |

Cada personalidad se define con pesos sobre una puntuación común de las jugadas (`web/src/lib/game/characters.ts` y `web/src/lib/game/ai.ts`). La personalidad cambia la elección, nunca las reglas.

## Stack tecnológico

| Tecnología | Papel en el proyecto |
|---|---|
| **Next.js 16** (App Router) y **React 19** | Páginas con App Router, Server Components, Server-Side Rendering (SSR), prerenderizado, Route Handlers de la API y procesamiento posterior a la respuesta (`after()`). |
| **TypeScript** | Todo el código: motor, servidor e interfaz. **Zod** valida datos de entrada, de la base de datos y de los modelos. |
| **Tailwind CSS 4** | Estilos de toda la interfaz. |
| **shadcn/ui** sobre **Base UI** | Componentes de interfaz (botón y barra de progreso). |
| **Supabase** (PostgreSQL) | Persistencia de partidas y chat, reglas de integridad con *triggers*, funciones SQL y seguridad por filas (RLS). |
| **Supabase Realtime** | Envío a los navegadores de cada versión nueva de la partida y de los mensajes del chat. |
| **Vercel AI Gateway** | Acceso al modelo de lenguaje para elegir jugadas y escribir intervenciones del chat. |
| **Upstash Redis** | Límites de peticiones por IP y límite global de llamadas al modelo, compartidos entre instancias. |
| **Vercel** | Alojamiento y despliegue (Preview y Production). |
| **Vitest** | Pruebas automatizadas. |

## Arquitectura

```
web/
├── src/app/              Páginas y Route Handlers (/api/games…)
├── src/lib/engine/       Motor del parchís (TypeScript puro, sin dependencias)
├── src/lib/game/         Personajes, estrategia local, acceso a datos y selector de jugadas con IA
├── src/lib/chat/         Director del chat, escritores, validador y cola persistente
├── src/lib/llm/          Límite global de llamadas a AI Gateway
├── src/lib/security/     Límites de peticiones y protección de los POST
├── src/components/       Tablero, paneles de juego, chat y pantallas
└── supabase/             Esquema SQL y sus pruebas
```

### Renderizado

La aplicación combina distintas estrategias de renderizado de Next.js: prerenderizado estático para las páginas que no necesitan datos de una partida persistente y renderizado en servidor (SSR) para obtener los datos actualizados de las partidas. La interfaz interactiva se completa en el cliente mediante React e hidratación.

| Ruta | Cómo se genera |
|---|---|
| `/` y `/tablero` | **Prerenderizadas** en la compilación (Server Components), con la partida de demostración calculada en ese momento. En `/tablero`, la demostración continúa en el navegador sin llamar al servidor. |
| `/partida/[id]` | **Prerenderizado parcial:** la estructura de la página es estática y la partida persistente se lee de Supabase **en el servidor** en cada petición y llega en *streaming*. |
| `/api/games/…` | **Dinámicas:** crear, leer y avanzar partidas, y leer el chat. |

Después de la carga inicial, la partida es un componente de cliente: el navegador pide los avances, recibe los cambios por Realtime y anima el tablero.

### Servidor y cliente

- **Servidor:** tira el dado, decide la jugada del personaje en turno, la valida con el motor, guarda la nueva versión, procesa el chat y realiza todas las llamadas al modelo. Las claves privadas solo existen aquí.
- **Cliente:** muestra el tablero y el chat, pide un avance cada vez (`POST /api/games/[id]/advance`) y se sincroniza con Realtime. La partida avanza mientras alguien la está mirando.

### Una jugada, paso a paso

1. El navegador pide avanzar indicando la versión que conoce.
2. El servidor reserva el turno (versión y token de reserva, con un *trigger* de PostgreSQL que impide aplicar dos veces la misma acción).
3. Tira el dado y obtiene las jugadas legales del motor. Si hay varias, consulta al modelo. Si el modelo no está disponible, decide la estrategia local.
4. Comprueba que la jugada elegida sigue siendo legal y la aplica con el motor.
5. Confirma la versión siguiente en Supabase. Todos los espectadores la reciben por Realtime.
6. Un *trigger* encola la versión para el chat en la misma transacción; tras responder, el servidor procesa la cola y publica los mensajes.

### IA en las jugadas y en el chat

- **Jugadas:** solo cuando hay dos o más jugadas legales. El modelo recibe las opciones (identificadas como `A`–`D`, con sus consecuencias calculadas por el motor) y debe responder únicamente con la opción elegida. El servidor la valida antes de aplicarla.
- **Chat:** un director decide si alguien habla y quién, según los acontecimientos reales. El modelo escribe las intervenciones importantes (capturas, rachas y victoria); el resto usa el catálogo de frases de cada personaje. Cada respuesta del modelo pasa por un validador que comprueba, entre otras cosas, el idioma, los nombres, el trato de cada personaje, que las cifras y la posición coincidan con la partida real y una lista de expresiones no permitidas.
- **Modelo:** `nvidia/nemotron-3.5-lightning-free` (gratuito), a través de Vercel AI Gateway, con `fetch` desde el servidor.

### Límites y respaldo

- Como mucho **4 llamadas al modelo por minuto** entre jugadas y chat (2 cada uno), compartidas por todas las instancias mediante Upstash Redis.
- **20 consultas de jugadas por partida.**
- Tiempo máximo por llamada de **3 s** en las jugadas y **8 s** en el chat, sin reintentos. Si el proveedor responde con un límite (429), se pausan las llamadas de todos durante el tiempo indicado.
- Ante cualquier límite, error, tiempo agotado o respuesta no válida, se usa la **estrategia local** o la **frase del catálogo**. Sin Upstash no se llama al modelo.

Por estos límites, el modelo decide solo una parte de las jugadas y de las intervenciones de cada partida; la partida nunca se detiene por ello.

## Instalación y ejecución local

**Requisitos:** Node.js 22 y npm, un proyecto de Supabase y, para las pruebas SQL y de Redis, Docker.

```bash
git clone https://github.com/SorayaFernandez/Parchis.git
cd Parchis/web
npm install
cp .env.example .env.local
```

### Variables de entorno

La plantilla completa, con la explicación de cada variable, está en [`web/.env.example`](web/.env.example). Ningún valor de esa plantilla es real.

| Variables | Uso | Necesarias |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Conexión pública a Supabase (lectura y Realtime, limitadas por RLS) | Sí |
| `SUPABASE_SECRET_KEY` | Escritura de partidas y chat, solo en el servidor | Sí |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Límites de peticiones y límite global del modelo (también valen `KV_REST_API_URL` y `KV_REST_API_TOKEN`) | Para límites e IA |
| `RATE_LIMIT_CREATE`, `RATE_LIMIT_ADVANCE_GAME`, `RATE_LIMIT_ADVANCE_IP`, `RATE_LIMIT_READ` | Cambiar los límites por defecto (`<peticiones>/<segundos>`) | No |
| `AI_GATEWAY_API_KEY` | Clave de Vercel AI Gateway | Para IA |
| `CHAT_LLM_ENABLED`, `CHAT_LLM_MODEL`, `CHAT_LLM_PROVIDER` | Chat con modelo de lenguaje | Para IA en el chat |
| `MOVES_LLM_ENABLED`, `MOVES_LLM_MODEL`, `MOVES_LLM_PROVIDER` | Selector de jugadas con modelo de lenguaje | Para IA en las jugadas |

Para jugar en local bastan las tres variables de Supabase: los personajes usan entonces su estrategia y sus frases locales. El chat con modelo puede activarse en local con la clave, sus variables y Upstash. El selector de jugadas solo se activa en Vercel.

### Base de datos

En el editor SQL de un proyecto de Supabase, ejecuta en este orden los dos scripts que necesita la aplicación:

1. `web/supabase/6.1-games.sql`: la tabla `games`, su *trigger* de integridad, RLS y Realtime.
2. `web/supabase/8.2a-chat.sql`: depende de `games`, crea las tablas, la cola, el *trigger* y las funciones del chat, con su RLS y Realtime.

### Comandos

Desde `web/`:

```bash
npm run dev      # desarrollo en http://localhost:3000
npm test         # pruebas (Vitest)
npm run lint     # ESLint
npm run build    # compilación de producción
npm run start    # servir la compilación
```

## Pruebas

```bash
npm test                                          # suite de Vitest
npx tsc --noEmit                                  # comprobación de tipos
bash supabase/tests/run-chat-sql-tests.sh         # SQL en un PostgreSQL (Docker)
bash tests/redis/run-llm-limiter-redis-tests.sh   # límite global de IA contra un Redis 7 real (Docker)
```

Las pruebas cubren:

- **Motor:** reglas, jugadas legales comparadas con una implementación independiente y simulación de partidas completas.
- **Partidas:** concurrencia de avances, reservas, versiones y rutas de la API.
- **IA:** estrategias de los personajes, selector de jugadas con el modelo simulado y respaldo local ante cada tipo de fallo.
- **Chat:** director, cola persistente, coherencia con los hechos reales y validador de las respuestas del modelo.
- **Límites y seguridad:** límites de peticiones, límite global del modelo, protección de los POST y validación de las variables de entorno.
- **Base de datos:** esquema, *triggers*, funciones y permisos, en PostgreSQL.

Los servicios externos (Supabase, AI Gateway y Upstash) se sustituyen por dobles o contenedores locales.

## Despliegue

### Lo que exige el código

- La aplicación está en `web/`, así que en Vercel el **Root Directory** debe ser `web`. No necesita `vercel.json`.
- En Vercel, los modelos de lenguaje solo se activan en los entornos **Preview** y **Production** (`VERCEL_ENV`), con sus variables y Upstash, en Development no. Los límites son los mismos en los dos entornos.
- Las claves del límite global en Upstash no dependen del entorno, porque el límite del modelo gratuito es de todo el equipo. Preview y Production deben usar **la misma base de Upstash**: con bases distintas, cada uno contaría sus propias llamadas y entre los dos podrían superar ese límite.
- Las variables `NEXT_PUBLIC_` se incorporan al compilar, y Vercel solo aplica los cambios de variables a despliegues nuevos: tras cambiarlas, hay que volver a desplegar.
- El chat se procesa después de responder (`after()`), dentro de la misma función. Se recomienda **Fluid compute** para que su duración máxima lo permita, si una ejecución se interrumpe, la siguiente continúa donde se quedó.

### Configuración actual

Esta parte depende de la configuración de Vercel, Supabase y Upstash, no del repositorio:

- **Production** sirve la rama `main` en [parchis-gamma.vercel.app](https://parchis-gamma.vercel.app)
- **Preview** crea un despliegue por cada rama o *pull request*.
- Preview y Production tienen configurada la IA con el modelo gratuito `nvidia/nemotron-3.5-lightning-free`.
- Las variables de Supabase y Upstash se configuran en cada entorno de Vercel.

## Seguridad

- **Credenciales en el servidor:** los módulos que usan claves privadas solo pueden importarse en el servidor. Al navegador solo llegan la URL de Supabase y la clave publicable, limitadas por RLS.
- **Base de datos:** RLS en todas las tablas. `games` y `game_messages` se pueden leer con la clave publicable. Solo el servidor, con la clave secreta (`service_role`), puede escribir en ellas. La cola (`game_chat_queue`) y el estado del chat (`game_chat`) no tienen acceso público, y las funciones del chat solo las ejecuta el servidor.
- **Jugadas validadas:** ninguna jugada, ni de la estrategia local ni del modelo, se aplica sin que el motor la acepte.
- **Entradas y errores:** cuerpos validados con esquemas estrictos, identificadores comprobados antes de consultar la base de datos y errores genéricos sin detalles internos.
- **Protección de los POST:** se rechazan las peticiones de otros sitios y las que no envían JSON.
- **Límites de uso** por IP con Upstash Redis: crear partidas (5 cada 10 minutos), avanzar (180 por minuto por partida y 600 en total) y leer (120 por minuto), además de los límites del modelo descritos en [Límites y respaldo](#límites-y-respaldo).

---

Desarrollado por **Soraya Fernández**.
