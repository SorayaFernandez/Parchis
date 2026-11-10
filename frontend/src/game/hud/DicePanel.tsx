import { motion } from "framer-motion";

export default function DicePanel({ game, onRoll, rolling,isSpectator,}: any) {
  const dice = game.dice || 1;

  return (
    <div className="
      glass-panel
      rounded-3xl
      p-6
      flex
      flex-col
      items-center
      justify-center
      gap-4
    ">
      <motion.img
        key={dice}
        src={`/ui/dice-${dice}.svg`}
        className="w-28 h-28 object-contain"
        initial={{
          rotate: -180,
          scale: 0.4,
          opacity: 0
        }}
        animate={
          rolling
            ? {
                rotate: [0, -25, 25, -15, 15, 0],
                scale: [1, 1.25, 1],
              }
            : {
                rotate: 0,
                scale: 1,
                opacity: 1,
              }
        }
        transition={{
          duration: .6,
          type: "spring"
        }}
      />

      {game.pendingBonus && (
        <span className="text-2xl font-bold text-yellow-400 animate-pulse">
          +{game.pendingBonus}
        </span>
      )}

      <button
        disabled={isSpectator || game.pendingBonus != null}
        onClick={onRoll}
        className={`
          w-full
          rounded-2xl
          px-6
          py-4
          font-bold
          transition-all
          duration-200
          text-sm
          ${
            isSpectator || game.pendingBonus != null
              ? "bg-gray-600/50 text-white/40 cursor-not-allowed"
              : `
                bg-gradient-to-r
                from-pink-400
                to-purple-400
                text-white
                shadow-lg
                shadow-purple-500/20
                hover:brightness-110
                active:scale-95
              `
          }
        `}
      >
        {isSpectator ? "Spectating" : "Roll Dice"}
      </button>

    </div>
  );
}