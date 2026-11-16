import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Mismo alias que en tsconfig.json.
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    // Varias pruebas juegan partidas completas (motor, IA, chat): solas tardan 3–4 s, y con la suite en paralelo
    // superaban a veces los 5 s por defecto de Vitest (p. ej., `personalities.test.ts`), así que `npm test` fallaba
    // por tiempo, nunca por una aserción. 30 s, como las pruebas más largas que ya fijaban el suyo (`ai.test.ts`).
    // Una prueba colgada sigue fallando, solo que a los 30 s.
    testTimeout: 30_000,
  },
});
