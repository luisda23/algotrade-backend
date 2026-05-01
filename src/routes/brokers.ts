import { Router, Response } from 'express';
import { prisma } from '../server';
import { authenticateToken, AuthRequest } from '../middleware/auth';

const router = Router();

router.post('/connect', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { brokerName, apiKey, apiSecret, accountId } = req.body;

    if (!brokerName || !apiKey || !apiSecret) {
      return res.status(400).json({ error: 'Broker, API key y secret requeridos' });
    }

    const existing = await prisma.brokerConnection.findUnique({
      where: {
        userId_brokerName: {
          userId: req.userId!,
          brokerName,
        },
      },
    });

    if (existing) {
      return res.status(409).json({ error: 'Ya tienes una conexión con este broker' });
    }

    const connection = await prisma.brokerConnection.create({
      data: {
        userId: req.userId!,
        brokerName,
        apiKey,
        apiSecret,
        accountId,
        isActive: true,
      },
    });

    res.status(201).json({
      message: 'Broker conectado exitosamente',
      connection: {
        id: connection.id,
        brokerName: connection.brokerName,
        isActive: connection.isActive,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al conectar el broker' });
  }
});

router.get('/', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const connections = await prisma.brokerConnection.findMany({
      where: { userId: req.userId },
      select: {
        id: true,
        brokerName: true,
        accountId: true,
        isActive: true,
        createdAt: true,
      },
    });

    res.json(connections);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener conexiones' });
  }
});

router.delete('/:connectionId', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { connectionId } = req.params;

    const connection = await prisma.brokerConnection.findUnique({
      where: { id: connectionId },
    });

    if (!connection || connection.userId !== req.userId) {
      return res.status(404).json({ error: 'Conexión no encontrada' });
    }

    await prisma.brokerConnection.delete({ where: { id: connectionId } });

    res.json({ message: 'Broker desconectado exitosamente' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al desconectar el broker' });
  }
});

export default router;
