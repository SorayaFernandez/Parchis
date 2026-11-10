import type {
  ButtonHTMLAttributes,
} from "react";

interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {}

function Button({
  children,
  className = "",
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      className={`
        w-full rounded-glass
        border border-glassBorder
        bg-gradient-to-r
        from-pinkPrimary
        to-purplePrimary
        px-4 py-3
        font-semibold
        text-white
        shadow-glass
        backdrop-blur-xl
        transition-all
        duration-300
        ease-smooth
        hover:scale-[1.02]
        hover:shadow-neon
        active:scale-[0.98]
        ${className}
      `}
    >
      {children}
    </button>
  );
}

export default Button;