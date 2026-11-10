import Confetti from "react-confetti";
import { motion } from "framer-motion";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

type Props = {
  winnerName: string;
  won: boolean;
  isSpectator: boolean;
  onClose: () => void;
};

export default function VictoryAnimation({
  winnerName,
  won,
  isSpectator,
  onClose,
}: Props) {
  const { t } = useTranslation();

	const [windowSize, setWindowSize] = useState({
		width: window.innerWidth,
		height: window.innerHeight,
	});

	useEffect(() => {
	const handleResize = () => {
		setWindowSize({
			width: window.innerWidth,
			height: window.innerHeight,
		});
	};

	window.addEventListener("resize", handleResize);

	return () => {
		window.removeEventListener("resize", handleResize);
	};
	}, []);
	
  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black-950/80 backdrop-blur-sm">

      <Confetti
        width={windowSize.width}
  		height={windowSize.height}
        recycle={false}
        numberOfPieces={500}
        colors={[
          "#ffffff",
          "#c084fc",
          "#9333ea",
          "#60a5fa",
          "#22c55e",
          "#f472b6",
        ]}
      />

      <motion.div
        initial={{
          opacity: 0,
          scale: 0.85,
        }}
        animate={{
          opacity: 1,
          scale: 1,
        }}
        transition={{
          duration: 0.45,
        }}
        className="
          relative
          rounded-3xl
          border border-white/10
          bg-slate-900/90
          backdrop-blur-xl
          p-10
          w-[90%]
          max-w-lg
          shadow-2xl
          text-center
        "
      >

        <div className="absolute inset-0 rounded-3xl bg-gradient-to-r from-purple-500/20 to-pink-500/20 blur-3xl" />

        <div className="relative">

          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{
              delay: 0.2,
              type: "spring",
              stiffness: 180,
            }}
            className="text-7xl mb-5"
          >
            {won ? "🏆" : "🎮"}
          </motion.div>

          <h1 className="text-5xl font-extrabold text-purple-400 mb-3">
            {won
              ? t("victory.titleVictory")
              : isSpectator
                ? t("victory.titleWinner")
                : t("victory.titleGameOver")}
          </h1>

          <p className="text-white/70 mb-2">
            {won
              ? t("victory.congratulations")
              : t("victory.winnerIs")}
          </p>

          <p className="text-xl font-bold text-white mb-8">
            {winnerName}
          </p>

          <button
            onClick={onClose}
            className="
              rounded-2xl
              bg-purple-600
              hover:bg-purple-700
              transition
              px-8
              py-3
              font-bold
            "
          >
            {t("victory.returnLobby")}
          </button>

        </div>

      </motion.div>

    </div>
  );
}