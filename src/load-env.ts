// Carga las variables de entorno del PROCESO. Tiene que importarse antes que
// cualquier otra cosa en `main.ts`.
//
// El motivo: el cliente generado de `@prisma/client` carga `.env` por su cuenta
// en el momento en que se importa, y no sabe nada de `.env.local`. Como dotenv
// nunca pisa una variable que ya exista en `process.env`, gana el primero que
// llegue. Si llega Prisma primero, `DATABASE_URL` queda apuntando a PRODUCCIÓN
// y el backend en desarrollo habla con Supabase aunque `.env.local` apunte a la
// réplica de Docker — silenciosamente, porque nada falla al arrancar.
//
// `ConfigModule` tampoco lo corrige: su `assignVariablesToProcess` solo define
// las claves que aún no están en `process.env`, y para entonces ya está la de
// producción.
//
// El orden es el mismo que en `prisma.config.ts`: `.env.local` primero, así el
// entorno local gana. En Railway no existe ninguno de los dos archivos y las
// variables reales de la plataforma mandan, que es justo lo que se quiere.
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.local', quiet: true });
dotenv.config({ path: '.env', quiet: true });
