export default function AuthBackground() {
  return (
    <>
      {/* Halo superior izquierdo */}
      <div
        className="
          absolute
          -top-40
          -left-40
          h-96
          w-96
          rounded-full
          bg-pink-500/10
          blur-3xl
          animate-floatSlow
        "
      />

      {/* Halo inferior derecho */}
      <div
        className="
          absolute
          -bottom-40
          -right-40
          h-[30rem]
          w-[30rem]
          rounded-full
          bg-purple-600/10
          blur-3xl
          animate-floatSlow
        "
      />

      {/* Columna izquierda */}
      <div className="pointer-events-none absolute inset-y-0 left-6 hidden lg:flex flex-col justify-evenly opacity-20">
        <img src="/decor/trophy.svg" className="w-24 animate-float" />
        <img src="/decor/dice.svg" className="w-20 animate-spinSlow" />
        <img src="/decor/controller.svg" className="w-28 animate-floatDelay" />
        <img src="/decor/piece.svg" className="w-20 animate-float" />
      </div>

      {/* Columna derecha */}
      <div className="pointer-events-none absolute inset-y-0 right-6 hidden lg:flex flex-col justify-evenly opacity-20">
        <img src="/decor/controller.svg" className="w-28 animate-floatDelay" />
        <img src="/decor/piece.svg" className="w-22 animate-float" />
        <img src="/decor/dice.svg" className="w-20 animate-spinSlow" />
        <img src="/decor/trophy.svg" className="w-24 animate-float" />
      </div>

      {/* Parte superior */}
      <div className="pointer-events-none absolute top-8 left-1/2 -translate-x-1/2 flex gap-12 opacity-15">
        <img src="/decor/trophy.svg" className="w-16 animate-spinSlow" />
        <img src="/decor/dice.svg" className="w-16 animate-float" />
        <img src="/decor/controller.svg" className="w-20 animate-floatDelay" />
      </div>

    </>
  );
}