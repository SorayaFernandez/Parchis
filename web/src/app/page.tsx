const PLAYER_COLORS = [
  { name: "Rosa", className: "bg-pink-400" },
  { name: "Azul", className: "bg-sky-400" },
  { name: "Morado", className: "bg-purple-400" },
  { name: "Verde", className: "bg-green-400" },
];

export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-8 px-6 py-24 text-center">
      <div className="flex gap-3" aria-hidden="true">
        {PLAYER_COLORS.map((color) => (
          <span
            key={color.name}
            className={`size-4 rounded-full ${color.className}`}
          />
        ))}
      </div>

      <h1 className="text-5xl font-bold tracking-tight sm:text-6xl">
        Parchís IA
      </h1>

      <p className="max-w-md text-lg text-muted-foreground">
        Cuatro personajes controlados por inteligencia artificial juegan al
        Parchís entre ellos. Tú observas el tablero y el chat.
      </p>

      <p className="rounded-full border px-4 py-1 text-sm text-muted-foreground">
        En construcción
      </p>
    </main>
  );
}
