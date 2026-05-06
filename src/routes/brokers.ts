import { Router, Response } from 'express';
import { prisma } from '../server';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { errResp, okResp, RC } from '../utils/responses';

const router = Router();

router.post('/connect', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { brokerName, apiKey, apiSecret, accountId } = req.body;

    if (!brokerName || !apiKey || !apiSecret) {
      return res.status(400).json(errResp(RC.BROKER_FIELDS_REQUIRED, 'Broker, API key and secret required'));
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
      return res.status(409).json(errResp(RC.BROKER_DUPLICATE, 'You already have a connection to this broker'));
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
      ...okResp(RC.BROKER_CONNECT_OK, 'Broker connected successfully'),
      connection: {
        id: connection.id,
        brokerName: connection.brokerName,
        isActive: connection.isActive,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json(errResp(RC.BROKER_CONNECT_FAIL, 'Failed to connect broker'));
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
    res.status(500).json(errResp(RC.BROKER_LIST_FAIL, 'Failed to load connections'));
  }
});

router.delete('/:connectionId', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { connectionId } = req.params;

    const connection = await prisma.brokerConnection.findUnique({
      where: { id: connectionId },
    });

    if (!connection || connection.userId !== req.userId) {
      return res.status(404).json(errResp(RC.BROKER_NOT_FOUND, 'Connection not found'));
    }

    await prisma.brokerConnection.delete({ where: { id: connectionId } });

    res.json(okResp(RC.BROKER_DISCONNECT_OK, 'Broker disconnected successfully'));
  } catch (error) {
    console.error(error);
    res.status(500).json(errResp(RC.BROKER_DISCONNECT_FAIL, 'Failed to disconnect broker'));
  }
});

export default router;
