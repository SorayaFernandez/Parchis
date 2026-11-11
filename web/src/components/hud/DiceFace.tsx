import Image from "next/image";
import { cn } from "@/lib/utils";

interface DiceFaceProps {
  value: number | null;
  /** Cambia en cada tirada para reiniciar la animación. */
  rollKey?: number;
  /** Atenuado cuando el valor ya se ha usado. */
  dimmed?: boolean;
  className?: string;
}

/** Cara del dado con los SVG del original (frontend/public/ui/dice-N.svg). */
export function DiceFace({ value, rollKey = 0, dimmed = false, className }: DiceFaceProps) {
  if (value === null) {
    return (
      <div
        role="img"
        aria-label="Sin tirada"
        className={cn(
          "grid aspect-square place-items-center rounded-2xl border-2 border-dashed border-white/15 text-2xl text-white/30",
          className,
        )}
      >
        ?
      </div>
    );
  }

  return (
    <Image
      key={rollKey}
      src={`/ui/dice-${value}.svg`}
      alt={`Dado: ${value}`}
      width={512}
      height={512}
      unoptimized
      className={cn(
        "aspect-square h-auto motion-safe:animate-dice-roll transition-opacity",
        dimmed && "opacity-50",
        className,
      )}
    />
  );
}
