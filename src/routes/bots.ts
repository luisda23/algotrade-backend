import { Router, Response } from 'express';
import { prisma } from '../server';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { generateMQL5 } from '../utils/mqlGenerator';
import { generateMQL4 } from '../utils/mql4Generator';
import { errResp, okResp, RC } from '../utils/responses';

const router = Router();

// Descargar archivo del bot (MQL4 o MQL5 según query param ?format=mq4|mq5)
router.get('/:botId/download', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { botId } = req.params;
    const format = (req.query.format as string) === 'mq4' ? 'mq4' : 'mq5';

    // Cargamos bot + user en una sola query: necesitamos user.lang para
    // que los Print/comments del .mq5/.mq4 generado salgan en el idioma
    // que el usuario eligió en el toggle del app.
    const bot = await prisma.bot.findUnique({
      where: { id: botId },
      include: { user: { select: { lang: true } } },
    });

    if (!bot || bot.userId !== req.userId) {
      return res.status(404).json(errResp(RC.BOT_NOT_FOUND, 'Bot not found'));
    }

    const botData = {
      id: bot.id,
      name: bot.name,
      description: bot.description,
      strategy: bot.strategy,
      parameters: bot.parameters as any,
    };
    const lang: 'es' | 'en' = bot.user?.lang === 'en' ? 'en' : 'es';

    // Generar según formato
    const code = format === 'mq4' ? generateMQL4(botData, lang) : generateMQL5(botData, lang);
    const filename = bot.name.replace(/[^a-zA-Z0-9_]/g, '_') + '.' + format;

    res.setHeader('Content-Type', `application/x-${format}`);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(code);
  } catch (error: any) {
    console.error('Download error:', error);
    res.status(500).json(errResp(RC.BOT_DOWNLOAD_FAIL, 'Failed to download bot'));
  }
});

// POST /api/bots fue eliminado: bypaseaba el sistema de pago. La creación
// de bots SOLO debe hacerse vía POST /api/payments/verify tras una orden
// pagada de Lemon Squeezy. Devolvemos 410 Gone para señalizar claramente
// que esta ruta ya no existe (vs 404 que parece error temporal).
router.post('/', authenticateToken, async (_req: AuthRequest, res: Response) => {
  return res.status(410).json(errResp(RC.BOT_CREATE_DEPRECATED, 'Bot creation requires a paid Lemon Squeezy order. Use POST /api/payments/verify.'));
});

// Selector de campos seguros del broker conectado: NUNCA devolvemos apiKey
// ni apiSecret al frontend. El bot solo necesita saber qué broker está
// conectado y la cuenta enmascarada para mostrarlo en la UI; los secretos
// se quedan en BD y solo los usa el backend para hablar con el broker.
const safeBrokerSelect = {
  id: true,
  brokerName: true,
  accountId: true,
  isActive: true,
  createdAt: true,
} as const;

router.get('/', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const bots = await prisma.bot.findMany({
      where: { userId: req.userId },
      include: {
        brokerConnection: { select: safeBrokerSelect },
        trades: true,
      },
    });

    res.json(bots);
  } catch (error) {
    console.error(error);
    res.status(500).json(errResp(RC.BOT_LIST_FAIL, 'Failed to load bots'));
  }
});

router.get('/:botId', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { botId } = req.params;

    const bot = await prisma.bot.findUnique({
      where: { id: botId },
      include: {
        brokerConnection: { select: safeBrokerSelect },
        trades: true,
        botTemplate: true,
      },
    });

    if (!bot || bot.userId !== req.userId) {
      return res.status(404).json(errResp(RC.BOT_NOT_FOUND, 'Bot not found'));
    }

    res.json(bot);
  } catch (error) {
    console.error(error);
    res.status(500).json(errResp(RC.BOT_GET_FAIL, 'Failed to load bot'));
  }
});

// Campos del JSON `parameters` que el usuario puede actualizar libremente.
// `lemonOrderId` y `lemonOrderNumber` se omiten para que NO se puedan
// reescribir desde el cliente (preservan el audit trail del pago).
const ALLOWED_PARAM_KEYS = [
  'avatar', 'market', 'pair', 'leverage',
  'indicators', 'risk', 'news', 'funded',
  'timeframe', 'lot',
];

function sanitizeUpdateParameters(raw: any, existing: any): Record<string, any> {
  const out: Record<string, any> = {};
  // Mantener intactos los campos protegidos
  if (existing && typeof existing === 'object') {
    if (existing.lemonOrderId) out.lemonOrderId = existing.lemonOrderId;
    if (existing.lemonOrderNumber) out.lemonOrderNumber = existing.lemonOrderNumber;
    if (existing.stripeSessionId) out.stripeSessionId = existing.stripeSessionId;
  }
  if (raw && typeof raw === 'object') {
    for (const k of ALLOWED_PARAM_KEYS) {
      if (k in raw) out[k] = raw[k];
    }
  }
  return out;
}

router.put('/:botId', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { botId } = req.params;
    const { name, description, parameters } = req.body;

    const bot = await prisma.bot.findUnique({ where: { id: botId } });
    if (!bot || bot.userId !== req.userId) {
      return res.status(404).json(errResp(RC.BOT_NOT_FOUND, 'Bot not found'));
    }

    const data: any = {};
    if (typeof name === 'string' && name.trim()) {
      data.name = name.trim().slice(0, 60);
    }
    if (typeof description === 'string') {
      data.description = description.slice(0, 200);
    }
    if (parameters && typeof parameters === 'object') {
      data.parameters = sanitizeUpdateParameters(parameters, bot.parameters);
    }

    const updatedBot = await prisma.bot.update({ where: { id: botId }, data });
    res.json({ ...okResp(RC.BOT_UPDATED, 'Bot updated'), bot: updatedBot });
  } catch (error) {
    console.error(error);
    res.status(500).json(errResp(RC.BOT_UPDATE_FAIL, 'Failed to update bot'));
  }
});

router.delete('/:botId', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { botId } = req.params;

    const bot = await prisma.bot.findUnique({ where: { id: botId } });
    if (!bot || bot.userId !== req.userId) {
      return res.status(404).json(errResp(RC.BOT_NOT_FOUND, 'Bot not found'));
    }

    await prisma.bot.delete({ where: { id: botId } });

    res.json(okResp(RC.BOT_DELETED, 'Bot deleted successfully'));
  } catch (error) {
    console.error(error);
    res.status(500).json(errResp(RC.BOT_DELETE_FAIL, 'Failed to delete bot'));
  }
});

export default router;
