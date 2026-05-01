import express, { Express, Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';

import authRoutes from './routes/auth';
import botsRoutes from './routes/bots';
import brokerRoutes from './routes/brokers';
import marketplaceRoutes from './routes/marketplace';
import paymentRoutes from './routes/payments';

dotenv.config();

const app: Express = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 5000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS — permite frontend local y producción
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3000',
  process.env.FRONTEND_URL,
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Permitir requests sin origin (Postman, curl)
    if (!origin) return callback(null, true);
    // Permitir Vercel preview/production deployments
    if (origin.endsWith('.vercel.app') || allowedOrigins.includes(origin)) {
      return callback(null, true);
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

export { prisma, app };
