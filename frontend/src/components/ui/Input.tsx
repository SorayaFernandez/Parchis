import type {
  InputHTMLAttributes,
} from "react";

interface InputProps
  extends InputHTMLAttributes<HTMLInputElement> {}

function Input({
  className = "",
  ...props
}: InputProps) {
  return (
    <input
      {...props}
      className={`
        w-full rounded-glass
        border border-glassBorder
        bg-glass
        px-4 py-3
        text-textPrimary
        outline-none
        backdrop-blur-xl
        transition-all
        duration-300
        placeholder:text-textSecondary
        focus:shadow-neon
        focus:ring-2
        focus:ring-pinkPrimary
        ${className}
      `}
    />
  );
}

export default Input;