export default function MainBackground() {
  return (
    <>
      {/* ================= HALOS ================= */}

      <div
        className="
          absolute
          -top-52
          -left-52
          h-[34rem]
          w-[34rem]
          rounded-full
          bg-pink-500/10
          blur-3xl
          animate-floatSlow
        "
      />

      <div
        className="
          absolute
          -bottom-56
          -right-52
          h-[36rem]
          w-[36rem]
          rounded-full
          bg-purple-600/10
          blur-3xl
          animate-floatSlow
        "
      />

      <div
        className="
          absolute
          top-1/3
          -left-32
          h-72
          w-72
          rounded-full
          bg-blue-500/10
          blur-3xl
          animate-float
        "
      />

      <div
        className="
          absolute
          bottom-1/4
          -right-32
          h-72
          w-72
          rounded-full
          bg-green-500/10
          blur-3xl
          animate-floatDelay
        "
      />


      {/* ================= PARTE CENTRAL ================= */}

      <img
        src="/decor/friends.svg"
        className="
          pointer-events-none
          absolute
          left-1/2
          top-1/2
          w-[550px]
          -translate-x-1/2
          -translate-y-1/2
          opacity-10
          animate-floatSlow
        "
        alt=""
      />

      {/* ================= LATERAL IZQUIERDO ================= */}

      <div
        className="
          pointer-events-none
          absolute
          left-8
          inset-y-0
          hidden
          xl:flex
          flex-col
          justify-evenly
          opacity-25
        "
      >
        <img src="/decor/trophy.svg" className="w-24 animate-float" alt="" />
        <img src="/decor/dice.svg" className="w-20 animate-spinSlow" alt="" />
        <img src="/decor/piece.svg" className="w-24 animate-floatDelay" alt="" />
        <img src="/decor/friends.svg" className="w-24 animate-float" alt="" />
        <img src="/decor/controller.svg" className="w-28 animate-floatSlow" alt="" />
      </div>

      {/* ================= LATERAL DERECHO ================= */}

      <div
        className="
          pointer-events-none
          absolute
          right-8
          inset-y-0
          hidden
          xl:flex
          flex-col
          justify-evenly
          opacity-25
        "
      >
        <img src="/decor/controller.svg" className="w-28 animate-float" alt="" />
        <img src="/decor/piece.svg" className="w-24 animate-floatDelay" alt="" />
        <img src="/decor/dice.svg" className="w-20 animate-spinSlow" alt="" />
        <img src="/decor/friends.svg" className="w-24 animate-float" alt="" />
        <img src="/decor/trophy.svg" className="w-20 animate-floatSlow" alt="" />
      </div>

    </>
  );
}