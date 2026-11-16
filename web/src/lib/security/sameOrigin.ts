// Protección contra peticiones de otros sitios (CSRF) en los POST de la API.
//
// Sin ella, una página ajena podría hacer que los navegadores de sus visitantes creen o hagan avanzar
// partidas, cada uno con su IP (saltándose el límite por IP). Tres comprobaciones, en este orden:
// 1. `Sec-Fetch-Site: cross-site` (lo envían los navegadores modernos) → 403. `same-origin`, `same-site`
//    y `none` (navegación directa) pasan a la comprobación del origen; sin la cabecera (clientes que no
//    son navegadores, navegadores antiguos), también.
// 2. `Origin`, si viene, debe ser el de la propia aplicación: su host igual al de la petición (`Host`,
//    `X-Forwarded-Host` o el de la URL). Un `Origin` ajeno, `null` (iframe aislado, `data:`) o mal formado
//    → 403. Sin `Origin` (clientes que no son navegadores) se acepta: un navegador lo envía siempre en
//    un POST de otro origen.
// 3. `Content-Type: application/json` (con o sin parámetros, p. ej. `; charset=utf-8`) → si no, 415. Un
//    formulario o un `fetch` "simple" de otro sitio no puede enviar ese tipo sin una petición previa de
//    CORS, que la aplicación no autoriza.
// Las respuestas son genéricas, como las del resto de la API (`errorResponse`, `no-store`).

import { errorResponse } from "@/lib/http/responses";

/** Hosts (host[:puerto], en minúsculas) con los que se ha recibido la petición. */
function ownHosts(request: Request): Set<string> {
  const hosts = new Set<string>();
  const add = (value: string | null | undefined) => {
    const host = value?.split(",")[0]?.trim().toLowerCase();
    if (host) hosts.add(host);
  };
  try {
    add(new URL(request.url).host);
  } catch {
    // URL relativa o no válida: se usan solo las cabeceras.
  }
  add(request.headers.get("host"));
  add(request.headers.get("x-forwarded-host"));
  return hosts;
}

function isOwnOrigin(request: Request, origin: string): boolean {
  let host: string;
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    host = url.host.toLowerCase();
  } catch {
    return false; // "null" u otro valor que no es un origen
  }
  return ownHosts(request).has(host);
}

function isJson(request: Request): boolean {
  const type = request.headers.get("content-type");
  return type?.split(";")[0].trim().toLowerCase() === "application/json";
}

/**
 * `null` si la petición viene de la propia aplicación (o de un cliente que no es un navegador) y su cuerpo
 * se declara JSON; si no, la respuesta de error (403 `forbidden_origin` o 415 `unsupported_media_type`).
 * Va antes de los límites de peticiones, de leer el cuerpo y de tocar la BD.
 */
export function checkSameOriginJsonPost(request: Request): Response | null {
  if (request.headers.get("sec-fetch-site")?.trim().toLowerCase() === "cross-site") return forbidden();
  const origin = request.headers.get("origin");
  if (origin !== null && !isOwnOrigin(request, origin.trim())) return forbidden();
  if (!isJson(request)) {
    return errorResponse(415, "unsupported_media_type", "Envía el cuerpo como JSON (Content-Type: application/json).");
  }
  return null;
}

function forbidden(): Response {
  return errorResponse(403, "forbidden_origin", "Petición no permitida.");
}
