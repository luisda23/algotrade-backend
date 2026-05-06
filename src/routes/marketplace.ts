import { Router, Response } from 'express';
import { prisma } from '../server';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { errResp, okResp, RC } from '../utils/responses';

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
    res.status(500).json(errResp(RC.MP_TEMPLATES_FAIL, 'Failed to load templates'));
  }
});

router.get('/templates/:templateId', async (req: any, res: Response) => {
  try {
    const { templateId } = req.params;

    const template = await prisma.botTemplate.findUnique({
      where: { id: templateId },
    });

    if (!template) {
      return res.status(404).json(errResp(RC.MP_TEMPLATE_NOT_FOUND, 'Template not found'));
    }

    res.json(template);
  } catch (error) {
    console.error(error);
    res.status(500).json(errResp(RC.MP_TEMPLATE_GET_FAIL, 'Failed to load template'));
  }
});

router.post('/buy', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { botTemplateId, brokerConnectionId } = req.body;

    if (!botTemplateId) {
      return res.status(400).json(errResp(RC.MP_TEMPLATE_REQUIRED, 'Template required'));
    }

    const template = await prisma.botTemplate.findUnique({
      where: { id: botTemplateId },
    });

    if (!template) {
      return res.status(404).json(errResp(RC.MP_TEMPLATE_NOT_FOUND, 'Template not found'));
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
      ...okResp(RC.MP_BOT_PURCHASED, 'Bot purchased successfully'),
      bot: newBot,
      subscription,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json(errResp(RC.MP_BOT_PURCHASE_FAIL, 'Failed to purchase bot'));
  }
});

export default router;
