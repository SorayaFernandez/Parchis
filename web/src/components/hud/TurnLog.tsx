import { cn } from "@/lib/utils";

export interface TurnLogEntry {
  id: number;
  text: string;
}

interface TurnLogProps {
  entries: readonly TurnLogEntry[];
  /** Título del panel (por defecto "Últimas jugadas"). */
  title?: string;
  /** Línea opcional bajo el título (p. ej. la acción que produjo los eventos). */
  description?: string | null;
  /** Texto cuando no hay entradas. */
  emptyText?: string;
  className?: string;
  /** Clases extra de la lista (p. ej., scroll propio cuando el panel tiene un alto limitado). */
  listClassName?: string;
}

/** Jugadas o eventos (los más recientes arriba). No es el chat: solo describe eventos del motor. */
export function TurnLog({
  entries,
  title = "Últimas jugadas",
  description = null,
  emptyText = "Todavía no hay jugadas.",
  className,
  listClassName,
}: TurnLogProps) {
  return (
    <section aria-label={title} className={cn("rounded-2xl border border-white/10 bg-white/5 p-4", className)}>
      <h2 className="text-xs font-medium tracking-widest text-slate-400 uppercase">{title}</h2>
      {description && <p className="mt-1 text-sm text-slate-300">{description}</p>}
      {entries.length === 0 ? (
        <p className="mt-2 text-sm text-slate-500">{emptyText}</p>
      ) : (
        <ol className={cn("mt-2 space-y-1 text-sm", listClassName)}>
          {entries.map((entry, i) => (
            <li key={entry.id} className={cn(i === 0 ? "text-slate-100" : "text-slate-400")}>
              {entry.text}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
