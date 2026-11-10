import type { ReactNode } from "react";

import ThemeToggle from "../components/ui/ThemeToggle";
import LanguageSwitcher from "../i18n/LanguageSwitcher";
import Footer from "../components/ui/Footer";
import AuthBackground from "../components/background/AuthBackground";

interface AuthLayoutProps {
  children: ReactNode;
}

function AuthLayout({
  children,
}: AuthLayoutProps) {
  return (
    <div
      className="
        relative
        flex
        min-h-screen
        flex-col
        items-center
        justify-center
        overflow-hidden
        bg-gradient-to-br
        from-bgPrimary
        via-bgSecondary
        to-bgPrimary
        px-6
        py-10
      "
    >
      {/* Fondo decorativo */}
      <AuthBackground />

      {/* Capa oscura para mejorar la legibilidad */}
      <div className="absolute inset-0 bg-black/5 pointer-events-none z-10" />

      {/* Controles superiores */}
      <div className="absolute top-6 right-6 z-40 flex items-center gap-3">
        <LanguageSwitcher />
        <ThemeToggle />
      </div>

      {/* Contenido principal */}
      <main className="relative z-30 flex flex-1 w-full items-center justify-center">
        <div
          className="
            glass-panel
            relative
            w-full
            max-w-md
            rounded-glass
            p-8
            shadow-glass
            backdrop-blur-xl
          "
        >
          {children}
        </div>
      </main>

      {/* Footer */}
      <footer className="relative z-30 w-full max-w-5xl mt-6">
        <Footer />
      </footer>
    </div>
  );
}

export default AuthLayout;