import { describe, expect, it } from "vitest";
import { getClientIdentity, normalizeIp } from "../clientIp";

const ON_VERCEL = { VERCEL: "1" };
const h = (headers: Record<string, string>) => new Headers(headers);

describe("identificación del cliente", () => {
  it("fuera de Vercel no se fía de ninguna cabecera (se pueden falsificar): todo es 'local'", () => {
    expect(getClientIdentity(h({ "x-forwarded-for": "1.2.3.4", "x-real-ip": "5.6.7.8" }), {})).toEqual({ key: "local", trusted: false });
    expect(getClientIdentity(h({}), { VERCEL: "0" })).toEqual({ key: "local", trusted: false });
  });

  it("en Vercel usa x-vercel-forwarded-for, luego x-real-ip y luego el primero de x-forwarded-for", () => {
    expect(getClientIdentity(h({ "x-vercel-forwarded-for": "203.0.113.7", "x-real-ip": "198.51.100.1" }), ON_VERCEL)).toEqual({ key: "203.0.113.7", trusted: true });
    expect(getClientIdentity(h({ "x-real-ip": "198.51.100.1" }), ON_VERCEL).key).toBe("198.51.100.1");
    expect(getClientIdentity(h({ "x-forwarded-for": "192.0.2.9, 10.0.0.1" }), ON_VERCEL).key).toBe("192.0.2.9");
  });

  it("ignora valores que no son IP y, sin ninguna válida, usa 'unknown' (no confiable)", () => {
    expect(getClientIdentity(h({ "x-vercel-forwarded-for": "evil", "x-real-ip": "198.51.100.1" }), ON_VERCEL).key).toBe("198.51.100.1");
    expect(getClientIdentity(h({ "x-forwarded-for": "<script>" }), ON_VERCEL)).toEqual({ key: "unknown", trusted: false });
    expect(getClientIdentity(h({}), ON_VERCEL)).toEqual({ key: "unknown", trusted: false });
  });

  it("IPv6 se agrupa por /64 (cada usuario dispone de un /64 entero); IPv4 mapeada → IPv4", () => {
    const a = normalizeIp("2001:db8:85a3:12::1");
    expect(a).toBe("2001:0db8:85a3:0012::/64");
    expect(normalizeIp("2001:db8:85a3:12:ffff:ffff:ffff:ffff")).toBe(a);
    expect(normalizeIp("2001:db8:85a3:13::1")).not.toBe(a);
    expect(normalizeIp("::1")).toBe("0000:0000:0000:0000::/64");
    expect(normalizeIp("fe80::1%eth0")).toBe("fe80:0000:0000:0000::/64");
    expect(normalizeIp("::ffff:192.0.2.1")).toBe("192.0.2.1");
    expect(normalizeIp("999.1.1.1")).toBeNull();
  });
});
