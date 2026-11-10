import PlayersPanel from "./PlayersPanel";
import ChatPanel from "./ChatPanel";
import DicePanel from "./DicePanel";
import { useState } from "react";
import { useTranslation } from "react-i18next";

export default function GameHUD({ game, onRoll, rolling, isSpectator,}: any) {
  const [isOpen, setIsOpen] = useState(false);
  const { t } = useTranslation();

  return (
    <>
      <button 
        onClick={() => setIsOpen(!isOpen)}
        className="
          md:hidden
          fixed bottom-6 right-6 z-[60] 
          flex items-center justify-center 
          w-14 h-14 
          rounded-full bg-purple-600 border border-white/20
          shadow-2xl shadow-purple-500/50
          text-white font-bold text-lg
          transition-all duration-200
          active:scale-95 
        "
      >
        {isOpen ? "✕" : "💬"}
      </button>

      {isOpen && (
        <div 
          onClick={() => setIsOpen(false)} 
          className="md:hidden fixed inset-0 bg-black/60 backdrop-blur-sm z-40" 
        />
      )}

      <div className={`
        /* Móvil: se convierte en menú lateral deslizable */
        fixed top-0 right-0 h-full w-[300px]
        bg-slate-950/95 backdrop-blur-2xl p-5
        flex flex-col gap-4 z-50
        border-l border-white/10
        transition-transform duration-300 ease-in-out
        ${isOpen ? "translate-x-0" : "translate-x-full"}

        /* Escritorio: desactiva los estilos de menú lateral */
        md:fixed
        md:right-[20px]
        md:top-1/2
        md:-translate-y-1/2
        md:w-[290px]
        md:h-[62vh]
        md:bg-transparent
        md:backdrop-blur-none
        md:p-0
        md:border-none
        md:translate-x-0
      `}>

        <div className="flex md:hidden items-center justify-between border-b border-white/10 pb-3">
          <span className="font-bold text-sm tracking-wider text-purple-400 uppercase">
              {t("game.hud.panel")}
          </span>
          <button 
            onClick={() => setIsOpen(false)}
            className="text-xs bg-white/10 px-2 py-1 rounded-lg text-white/60"
          >
            {t("game.hud.close")}
          </button>
        </div>

        <div className="flex-1 min-h-0 flex flex-col gap-4 overflow-y-auto md:overflow-visible">
          <PlayersPanel game={game} />
          <DicePanel
            game={game}
            onRoll={onRoll}
            rolling={rolling}
            isSpectator={isSpectator}
          />
          <ChatPanel game={game} />
        </div>
      </div>
    </>
  ); 
}
