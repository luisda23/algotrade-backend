import { Router, Response, Request } from 'express';
import Stripe from 'stripe';
import { prisma } from '../server';
import { authenticateToken, AuthRequest } from '../middleware/auth';

const router = Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');

// Crear sesión de checkout para comprar un bot
router.post('/checkout', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { botTemplateId } = req.body;

    if (!botTemplateId) {
      return res.status(400).json({ error: 'Plantilla requerida' });
    }

    const template = await prisma.botTemplate.findUnique({
      where: { id: botTemplateId },
    });

    if (!template) {
      return res.status(404).json({ error: 'Plantilla no encontrada' });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.userId },
    });

    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    // Crear sesión de Stripe Checkout
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'eur',
            product_data: {
              name: template.name,
              description: template.description,
            },
            unit_amount: Math.round(template.price * 100), // céntimos
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: `${process.env.FRONTEND_URL}/app?payment=success&session={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/app?payment=cancel`,
      customer_email: user.email,
      metadata: {
        userId: req.userId || '',
        botTemplateId,
      },
    });

    res.json({
      sessionId: session.id,
      url: session.url,
    });
  } catch (error: any) {
    console.error('Stripe error:', error);
    res.status(500).json({ error: error.message || 'Error al crear sesión de pago' });
  }
});

// Crear sesión de checkout para bot personalizado (creado en wizard)
router.post('/checkout-custom', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { botName } = req.body;

    const user = await prisma.user.findUnique({
      where: { id: req.userId },
    });

    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'eur',
            product_data: {
              name: botName || 'Bot personalizado',
              description: 'Bot de trading personalizado · pago único',
            },
            unit_amount: 999, // €9.99 en céntimos
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: `${process.env.FRONTEND_URL}/app?payment=success&type=custom&session={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/app?payment=cancel`,
      customer_email: user.email,
      metadata: {
        userId: req.userId || '',
        type: 'custom',
      },
    });

    res.json({
      sessionId: session.id,
      url: session.url,
    });
  } catch (error: any) {
    console.error('Stripe error:', error);
    res.status(500).json({ error: error.message || 'Error al crear sesión' });
  }
});

// Validación + saneado del payload del wizard
interface SanitizedBot {
  name: string;
  strategy: string;
  description: string;
  parameters: Record<string, any>;
}
function sanitizeBotConfig(raw: any): { error: string; data: null } | { error: null; data: SanitizedBot } {
  if (!raw || typeof raw !== 'object') return { error: 'Configuración del bot requerida', data: null };

  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (name.length === 0 || name.length > 60) {
    return { error: 'Nombre de bot inválido (1-60 caracteres)', data: null };
  }
  const strategy = typeof raw.strategy === 'string' ? raw.strategy : '';
  const allowedStrategies = ['scalping','swing','momentum','mean','breakout','grid','trend','dca','hedge','reversal'];
  if (!allowedStrategies.includes(strategy)) {
    return { error: 'Estrategia no válida', data: null };
  }

  const description = typeof raw.description === 'string' ? raw.description.slice(0, 200) : '';
  const params = (raw.parameters && typeof raw.parameters === 'object') ? raw.parameters : {};

  const allowedKeys = ['avatar','market','pair','leverage','indicators','risk','news','funded'];
  const cleanParams: Record<string, any> = {};
  for (const k of allowedKeys) if (k in params) cleanParams[k] = params[k];

  return { error: null, data: { name, strategy, description, parameters: cleanParams } };
}

// Endpoint para verificar pago y crear bot custom
router.post('/verify', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { sessionId, botConfig } = req.body;
    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).json({ error: 'sessionId requerido' });
    }

    // Verificar el pago con Stripe
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.payment_status !== 'paid') {
      return res.status(400).json({ error: 'Pago no confirmado', status: session.payment_status });
    }

    const { userId } = session.metadata as any;

    // Verificar que el usuario coincide
    if (userId !== req.userId) {
      return res.status(403).json({ error: 'Sesión no pertenece a este usuario' });
    }

    // Idempotencia: si ya existe un bot creado con este sessionId, devolverlo
    const existing = await prisma.bot.findFirst({
      where: {
        userId,
        parameters: { path: ['stripeSessionId'], equals: sessionId } as any,
      },
    });
    if (existing) {
      return res.json({ message: 'Pago ya verificado', bot: existing });
    }

    // Validar y sanear la config
    const sanitized = sanitizeBotConfig(botConfig);
    if (sanitized.error) {
      return res.status(400).json({ error: sanitized.error });
    }
    const data = sanitized.data!;

    const bot = await prisma.bot.create({
      data: {
        userId,
        name: data.name,
        description: data.description,
        strategy: data.strategy,
        parameters: { ...data.parameters, stripeSessionId: sessionId },
      },
    });

    res.json({
      message: 'Pago verificado y bot creado',
      bot,
    });
  } catch (error: any) {
    console.error('Verify error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Webhook (opcional, para producción)
router.post('/webhook', async (req: Request, res: Response) => {
  res.json({ received: true });
});

export default router;
