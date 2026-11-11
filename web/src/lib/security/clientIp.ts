// Identificación del cliente para los límites de peticiones.
// En Vercel, `x-forwarded-for` / `x-real-ip` / `x-vercel-forwarded-for` los fija la plataforma
// (sobrescribe los que envía el cliente: no se pueden falsificar). Fuera de Vercel (desarrollo
// local) esas cabeceras las puede inventar cualquiera, así que NO se usan: todo es "local".

import { isIP } from "node:net";

export interface ClientIdentity {
  /** IP normalizada (IPv6 agrupada por /64), "local" fuera de Vercel o "unknown". */
  key: string;
  /** La clave procede de una cabecera fiable de la plataforma. */
  trusted: boolean;
}

type Env = Readonly<Record<string, string | undefined>>;

/** Orden de preferencia: x-vercel-forwarded-for sigue siendo fiable aunque haya otro proxy delante. */
const HEADERS = ["x-vercel-forwarded-for", "x-real-ip", "x-forwarded-for"] as const;

export function getClientIdentity(headers: Headers, env: Env = process.env): ClientIdentity {
  if (env.VERCEL !== "1") return { key: "local", trusted: false };

  for (const name of HEADERS) {
    // Puede ser una lista ("cliente, proxy1, …"): el primero es el cliente.
    const first = headers.get(name)?.split(",")[0]?.trim();
    const ip = first ? normalizeIp(first) : null;
    if (ip) return { key: ip, trusted: true };
  }
  return { key: "unknown", trusted: false };
}

/** IPv4 tal cual; IPv4 mapeada en IPv6 → IPv4; IPv6 → prefijo /64. `null` si no es una IP. */
export function normalizeIp(value: string): string | null {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
  if (mapped && isIP(mapped[1]) === 4) return mapped[1];
  const version = isIP(value);
  if (version === 4) return value;
  if (version === 6) return `${expandIpv6(value).slice(0, 4).join(":")}::/64`;
  return null;
}

/** Ocho grupos hexadecimales de 4 dígitos (sin compresión "::" ni zona "%eth0"). */
function expandIpv6(value: string): string[] {
  const address = value.split("%")[0].toLowerCase();
  const [head, tail] = address.includes("::") ? address.split("::") : [address, null];
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const missing = 8 - left.length - right.length;
  const groups = tail === null ? left : [...left, ...Array(missing).fill("0"), ...right];
  return groups.map((g) => g.padStart(4, "0"));
}
