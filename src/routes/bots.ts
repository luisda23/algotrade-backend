import { Router, Response } from 'express';
import { prisma } from '../server';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { generateMQL5 } from '../utils/mqlGenerator';
import { generateMQL4 } from '../utils/mql4Generator';

const router = Router();

// Descargar archivo del bot (MQL4 o MQL5 según query param ?format=mq4|mq5)
router.get('/:botId/download', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { botId } = req.params;
    const format = (req.query.format as string) === 'mq4' ? 'mq4' : 'mq5';

    const bot = await prisma.bot.findUnique({
      where: { id: botId },
    });

    if (!bot || bot.userId !== req.userId) {
      return res.status(404).json({ error: 'Bot no encontrado' });
    }

    const botData = {
      id: bot.id,
      name: bot.name,
      description: bot.description,
      strategy: bot.strategy,
      parameters: bot.parameters as any,
    };

    // Generar según formato
    const code = format === 'mq4' ? generateMQL4(botData) : generateMQL5(botData);
    const filename = bot.name.replace(/[^a-zA-Z0-9_]/g, '_') + '.' + format;

    res.setHeader('Content-Type', `application/x-${format}`);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(code);
  } catch (error: any) {
    console.error('Download error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { name, description, strategy, parameters, brokerConnectionId } = req.body;

    if (!name || !strategy) {
      return res.status(400).json({ error: 'Nombre y estrategia requeridos' });
    }

    const bot = await prisma.bot.create({
      data: {
        userId: req.userId!,
        name,
        description,
        strategy,
        parameters: parameters || {},
        brokerConnectionId,
      },
    });

    res.status(201).json({ message: 'Bot creado exitosamente', bot });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al crear el bot' });
  }
});

router.get('/', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const bots = await prisma.bot.findMany({
      where: { userId: req.userId },
      include: {
        brokerConnection: true,
        trades: true,
      },
    });

    res.json(bots);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener bots' });
  }
});

router.get('/:botId', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { botId } = req.params;

    const bot = await prisma.bot.findUnique({
      where: { id: botId },
      include: {
        brokerConnection: true,
        trades: true,
        botTemplate: true,
      },
    });

    if (!bot || bot.userId !== req.userId) {
      return res.status(404).json({ error: 'Bot no encontrado' });
    }

    res.json(bot);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener el bot' });
  }
});

router.put('/:botId', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { botId } = req.params;
    const { name, description, parameters } = req.body;

    const bot = await prisma.bot.findUnique({ where: { id: botId } });
    if (!bot || bot.userId !== req.userId) {
      return res.status(404).json({ error: 'Bot no encontrado' });
    }

    const updatedBot = await prisma.bot.update({
      where: { id: botId },
      data: {
        ...(typeof name === 'string' && name.trim() && { name: name.trim().slice(0, 60) }),
        ...(typeof description === 'string' && { description: description.slice(0, 200) }),
        ...(parameters && typeof parameters === 'object' && { parameters }),
      },
    });

    res.json({ message: 'Bot actualizado', bot: updatedBot });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al actualizar el bot' });
  }
});

router.delete('/:botId', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { botId } = req.params;

    const bot = await prisma.bot.findUnique({ where: { id: botId } });
    if (!bot || bot.userId !== req.userId) {
      return res.status(404).json({ error: 'Bot no encontrado' });
    }

    await prisma.bot.delete({ where: { id: botId } });

    res.json({ message: 'Bot eliminado exitosamente' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al eliminar el bot' });
  }
});

export default router;
