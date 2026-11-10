
export default function GameBoard() {
  return (
    <div className="absolute inset-0">

      {/* BASE */}
      <img
        src="/board/board-base.svg"
        className="
          absolute inset-0
          w-full h-full
          object-contain
          select-none
          pointer-events-none
        "
      />

        <img
        src="/board/board-path.svg"
        className="
          absolute inset-0
          w-full h-full
          object-contain
          opacity-90
          pointer-events-none
        "
      />

      {/* GLOW */}
      <img
        src="/board/board-glow.svg"
        className="
          absolute inset-0
          w-full h-full
          object-contain
          opacity-90
          mix-blend-screen
          pointer-events-none
        "
      />

      <img
        src="/board/board-effects.svg"
        className="
          absolute inset-0
          w-full h-full
          object-contain
          opacity-90
          mix-blend-screen
          pointer-events-none
        "
      />

      <img
        src="/board/board-home-paths.svg"
        className="
          absolute inset-0
          w-full h-full
          object-contain
          opacity-50
          pointer-events-none
        "
      />

    </div>
  );
}