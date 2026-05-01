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
      success_url: `${process.env.FRONTEND_URL}/index.html?payment=success&session={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/index.html?payment=cancel`,
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
      success_url: `${process.env.FRONTEND_URL}/index.html?payment=success&type=custom&session={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/index.html?payment=cancel`,
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

// Endpoint para verificar pago y crear bot custom
router.post('/verify', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { sessionId, botConfig } = req.body;
    if (!sessionId) {
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

    // Crear el bot custom con la config del wizard
    if (!botConfig) {
      return res.status(400).json({ error: 'Configuración del bot requerida' });
    }

    const bot = await prisma.bot.create({
      data: {
        userId,
        name: botConfig.name,
        description: botConfig.description || '',
        strategy: botConfig.strategy,
        parameters: botConfig.parameters || {},
        status: 'active',
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
