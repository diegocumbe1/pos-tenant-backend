/**
 * La sesión de WhatsApp de la PLATAFORMA (el número de Lynko) se guarda con un
 * par (tenantId, branchId) sentinel: `WhatsappSession` ya acepta cualquier par,
 * así que se reutiliza el WhatsAppSessionManager sin migración ni código nuevo
 * de sesión.
 *
 * OJO: cada sesión levanta un Chromium (~400 MB). Con la del backoffice más la
 * de un tenant hacen falta `WA_MAX_ACTIVE_SESSIONS >= 2`.
 */
export { PLATFORM_SESSION_TENANT_ID as PLATFORM_TENANT_ID } from '../whatsapp/whatsapp-session.manager';
export const PLATFORM_BRANCH_ID = '__platform__';

/** Fila única de configuración (`PlatformMessagingSettings.id`). */
export const SETTINGS_SINGLETON_ID = 'singleton';
