// Cliente Prisma único compartido por todo el backend.
//
// Vive en su propio módulo (no en server.ts) para evitar circular imports:
// server.ts → routes/* → middleware/auth.ts → ... y el middleware necesita
// `prisma` para validar tokenVersion. Si prisma estuviera exportado desde
// server.ts, al cargarse el middleware durante el registro de rutas (antes
// de que server.ts termine de inicializar) `prisma` sería undefined y el
// proceso crashearía con "argument handler must be a function".
import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

