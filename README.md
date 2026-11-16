# Parchís IA

**Un Parchís online con cuatro jugadores controlados por inteligencia artificial, personalidades propias y chat contextual.**

🌐 **Demo:** [https://parchis-gamma.vercel.app](https://parchis-gamma.vercel.app)

## Descripción

Parchís IA es una aplicación web que recrea el clásico juego del Parchís y permite jugar partidas con cuatro personajes controlados por inteligencia artificial.

Cada personaje tiene una personalidad y una forma de comunicarse diferente. La IA puede intervenir en las decisiones de movimiento y en las conversaciones, teniendo en cuenta el estado de la partida y los acontecimientos recientes.

El proyecto está desarrollado con Next.js y desplegado en Vercel. Utiliza Supabase para la persistencia y sincronización de las partidas, y Vercel AI Gateway para integrar modelos de lenguaje sin exponer las credenciales en el navegador.

## Personajes

| Personaje | Color | Personalidad |
|---|---|---|
| Brava | Rosa | Agresiva y competitiva |
| Don Ernesto | Morado | Estratégico y formal |
| Abuela Pilar | Verde | Prudente y cercana |
| Chispa | Azul | Imprevisible y espontáneo |

Cada personaje cuenta con un estilo de comunicación propio. El chat tiene en cuenta los acontecimientos de la partida para generar intervenciones coherentes con el contexto.

## Tecnologías

- **Next.js** — Framework de React y renderizado del lado del servidor.
- **React y TypeScript** — Interfaz y lógica tipada.
- **Tailwind CSS** — Estilos y diseño adaptable.
- **shadcn/ui** — Componentes de interfaz.
- **Supabase** — PostgreSQL, persistencia y sincronización en tiempo real mediante Realtime.
- **Vercel AI Gateway** — Integración con modelos de inteligencia artificial.
- **Upstash Redis** — Control distribuido de peticiones y cuotas.
- **Vercel** — Despliegue y alojamiento.

## Arquitectura

### Motor de juego

El motor está implementado en TypeScript y separado de la interfaz y de los servicios externos.

- Calcula los movimientos legales.
- Comprueba las reglas antes de aplicar cualquier movimiento.
- Gestiona las posiciones de las fichas, capturas, salidas y llegadas a meta.
- Mantiene la lógica de juego independiente de las respuestas del modelo de IA.

### Integración con inteligencia artificial

Los personajes pueden utilizar modelos de lenguaje mediante Vercel AI Gateway.

El sistema proporciona información contextual de la partida para que la IA pueda tomar decisiones y generar mensajes relacionados con lo que está sucediendo.

En los movimientos, el modelo selecciona entre las opciones legales disponibles. El servidor vuelve a validar la elección y aplica el movimiento, evitando que el modelo pueda modificar directamente el estado del juego.

La integración también contempla respuestas locales cuando una respuesta del modelo no es válida o el servicio no está disponible.

### Chat contextual

Los mensajes tienen en cuenta los acontecimientos de la partida y las intervenciones recientes.

Se aplican validaciones para evitar afirmaciones incompatibles con el estado del juego, expresiones no deseadas y mensajes que no respeten la personalidad de cada personaje.

### Persistencia y sincronización

Supabase almacena el estado de las partidas y permite sincronizar los cambios entre clientes mediante Realtime.

La gestión de turnos y eventos utiliza marcas temporales persistidas, evitando depender exclusivamente de temporizadores en memoria.

### Seguridad

La arquitectura mantiene las operaciones sensibles en el servidor:

- Las claves privadas de los servicios externos no se exponen al navegador.
- El servidor valida las peticiones y los movimientos.
- Se aplican controles de origen y formato en las operaciones POST.
- Upstash Redis permite aplicar límites distribuidos de peticiones y cuotas.
- Las operaciones sobre partidas incorporan mecanismos de control de concurrencia.

## Renderizado y despliegue

La aplicación utiliza Next.js App Router y renderizado del lado del servidor para las operaciones que necesitan acceso seguro a información y servicios privados.

El proyecto está desplegado en Vercel y utiliza entornos independientes de Preview y Production.

La integración generativa con AI Gateway está habilitada en Preview para pruebas. En la configuración actual, la IA generativa está desactivada en Production.

## Ejecución local

### Requisitos

- Node.js.
- npm.
- Un proyecto de Supabase configurado.
- Credenciales de Supabase con los permisos necesarios.

### Instalación

Clona el repositorio:

```bash
git clone https://github.com/SorayaFernandez/Parchis.git
cd Parchis/web
```

Instala las dependencias:

```bash
npm install
```

Crea un archivo `.env.local` a partir de `.env.example` y configura las variables necesarias para el entorno local.

Variables principales:

```env
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
SUPABASE_SECRET_KEY=
```

Las variables relacionadas con AI Gateway y Redis son necesarias únicamente para los servicios que se quieran habilitar en el entorno local.

**Importante:** las claves privadas deben permanecer en variables de entorno del servidor. Nunca deben incluirse en variables `NEXT_PUBLIC_` ni subirse al repositorio.

### Iniciar la aplicación

```bash
npm run dev
```

Abre [http://localhost:3000](http://localhost:3000) en el navegador.

## Pruebas y validación

El proyecto dispone de pruebas automatizadas para comprobar la lógica del juego, las rutas API, la integración con los servicios, las validaciones del chat y los mecanismos de seguridad.

Ejecutar la suite:

```bash
npx vitest run --maxWorkers=2
```

Comprobar TypeScript:

```bash
npx tsc --noEmit
```

Comprobar la compilación de producción:

```bash
npm run build
```

Las pruebas de integración que requieren servicios externos, como Redis real, se ejecutan mediante sus scripts específicos.

## Estado del proyecto

Proyecto desplegado en Vercel, con integración de Supabase, sincronización de partidas, motor de juego en TypeScript y personajes con personalidades diferenciadas.

La integración con modelos de IA se prueba en Preview antes de habilitarla en Production.

---

**Desarrollado por Soraya Fernández.**