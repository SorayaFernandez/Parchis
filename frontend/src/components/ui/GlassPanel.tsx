import type { ReactNode } from "react";
import clsx from "clsx";

interface Props {
  children: ReactNode;
  className?: string;
}

export default function GlassPanel({
  children,
  className,
}: Props) {
  return (
    <div
      className={clsx(
        "rounded-glass border border-glassBorder bg-glass backdrop-blur-xl shadow-glass",
        className
      )}
    >
      {children}
    </div>
  );
}