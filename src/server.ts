import express, { Express, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import { prisma } from './db';

import authRoutes from './routes/auth';
import botsRoutes from './routes/bots';
import brokerRoutes from './routes/brokers';
import marketplaceRoutes from './routes/marketplace';
import paymentRoutes from './routes/payments';

dotenv.config();

const app: Express = express();
const PORT = process.env.PORT || 5000;

// Railway / Vercel viven detrás de un proxy, hay que confiar en X-Forwarded-For
// para que express-rate-limit pueda identificar IPs reales. 1 = trust 1 hop.
app.set('trust proxy', 1);

// Headers de seguridad. Desactivamos CSP porque el frontend está en otro dominio
// (Vercel) y la API solo devuelve JSON; el resto de defaults de helmet aplican.
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);
// Quita el header X-Powered-By: Express que dice al atacante el stack que usamos
app.disable('x-powered-by');

app.use(express.json({
  verify: (req: any, _res, buf) => {
    req.rawBody = buf;
  },
  limit: '100kb', // límite de payload — frena POSTs gigantes que abusan recursos
}));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));

// CORS — frontend local + producción + previews de Vercel del proyecto
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3000',
  'https://yudbot.com',
  'https://www.yudbot.com',
  process.env.FRONTEND_URL,
].filter(Boolean);

// Slug del team Vercel — sin esto, "algotrade-*.vercel.app" matchearía
// también deploys de un atacante que cree un proyecto llamado "algotrade-evil"
// en otro team. La URL de preview real tiene el formato
// {project}-{git-hash}-{team-slug}.vercel.app, así que exigimos el team slug.
const VERCEL_TEAM_SLUG = process.env.VERCEL_TEAM_SLUG || ''; // ej. 'luisda23s-projects'
const VERCEL_PREVIEW_RE = VERCEL_TEAM_SLUG
  // algotrade-<git-hash>-<team-slug>.vercel.app
  ? new RegExp(`^algotrade(?:-[a-z0-9]+)?-${VERCEL_TEAM_SLUG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.vercel\\.app$`, 'i')
  : null;

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); // Postman, curl, server-to-server

    // Whitelist explícita
    if (allowedOrigins.includes(origin)) return callback(null, true);

    // Solo previews de NUESTRO proyecto Vercel restringidos al team configurado.
    // Si no hay VERCEL_TEAM_SLUG en env, deshabilitamos previews para no abrir
    // un agujero CSRF al permitir cualquier algotrade-*.vercel.app.
    if (VERCEL_PREVIEW_RE) {
      try {
        const u = new URL(origin);
        if (VERCEL_PREVIEW_RE.test(u.hostname)) return callback(null, true);
      } catch {}
    }

    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

app.use('/api/auth', authRoutes);
app.use('/api/bots', botsRoutes);
app.use('/api/brokers', brokerRoutes);
app.use('/api/marketplace', marketplaceRoutes);
app.use('/api/payments', paymentRoutes);

app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'OK', timestamp: new Date() });
});

app.listen(PORT, () => {
  console.log(`✅ Server ejecutándose en http://localhost:${PORT}`);
});

// Re-exportamos prisma para retrocompatibilidad: routes/* siguen importando
// desde '../server'. La fuente real es './db' — ahí vive el cliente único.
export { prisma };
export { app };
