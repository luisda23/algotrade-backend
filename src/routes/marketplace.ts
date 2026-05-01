import { Router, Response } from 'express';
import { prisma } from '../server';
import { authenticateToken, AuthRequest } from '../middleware/auth';

const router = Router();

router.get('/templates', async (req: any, res: Response) => {
  try {
    const templates = await prisma.botTemplate.findMany({
      select: {
        id: true,
        name: true,
        description: true,
        strategy: true,
        price: true,
        image: true,
      },
    });

    res.json(templates);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener plantillas' });
  }
});

router.get('/templates/:templateId', async (req: any, res: Response) => {
  try {
    const { templateId } = req.params;

    const template = await prisma.botTemplate.findUnique({
      where: { id: templateId },
    });

    if (!template) {
      return res.status(404).json({ error: 'Plantilla no encontrada' });
    }

    res.json(template);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener la plantilla' });
  }
});

router.post('/buy', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { botTemplateId, brokerConnectionId } = req.body;

    if (!botTemplateId) {
      return res.status(400).json({ error: 'Plantilla requerida' });
    }

    const template = await prisma.botTemplate.findUnique({
      where: { id: botTemplateId },
    });

    if (!template) {
      return res.status(404).json({ error: 'Plantilla no encontrada' });
    }

    const newBot = await prisma.bot.create({
      data: {
        userId: req.userId!,
        name: template.name,
        description: template.description || '',
        strategy: template.strategy,
        parameters: template.parameters || {},
        botTemplateId: template.id,
        brokerConnectionId,
      },
    });

    const subscription = await prisma.subscription.create({
      data: {
        userId: req.userId!,
        botTemplateId,
        status: 'active',
      },
    });

    res.status(201).json({
      message: 'Bot comprado exitosamente',
      bot: newBot,
      subscription,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al comprar el bot' });
  }
});

export default router;
