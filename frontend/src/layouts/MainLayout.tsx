import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import GlassPanel from "../components/ui/GlassPanel";
import Footer from "../components/ui/Footer";
import { useAuth } from "../context/AuthContext";
import { useTranslation } from "react-i18next";
import LanguageSwitcher from "../i18n/LanguageSwitcher";
import MainBackground from "../components/background/MainBackground";

interface Props {
  children: ReactNode;
}

export default function MainLayout({ children }: Props) {
  const navigate = useNavigate();
  const { logout, user } = useAuth();
  const { t } = useTranslation();
  
  const [isOpen, setIsOpen] = useState(false);

  function handleLogout() {
    logout();
    navigate("/");
  }

  return (
    <div className="min-h-screen bg-bgPrimary text-textPrimary flex flex-col">
      <MainBackground />
        <div className="relative z-20 mx-auto w-full max-w-7xl flex-1 p-4 md:p-6 flex flex-col gap-6">
          <GlassPanel className="p-4 relative">
            <div className="flex justify-between items-center">
              <h1 
                className="text-title font-bold flex items-center gap-2 cursor-pointer text-lg md:text-xl"
                onClick={() => navigate("/lobby")}
              >
                🎮 {t("app.title")}
              </h1>
              <button
                onClick={() => setIsOpen(!isOpen)}
                className="md:hidden flex flex-col gap-1.5 p-2 justify-center items-center w-10 h-10 rounded-lg hover:bg-white/5 transition-all focus:outline-none"
                aria-label={t("accessibility.toggleMenu")}
              >
                <span className={`h-0.5 w-5 bg-black dark:bg-white transition-all duration-300 ${isOpen ? "rotate-45 translate-y-2" : ""}`} />
                <span className={`h-0.5 w-5 bg-black dark:bg-white transition-all duration-300 ${isOpen ? "opacity-0" : ""}`} />
                <span className={`h-0.5 w-5 bg-black dark:bg-white transition-all duration-300 ${isOpen ? "-rotate-45 -translate-y-2" : ""}`} />
              </button>
              <div className="hidden md:flex items-center gap-6">
                <LanguageSwitcher />

                <Link to="/lobby" className="hover:text-purple-300 transition-colors">
                  {t("menu.lobby")}
                </Link>
                <Link to={`/profile/${user?.id}`} className="hover:text-purple-300 transition-colors">
                  {t("menu.profile")}
                </Link>
                <Link to="/friends" className="hover:text-purple-300 transition-colors">
                  {t("menu.friends")}
                </Link>
                <Link to="/friend-requests" className="hover:text-purple-300 transition-colors">
                  {t("menu.requests")}
                </Link>
                <button 
                  onClick={handleLogout}
                  className="rounded-xl bg-red-500/10 px-4 py-1.5 text-red-700 hover:bg-red-500/20 transition-all font-semibold"
                >
                  {t("menu.logout")}
                </button>
              </div>
            </div>
            <div className={`
              /* Estilos de bloque móvil */
              md:hidden flex flex-col gap-3 mt-4 pt-4 border-t border-white/10 text-center transition-all duration-300
              ${isOpen ? "opacity-100 max-h-screen" : "opacity-0 max-h-0 overflow-hidden mt-0 pt-0 border-none"}
            `}>
              <Link 
                to="/lobby" 
                onClick={() => setIsOpen(false)}
                className="py-2 hover:bg-white/5 rounded-lg transition-colors"
              >
                {t("menu.lobby")}
              </Link>
              <Link 
                to={`/profile/${user?.id}`} 
                onClick={() => setIsOpen(false)}
                className="py-2 hover:bg-white/5 rounded-lg transition-colors"
              >
                {t("menu.profile")}
              </Link>
              <Link 
                to="/friends" 
                onClick={() => setIsOpen(false)}
                className="py-2 hover:bg-white/5 rounded-lg transition-colors"
              >
                {t("menu.friends")}
              </Link>
              <Link 
                to="/friend-requests" 
                onClick={() => setIsOpen(false)}
                className="py-2 hover:bg-white/5 rounded-lg transition-colors"
              >
                {t("menu.requests")}
              </Link>
              <button 
                onClick={() => { setIsOpen(false); handleLogout(); }}
                className="w-full py-2.5 mt-2 rounded-xl bg-red-500/10 text-red-200 hover:bg-red-500/20 transition-all font-semibold"
              >
                {t("menu.logout")}
              </button>
            </div>
          </GlassPanel>
          <div className="flex-1 flex flex-col">
            {children}
          </div>

          <Footer />
        </div>
    </div>
  );
}