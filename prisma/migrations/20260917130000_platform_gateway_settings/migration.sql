-- Pasarela de pagos de la plataforma (Wompi). Fila única 'singleton'.
-- Las llaves van en base y no en env porque Wompi rota las tres privadas de
-- golpe: si rotar exigiera redeploy, el cobro queda caído mientras tanto.

CREATE TABLE "platform_gateway_settings" (
  "id"              TEXT NOT NULL DEFAULT 'singleton',
  "provider"        TEXT NOT NULL DEFAULT 'wompi',
  "enabled"         BOOLEAN NOT NULL DEFAULT false,
  "environment"     TEXT NOT NULL DEFAULT 'test',
  "publicKey"       TEXT,
  "privateKey"      TEXT,
  "eventsSecret"    TEXT,
  "integritySecret" TEXT,
  "enabledMethods"  JSONB,
  "redirectUrl"     TEXT,
  "updatedAt"       TIMESTAMP(3) NOT NULL,

  CONSTRAINT "platform_gateway_settings_pkey" PRIMARY KEY ("id")
);
