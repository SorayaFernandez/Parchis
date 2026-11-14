import Image from "next/image";
import Link from "next/link";
import { ParchisBoard } from "@/components/board/ParchisBoard";
import { NewGameButton } from "@/components/home/NewGameButton";
import { RivalCards } from "@/components/home/RivalCards";
import { COLOR_HEX } from "@/lib/board/geometry";
import { createDemoMatch } from "@/lib/board/demo";
import { CHARACTERS } from "@/lib/game/characters";

const colorOf = (id: string) => COLOR_HEX[CHARACTERS.find((c) => c.id === id)?.color ?? "pink"];
const nameOf = (id: string) => CHARACTERS.find((c) => c.id === id)?.name ?? id;

/** La llamada a la acción principal: crea una partida real (POST /api/games) y abre /partida/[id]. */
const CTA_BUTTON =
  "h-14 w-full rounded-2xl sm:w-auto border-0 bg-linear-to-r from-[#ff3bd4] via-[#c86cff] to-[#00d9ff] px-8 text-lg font-bold text-slate-950 shadow-[0_0_40px_-8px_rgba(200,108,255,0.9)] transition-transform hover:scale-[1.03] hover:bg-linear-to-r hover:opacity-95";
/** La alternativa: la demostración de /tablero (en el navegador, sin crear nada). */
const DEMO_LINK =
  "inline-flex h-14 items-center justify-center rounded-2xl border border-white/15 bg-white/5 px-6 text-base font-semibold text-slate-100 backdrop-blur transition-colors hover:border-white/30 hover:bg-white/10";

/**
 * Textos de ejemplo que la portada muestra de otra forma (solo aquí: el catálogo, el chat y la demo de
 * /tablero no cambian). La réplica de Abuela Pilar a la captura de Chispa se enseña más directa.
 */
const HOME_TEXT: Readonly<Record<string, string>> = {
  "Bueno, Chispa, mi ficha a casita. No hay mal que por bien no venga.": "Ay, Chispa, me has comido la ficha.",
};

const STEPS = [
  { icon: "/ui/dice-5.svg", title: "Pulsa «Nueva partida»", text: "Se prepara un tablero con los cuatro personajes." },
  { icon: "/ui/dice-3.svg", title: "Ellos juegan", text: "Tiran, deciden cada jugada y se comen fichas con las reglas del parchís." },
  { icon: "/ui/dice-6.svg", title: "Tú miras", text: "Sigue el tablero, las jugadas y su conversación en directo." },
];

/**
 * Portada. Estática: la partida que se ve en el tablero es la de la demostración (semilla fija), calculada
 * al prerenderizar con el motor, la IA y el chat local reales. Las dos llamadas a la acción son reales:
 * «Nueva partida» (partida guardada que juegan los cuatro personajes) y la demostración de /tablero.
 */
export default async function Home() {
  const match = await createDemoMatch();
  // Dos comentarios reales de esa partida, para enseñar el chat: los más recientes de dos personajes distintos.
  const bubbles = [...match.messages]
    .reverse()
    .filter((m, i, all) => all.findIndex((o) => o.characterId === m.characterId) === i)
    .slice(0, 2)
    .reverse()
    .map((m) => ({ ...m, text: HOME_TEXT[m.text] ?? m.text }));

  return (
    <main className="dark relative isolate flex flex-1 flex-col overflow-hidden bg-[#020617] text-slate-100">
      {/* Fondo: los cuatro colores en las esquinas, como las casas del tablero, y una retícula de circuito. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute -top-40 -left-40 size-[36rem] rounded-full bg-[#ff3bd4] opacity-[0.16] blur-[120px]" />
        <div className="absolute -top-40 -right-40 size-[36rem] rounded-full bg-[#00ff9d] opacity-[0.12] blur-[120px]" />
        <div className="absolute top-[55%] -left-48 size-[36rem] rounded-full bg-[#00d9ff] opacity-[0.12] blur-[120px]" />
        <div className="absolute top-[45%] -right-48 size-[36rem] rounded-full bg-[#c86cff] opacity-[0.14] blur-[120px]" />
        <div
          className="absolute inset-0 opacity-40 [mask-image:radial-gradient(ellipse_at_top,black_20%,transparent_70%)]"
          style={{
            backgroundImage:
              "linear-gradient(rgba(148,163,184,0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(148,163,184,0.08) 1px, transparent 1px)",
            backgroundSize: "48px 48px",
          }}
        />
      </div>

      <header className="mx-auto flex w-full max-w-7xl items-center justify-between gap-4 px-4 py-5 sm:px-6">
        <span className="flex items-center gap-3 text-lg font-bold tracking-tight">
          <span aria-hidden="true" className="grid grid-cols-2 gap-1">
            {["#ff3bd4", "#00ff9d", "#00d9ff", "#c86cff"].map((c) => (
              <span key={c} className="size-2.5 rounded-full" style={{ backgroundColor: c, boxShadow: `0 0 10px ${c}` }} />
            ))}
          </span>
          Parchís IA
        </span>
        <Link href="/tablero" className="text-sm font-medium text-slate-300 transition-colors hover:text-white">
          Demostración
        </Link>
      </header>

      {/* ── Portada: qué es, cómo empezar y el tablero en juego ── */}
      <section className="mx-auto grid w-full max-w-7xl items-center gap-12 px-4 pt-6 pb-16 sm:px-6 lg:grid-cols-[1.05fr_1fr] lg:gap-16 lg:pt-12 lg:pb-24">
        <div className="flex flex-col items-center text-center lg:items-start lg:text-left">
          <p className="mb-5 rounded-full border border-white/15 bg-white/5 px-4 py-1.5 text-sm font-medium text-slate-300 backdrop-blur">
            Parchís con cuatro rivales de inteligencia artificial
          </p>
          <h1 className="text-5xl font-black tracking-tight sm:text-6xl xl:text-7xl">
            <span className="bg-linear-to-r from-[#ff3bd4] via-[#c86cff] to-[#00d9ff] bg-clip-text text-transparent">Parchís IA</span>
          </h1>
          <p className="mt-5 text-2xl font-semibold text-slate-100 sm:text-3xl">Ellos juegan. Tú miras.</p>
          <p className="mt-4 max-w-xl text-lg leading-relaxed text-slate-300">
            Brava, Don Ernesto, Abuela Pilar y Chispa tiran el dado, deciden cada jugada y se pican en el chat. Cuatro personalidades,
            una partida entera entre ellos.
          </p>

          <div className="mt-9 flex w-full flex-col items-center gap-4 sm:flex-row sm:items-start sm:justify-center lg:justify-start">
            <NewGameButton className="w-full sm:w-auto lg:items-start" buttonClassName={CTA_BUTTON} />
            <Link href="/tablero" className={`${DEMO_LINK} w-full sm:w-auto`}>
              Ver una partida de demostración
            </Link>
          </div>

          <ul className="mt-6 flex flex-wrap justify-center gap-x-5 gap-y-2 text-sm text-slate-400 lg:justify-start">
            {["Partida en directo", "Chat entre personajes", "Sin registro"].map((item) => (
              <li key={item} className="flex items-center gap-2">
                <span aria-hidden="true" className="size-1.5 rounded-full bg-[#00ff9d]" />
                {item}
              </li>
            ))}
          </ul>
        </div>

        {/* El tablero real con una partida real (la de la demostración) y dos comentarios de su chat. */}
        <figure className="relative mx-auto w-full max-w-[34rem]">
          <div
            aria-hidden="true"
            className="absolute -inset-6 -z-10 rounded-[3rem] bg-linear-to-br from-[#ff3bd4]/30 via-[#c86cff]/20 to-[#00d9ff]/30 blur-2xl"
          />
          <div className="rounded-[2rem] border border-white/10 bg-slate-950/70 p-2 shadow-2xl ring-1 ring-white/5 backdrop-blur">
            <ParchisBoard state={match.state} />
          </div>
          <figcaption className="sr-only">Una partida entre los cuatro personajes, a mitad de juego.</figcaption>
          <div className="mt-4 flex flex-col gap-2 sm:absolute sm:inset-x-0 sm:-bottom-10 sm:mt-0 sm:px-6 lg:-left-10 lg:right-auto lg:max-w-xs lg:px-0">
            {bubbles.map((m) => (
              <p
                key={m.id}
                className="rounded-2xl border border-white/10 border-l-2 bg-slate-950/90 px-4 py-2.5 text-sm shadow-xl backdrop-blur"
                style={{ borderLeftColor: colorOf(m.characterId) }}
              >
                <span className="block text-xs font-semibold" style={{ color: colorOf(m.characterId) }}>
                  {nameOf(m.characterId)}
                </span>
                {m.text}
              </p>
            ))}
          </div>
        </figure>
      </section>

      {/* ── Los cuatro rivales ── */}
      <section aria-labelledby="rivales" className="mx-auto w-full max-w-7xl px-4 py-16 sm:px-6 lg:py-20">
        <div className="mb-10 text-center">
          <h2 id="rivales" className="text-3xl font-bold tracking-tight sm:text-4xl">
            Cuatro rivales, cuatro maneras de jugar
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-slate-400">
            No son simples avatares: cada uno decide sus jugadas con su propia estrategia y comenta la partida a su manera.
          </p>
        </div>
        <RivalCards />
      </section>

      {/* ── Cómo funciona ── */}
      <section aria-labelledby="como-funciona" className="mx-auto w-full max-w-7xl px-4 py-16 sm:px-6">
        <h2 id="como-funciona" className="mb-10 text-center text-3xl font-bold tracking-tight sm:text-4xl">
          Cómo funciona
        </h2>
        <ol className="grid gap-4 md:grid-cols-3">
          {STEPS.map((step, i) => (
            <li key={step.title} className="flex items-start gap-4 rounded-3xl border border-white/10 bg-white/[0.03] p-6">
              <Image src={step.icon} alt="" width={56} height={56} unoptimized className="size-12 shrink-0" />
              <div>
                <p className="text-xs font-semibold tracking-widest text-slate-500 uppercase">Paso {i + 1}</p>
                <h3 className="mt-1 text-lg font-bold">{step.title}</h3>
                <p className="mt-1 text-sm leading-relaxed text-slate-400">{step.text}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {/* ── Cierre: volver a invitar a jugar ── */}
      <section className="mx-auto w-full max-w-7xl px-4 pt-8 pb-20 sm:px-6">
        <div className="relative overflow-hidden rounded-[2rem] border border-white/10 bg-slate-950/70 px-6 py-12 text-center sm:px-12">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 -z-10 bg-linear-to-r from-[#ff3bd4]/15 via-[#c86cff]/10 to-[#00d9ff]/15"
          />
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">¿Quién ganará esta vez?</h2>
          <p className="mx-auto mt-3 max-w-xl text-slate-300">Cada partida es distinta: el dado, las decisiones y los comentarios cambian.</p>
          <div className="mt-8 flex flex-col items-center gap-4 sm:flex-row sm:items-start sm:justify-center">
            <NewGameButton className="w-full sm:w-auto" buttonClassName={CTA_BUTTON} />
            <Link href="/tablero" className={`${DEMO_LINK} w-full sm:w-auto`}>
              Ver una partida de demostración
            </Link>
          </div>
        </div>
      </section>

      <footer className="border-t border-white/10 py-6 text-center text-sm text-slate-500">Parchís IA</footer>
    </main>
  );
}
