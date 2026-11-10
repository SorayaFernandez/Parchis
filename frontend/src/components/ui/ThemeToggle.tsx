import { Moon, Sun } from "lucide-react";

import { useTheme } from "../../theme/ThemeProvider";

function ThemeToggle() {
  const {
    theme,
    toggleTheme,
  } = useTheme();

  return (
    <button
      onClick={toggleTheme}
      className="
        flex items-center justify-center
        rounded-full
        border border-glassBorder
        bg-glass
        p-3
        text-textPrimary
        backdrop-blur-xl
        transition-all
        hover:scale-105
        hover:shadow-neon
      "
    >
      {theme === "light" ? (
        <Moon size={20} />
      ) : (
        <Sun size={20} />
      )}
    </button>
  );
}

export default ThemeToggle;