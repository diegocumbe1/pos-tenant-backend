// `.env.local` se carga ANTES que `.env` a propósito: dotenv no pisa variables ya
// definidas, así que lo primero en cargarse gana. Eso permite que el desarrollo
// apunte a la réplica de Docker sin tocar las credenciales de producción, que
// siguen viviendo en `.env`.
//
// Consecuencia importante: con `.env.local` presente, `prisma migrate dev` corre
// contra la RÉPLICA. Para aplicar en producción hay que usar
// `scripts/db-deploy-prod.sh`, que lee `.env` de forma explícita.
import dotenv from "dotenv";
import { defineConfig, env } from "prisma/config";

dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env("DATABASE_URL"),
    directUrl: env("DIRECT_URL"),
  },
});
