// Scripts Lua del limitador contra un Redis REAL (Docker, desechable; nunca Upstash). Solo se ejecutan con
// REDIS_TEST_URL (las lanza `tests/redis/run-llm-limiter-redis-tests.sh`); en la suite normal se omiten.
// Cliente RESP mínimo sobre TCP (sin dependencias): una conexión por "instancia" para que las peticiones
// concurrentes lleguen de verdad a la vez.
import { connect, type Socket } from "node:net";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createGatewayLimiter, type GatewayLimiter, type LimiterRedis } from "../gatewayLimiter";
import { LIMITER_KEYS } from "../limiterScripts";

vi.mock("server-only", () => ({}));

const URL_ = process.env.REDIS_TEST_URL;
const GAME = "751bb3b5-52dc-4e00-86eb-3085d4357dad";

type Reply = string | number | null | Reply[] | Error;

/** Conexión RESP: un comando cada vez (suficiente para estas pruebas). */
class RespConnection {
  private buffer = Buffer.alloc(0);
  private pending: ((r: Reply) => void)[] = [];
  private constructor(private socket: Socket) {
    socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      for (;;) {
        const parsed = parse(this.buffer, 0);
        if (!parsed) break;
        this.buffer = this.buffer.subarray(parsed.end);
        this.pending.shift()?.(parsed.value);
      }
    });
  }
  static open(url: string): Promise<RespConnection> {
    const { hostname, port } = new URL(url);
    return new Promise((resolve, reject) => {
      const socket = connect(Number(port), hostname, () => resolve(new RespConnection(socket)));
      socket.on("error", reject);
    });
  }
  command(...args: (string | number)[]): Promise<Reply> {
    const parts = args.map(String);
    const payload = `*${parts.length}\r\n${parts.map((p) => `$${Buffer.byteLength(p)}\r\n${p}\r\n`).join("")}`;
    return new Promise((resolve) => {
      this.pending.push(resolve);
      this.socket.write(payload);
    });
  }
  close() {
    this.socket.end();
  }
}

function parse(buf: Buffer, at: number): { value: Reply; end: number } | null {
  const lineEnd = buf.indexOf("\r\n", at);
  if (lineEnd < 0) return null;
  const type = String.fromCharCode(buf[at]);
  const line = buf.toString("utf8", at + 1, lineEnd);
  const next = lineEnd + 2;
  if (type === "+") return { value: line, end: next };
  if (type === "-") return { value: new Error(line), end: next };
  if (type === ":") return { value: Number(line), end: next };
  if (type === "$") {
    const len = Number(line);
    if (len < 0) return { value: null, end: next };
    if (buf.length < next + len + 2) return null;
    return { value: buf.toString("utf8", next, next + len), end: next + len + 2 };
  }
  if (type === "*") {
    const count = Number(line);
    if (count < 0) return { value: null, end: next };
    const items: Reply[] = [];
    let pos = next;
    for (let i = 0; i < count; i++) {
      const item = parse(buf, pos);
      if (!item) return null;
      items.push(item.value);
      pos = item.end;
    }
    return { value: items, end: pos };
  }
  throw new Error(`respuesta RESP desconocida: ${type}`);
}

const connections: RespConnection[] = [];
async function client(): Promise<RespConnection> {
  const c = await RespConnection.open(URL_!);
  connections.push(c);
  return c;
}
/** `LimiterRedis` sobre una conexión RESP: EVAL de verdad. */
const asRedis = (c: RespConnection): LimiterRedis => ({
  async eval(script, keys, args) {
    const reply = await c.command("EVAL", script, keys.length, ...keys, ...args);
    if (reply instanceof Error) throw reply;
    return reply;
  },
});
/** Varios limitadores, cada uno con su propia conexión (como varias instancias de Vercel). */
async function instances(n: number, options = {}): Promise<GatewayLimiter[]> {
  return Promise.all(Array.from({ length: n }, async () => createGatewayLimiter(asRedis(await client()), { timeoutMs: 5_000, ...options })));
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!URL_)("limitador contra Redis real (Docker)", () => {
  let admin: RespConnection;
  beforeEach(async () => {
    admin ??= await client();
    expect(await admin.command("FLUSHDB")).toBe("OK");
  });
  afterAll(() => connections.forEach((c) => c.close()));

  it("el script usa la hora del servidor (TIME) y concede la primera llamada", async () => {
    const [limiter] = await instances(1);
    expect(await limiter.acquire({ consumer: "chat" })).toEqual({ kind: "allowed", grant: null });
    const members = (await admin.command("ZRANGE", LIMITER_KEYS.window, 0, -1, "WITHSCORES")) as string[];
    const serverNow = (await admin.command("TIME")) as string[];
    expect(Math.abs(Number(members[1]) - Number(serverNow[0]) * 1000)).toBeLessThan(5_000);
  });

  it("60 peticiones concurrentes desde 12 instancias (chat y movimientos): exactamente 4 concedidas, 2 de cada", async () => {
    const limiters = await instances(12);
    const results = await Promise.all(
      Array.from({ length: 60 }, (_, i) => limiters[i % 12].acquire(i % 2 ? { consumer: "chat" } : { consumer: "moves", gameId: GAME })),
    );
    expect(results.filter((r) => r.kind === "allowed")).toHaveLength(4);
    const members = (await admin.command("ZRANGE", LIMITER_KEYS.window, 0, -1)) as string[];
    expect(members.filter((m) => m.startsWith("chat:"))).toHaveLength(2);
    expect(members.filter((m) => m.startsWith("moves:"))).toHaveLength(2);
    expect(await admin.command("GET", LIMITER_KEYS.movesQuota(GAME))).toBe("2"); // las denegadas no gastan cupo
  });

  it("ventana deslizante real: nunca más de 4 en ninguna ventana durante ráfagas concurrentes repetidas", { timeout: 20_000 }, async () => {
    const windowMs = 1_000;
    const limiters = await instances(8, { windowMs });
    const granted: number[] = [];
    const start = Date.now();
    while (Date.now() - start < 4_000) {
      const burst = await Promise.all(Array.from({ length: 16 }, (_, i) => limiters[i % 8].acquire(i % 2 ? { consumer: "chat" } : { consumer: "moves", gameId: GAME })));
      const t = Date.now();
      for (const r of burst) if (r.kind === "allowed") granted.push(t);
      await wait(150);
    }
    // Comprobación sobre el propio Redis: en cada ráfaga, la ventana nunca tiene más de 4 miembros.
    expect(((await admin.command("ZRANGE", LIMITER_KEYS.window, 0, -1)) as string[]).length).toBeLessThanOrEqual(4);
    // Y sobre los instantes de concesión (con 200 ms de holgura por la latencia local).
    for (const g of granted) expect(granted.filter((x) => x >= g && x < g + windowMs - 200).length).toBeLessThanOrEqual(4);
    expect(granted.length).toBeGreaterThanOrEqual(12); // se reabre la ventana varias veces
  });

  it("cupo por partida: 60 peticiones concurrentes → exactamente 20 (1…20); la marca de cada concesión no sobrevive al contador", async () => {
    const limiters = await instances(10, { globalLimit: 1_000, consumerLimit: 1_000 });
    const results = await Promise.all(Array.from({ length: 60 }, (_, i) => limiters[i % 10].acquire({ consumer: "moves", gameId: GAME })));
    const used = results.flatMap((r) => (r.kind === "allowed" && r.grant ? [r.grant.used] : []));
    expect([...used].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(results.filter((r) => r.kind === "quota_exhausted")).toHaveLength(40);
    expect(await admin.command("GET", LIMITER_KEYS.movesQuota(GAME))).toBe("20");
    const quotaTtl = (await admin.command("PTTL", LIMITER_KEYS.movesQuota(GAME))) as number;
    const grant = results.find((r) => r.kind === "allowed" && r.grant)! as { grant: { grantId: string } };
    const grantTtl = (await admin.command("PTTL", LIMITER_KEYS.movesGrant(grant.grant.grantId))) as number;
    expect(grantTtl).toBeGreaterThan(0);
    expect(grantTtl).toBeLessThanOrEqual(quotaTtl);
  });

  it("una denegación global no gasta cupo y un cupo agotado no ocupa la ventana", async () => {
    const [limiter] = await instances(1, { globalLimit: 1 });
    expect((await limiter.acquire({ consumer: "chat" })).kind).toBe("allowed");
    expect((await limiter.acquire({ consumer: "moves", gameId: GAME })).kind).toBe("rate_limited");
    expect(await admin.command("GET", LIMITER_KEYS.movesQuota(GAME))).toBeNull();
    await admin.command("SET", LIMITER_KEYS.movesQuota(GAME), 20);
    await admin.command("DEL", LIMITER_KEYS.window);
    const [roomy] = await instances(1);
    expect((await roomy.acquire({ consumer: "moves", gameId: GAME })).kind).toBe("quota_exhausted");
    expect(await admin.command("ZCARD", LIMITER_KEYS.window)).toBe(0);
  });

  it("devolución: 10 concurrentes de la misma concesión → una; sin tocar la ventana; nada con el contador caducado", async () => {
    const limiters = await instances(10);
    const first = await limiters[0].acquire({ consumer: "moves", gameId: GAME });
    const second = await limiters[0].acquire({ consumer: "moves", gameId: GAME });
    if (first.kind !== "allowed" || !first.grant || second.kind !== "allowed" || !second.grant) throw new Error("sin concesión");
    const refunds = await Promise.all(limiters.map((l) => l.refundMovesGrant(first.grant!)));
    expect(refunds.filter(Boolean)).toHaveLength(1);
    expect(await admin.command("GET", LIMITER_KEYS.movesQuota(GAME))).toBe("1");
    expect(await admin.command("ZCARD", LIMITER_KEYS.window)).toBe(2);
    // Contador caducado (borrado): no devuelve ni deja negativos.
    await admin.command("DEL", LIMITER_KEYS.movesQuota(GAME));
    expect(await limiters[1].refundMovesGrant(second.grant)).toBe(false);
    expect(await admin.command("GET", LIMITER_KEYS.movesQuota(GAME))).toBeNull();
  });

  it("bloqueo global: bloquea a los dos consumidores y un Retry-After más corto no lo acorta", async () => {
    const [a, b] = await instances(2);
    await a.reportRateLimited(5_000);
    await b.reportRateLimited(1_000);
    expect((await admin.command("PTTL", LIMITER_KEYS.blocked)) as number).toBeGreaterThan(3_000);
    expect((await a.acquire({ consumer: "chat" })).kind).toBe("blocked");
    expect((await b.acquire({ consumer: "moves", gameId: GAME })).kind).toBe("blocked");
    expect(await admin.command("GET", LIMITER_KEYS.movesQuota(GAME))).toBeNull();
    expect(await admin.command("ZCARD", LIMITER_KEYS.window)).toBe(0);
  });
});
