import { Router, Response, Request } from 'express';
import crypto from 'crypto';
import { prisma } from '../server';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { errResp, okResp, RC } from '../utils/responses';

const router = Router();

const LEMON_API_KEY = process.env.LEMON_API_KEY || '';
const LEMON_STORE_ID = process.env.LEMON_STORE_ID || '';
const LEMON_BUY_URL = process.env.LEMON_BUY_URL || '';
const LEMON_WEBHOOK_SECRET = process.env.LEMON_WEBHOOK_SECRET || '';

async function lemonApi(path: string): Promise<any> {
  const res = await fetch(`https://api.lemonsqueezy.com/v1${path}`, {
    headers: {
      Accept: 'application/vnd.api+json',
      'Content-Type': 'application/vnd.api+json',
      Authorization: `Bearer ${LEMON_API_KEY}`,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Lemon Squeezy API ${res.status}: ${text}`);
  }
  return res.json();
}

// ───── Crear sesión de checkout (devuelve URL de Lemon Squeezy) ─────
router.post('/checkout-custom', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    if (!LEMON_BUY_URL) {
      return res.status(500).json(errResp(RC.PAY_GATEWAY_DOWN, 'Payment gateway not configured'));
    }

    const { botName } = req.body;
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user) return res.status(404).json(errResp(RC.USER_NOT_FOUND, 'User not found'));

    const params = new URLSearchParams();
    params.set('checkout[email]', user.email);
    if (user.name) params.set('checkout[name]', user.name);
    params.set('checkout[custom][user_id]', String(req.userId || ''));
    if (botName) params.set('checkout[custom][bot_name]', String(botName).slice(0, 60));

    const url = `${LEMON_BUY_URL}?${params.toString()}`;
    res.json({ url });
  } catch (error: any) {
    console.error('Lemon checkout error:', error);
    res.status(500).json(errResp(RC.PAY_CHECKOUT_FAIL, 'Failed to create checkout session'));
  }
});

// Validación + saneado del payload del wizard
interface SanitizedBot {
  name: string;
  strategy: string;
  description: string;
  parameters: Record<string, any>;
}
type SanitizeError = { code: string; fallback: string };
function sanitizeBotConfig(raw: any): { error: SanitizeError; data: null } | { error: null; data: SanitizedBot } {
  if (!raw || typeof raw !== 'object') return { error: { code: RC.PAY_CONFIG_REQUIRED, fallback: 'Bot configuration required' }, data: null };

  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (name.length === 0 || name.length > 60) {
    return { error: { code: RC.PAY_NAME_INVALID, fallback: 'Invalid bot name (1-60 characters)' }, data: null };
  }
  const strategy = typeof raw.strategy === 'string' ? raw.strategy : '';
  const allowedStrategies = ['scalping','swing','momentum','mean','breakout','grid','trend','dca','hedge','reversal'];
  if (!allowedStrategies.includes(strategy)) {
    return { error: { code: RC.PAY_STRATEGY_INVALID, fallback: 'Invalid strategy' }, data: null };
  }

  const description = typeof raw.description === 'string' ? raw.description.slice(0, 200) : '';
  const params = (raw.parameters && typeof raw.parameters === 'object') ? raw.parameters : {};

  const allowedKeys = ['avatar','market','pair','leverage','indicators','risk','news','funded','timeframe','lot'];
  const cleanParams: Record<string, any> = {};
  for (const k of allowedKeys) if (k in params) cleanParams[k] = params[k];

  // Sanity bounds en timeframe
  const ALLOWED_TF = ['M1','M5','M15','M30','H1','H4','D1'];
  if (cleanParams.timeframe && !ALLOWED_TF.includes(cleanParams.timeframe)) {
    delete cleanParams.timeframe;
  }

  // Whitelist de indicadores. Sin esto, un usuario puede inyectar strings
  // arbitrarios que el generator no conoce y, si en el futuro alguien
  // refactoriza el generator concatenando el id al código MQL, hay
  // inyección de código directa.
  const ALLOWED_INDICATORS = new Set([
    'rsi','stoch','stochrsi','cci','willr','roc',
    'ema','sma','macd','adx','ichimoku','psar','supertrend',
    'bb','atr','donchian','keltner',
    'volume','vol','obv','vwap','mfi',
    'fib','pivot','sr',
  ]);
  if (Array.isArray(cleanParams.indicators)) {
    cleanParams.indicators = cleanParams.indicators
      .filter((i: unknown) => typeof i === 'string' && ALLOWED_INDICATORS.has(i))
      .slice(0, 24); // tope: nadie necesita más de los 24 que tenemos
  } else {
    cleanParams.indicators = [];
  }

  // Validar bounds en risk
  if (cleanParams.risk && typeof cleanParams.risk === 'object') {
    const r: any = {};
    const numField = (key: string, min: number, max: number) => {
      const v = cleanParams.risk[key];
      if (typeof v === 'number' && isFinite(v)) r[key] = Math.min(max, Math.max(min, v));
    };
    numField('stopLoss', 0.05, 50);
    numField('takeProfit', 0.05, 100);
    numField('posSize', 0.1, 50);
    numField('dailyLoss', 0.5, 50);
    cleanParams.risk = r;
  }

  // Validar news
  if (cleanParams.news && typeof cleanParams.news === 'object') {
    const n: any = {};
    n.enabled = cleanParams.news.enabled === true;
    if (typeof cleanParams.news.beforeMin === 'number' && isFinite(cleanParams.news.beforeMin)) {
      n.beforeMin = Math.min(180, Math.max(0, Math.floor(cleanParams.news.beforeMin)));
    }
    if (typeof cleanParams.news.afterMin === 'number' && isFinite(cleanParams.news.afterMin)) {
      n.afterMin = Math.min(180, Math.max(0, Math.floor(cleanParams.news.afterMin)));
    }
    if (cleanParams.news.impactMin === 'high' || cleanParams.news.impactMin === 'medium' || cleanParams.news.impactMin === 'all') {
      n.impactMin = cleanParams.news.impactMin;
    }
    if (Array.isArray(cleanParams.news.events)) {
      n.events = cleanParams.news.events
        .filter((e: unknown) => typeof e === 'string' && e.length < 200)
        .slice(0, 50);
    }
    cleanParams.news = n;
  }

  // Validar funded
  if (cleanParams.funded && typeof cleanParams.funded === 'object') {
    const f: any = { enabled: cleanParams.funded.enabled === true };
    if (typeof cleanParams.funded.firm === 'string' && cleanParams.funded.firm.length < 60) {
      f.firm = cleanParams.funded.firm;
    }
    cleanParams.funded = f;
  }

  // Sanity bounds en lot
  if (cleanParams.lot && typeof cleanParams.lot === 'object') {
    const lot: any = {};
    if (cleanParams.lot.mode === 'auto' || cleanParams.lot.mode === 'fixed') {
      lot.mode = cleanParams.lot.mode;
    }
    if (typeof cleanParams.lot.fixedLot === 'number' && isFinite(cleanParams.lot.fixedLot)) {
      lot.fixedLot = Math.min(100, Math.max(0.01, cleanParams.lot.fixedLot));
    }
    cleanParams.lot = lot;
  }

  // Validar campos string simples (avatar, market, pair). Tope a 32 chars y
  // sin caracteres raros que puedan acabar concatenados al MQL generado.
  const safeShortStr = (v: unknown): string | undefined => {
    if (typeof v !== 'string') return undefined;
    const trimmed = v.trim().slice(0, 32);
    if (!/^[A-Za-z0-9._/\- ]+$/.test(trimmed)) return undefined;
    return trimmed;
  };
  const a = safeShortStr(cleanParams.avatar); if (a !== undefined) cleanParams.avatar = a; else delete cleanParams.avatar;
  const m = safeShortStr(cleanParams.market); if (m !== undefined) cleanParams.market = m; else delete cleanParams.market;
  const p = safeShortStr(cleanParams.pair);   if (p !== undefined) cleanParams.pair = p;   else delete cleanParams.pair;

  // leverage: número 1..1000
  if (typeof cleanParams.leverage === 'number' && isFinite(cleanParams.leverage)) {
    cleanParams.leverage = Math.min(1000, Math.max(1, Math.floor(cleanParams.leverage)));
  } else {
    delete cleanParams.leverage;
  }

  return { error: null, data: { name, strategy, description, parameters: cleanParams } };
}

// ───── Verificar pago con la API de Lemon y crear bot ─────
// Estrategia robusta: si tenemos orderNumber lo usamos; si no, buscamos
// la orden pagada más reciente del email del usuario (últimos 60 min)
// y aún no asociada a un bot. Esto cubre el caso en que Lemon Squeezy
// no añada `order_number` al redirect URL.
router.post('/verify', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { orderNumber, botConfig } = req.body;
    if (!LEMON_API_KEY || !LEMON_STORE_ID) {
      return res.status(500).json(errResp(RC.PAY_GATEWAY_DOWN, 'Payment gateway not configured'));
    }

    const reqUser = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!reqUser) return res.status(404).json(errResp(RC.USER_NOT_FOUND, 'User not found'));
    const myEmail = (reqUser.email || '').toLowerCase();

    let order: any = null;
    let foundOrderNumber: string | undefined;

    if (orderNumber) {
      const list = await lemonApi(
        `/orders?filter[store_id]=${encodeURIComponent(LEMON_STORE_ID)}&filter[order_number]=${encodeURIComponent(String(orderNumber))}`
      );
      order = Array.isArray(list?.data) ? list.data[0] : null;
      if (order) foundOrderNumber = String(orderNumber);
    } else {
      // Sin orderNumber: traemos órdenes del store y filtramos por email
      // y status='paid' en código (la API de Lemon no acepta filter[status]
      // ni sort=-created_at en /orders).
      const list = await lemonApi(
        `/orders?filter[store_id]=${encodeURIComponent(LEMON_STORE_ID)}&page[size]=50`
      );
      const all = Array.isArray(list?.data) ? list.data : [];
      const candidates = all
        .filter((o: any) => o?.attributes?.status === 'paid')
        .sort((a: any, b: any) => {
          const at = new Date(a?.attributes?.created_at || 0).getTime();
          const bt = new Date(b?.attributes?.created_at || 0).getTime();
          return bt - at;
        });

      for (const c of candidates) {
        const cAttrs = c.attributes || {};
        const cEmail = (cAttrs.user_email || '').toLowerCase();
        const cUserId = cAttrs?.first_order_item?.custom_data?.user_id || cAttrs?.custom_data?.user_id;

        const matchById = cUserId && cUserId === req.userId;
        const matchByEmail = cEmail && myEmail && cEmail === myEmail;
        if (!matchById && !matchByEmail) continue;

        // Limita a órdenes recientes (60 min) para no asociar compras viejas
        const created = new Date(cAttrs.created_at || 0).getTime();
        const ageMin = (Date.now() - created) / 60000;
        if (ageMin > 60 || ageMin < 0) continue;

        // Skip si ya hay un bot con esta orden (consulta por columna unique
        // o por el campo legacy en parameters para órdenes pre-migración)
        const orderId = String(c.id);
        const already = await findBotByLemonOrderId(orderId);
        if (already) continue;

        order = c;
        foundOrderNumber = String(cAttrs.order_number || '');
        break;
      }
    }

    if (!order) {
      return res.status(404).json(errResp(RC.PAY_ORDER_NOT_FOUND, 'Order not found or already processed'));
    }

    const attrs = order.attributes || {};
    const status = attrs.status;
    if (status !== 'paid') {
      return res.status(400).json({ ...errResp(RC.PAY_NOT_CONFIRMED, 'Payment not confirmed'), status });
    }

    // Validación final de propietario
    const customUserId = attrs?.first_order_item?.custom_data?.user_id || attrs?.custom_data?.user_id;
    const orderEmail = (attrs.user_email || '').toLowerCase();
    const matchById = customUserId && customUserId === req.userId;
    const matchByEmail = orderEmail && myEmail && orderEmail === myEmail;
    if (!matchById && !matchByEmail) {
      return res.status(403).json(errResp(RC.PAY_FOREIGN_ORDER, 'Order does not belong to this user'));
    }

    // Idempotencia: la columna lemonOrderId tiene UNIQUE en BD, así que dos
    // requests concurrentes no pueden crear ambos un bot — el segundo recibe
    // P2002 y caemos al lookup. Sin transacción; el constraint hace el trabajo.
    const orderKey = String(order.id);
    const existing = await findBotByLemonOrderId(orderKey);
    if (existing) {
      return res.json({ ...okResp(RC.PAY_ALREADY_VERIFIED, 'Payment already verified'), bot: existing });
    }

    const sanitized = sanitizeBotConfig(botConfig);
    if (sanitized.error) {
      return res.status(400).json(errResp(sanitized.error.code, sanitized.error.fallback));
    }
    const data = sanitized.data!;

    let bot;
    try {
      bot = await prisma.bot.create({
        data: {
          userId: req.userId!,
          name: data.name,
          description: data.description,
          strategy: data.strategy,
          lemonOrderId: orderKey,
          parameters: { ...data.parameters, lemonOrderId: orderKey, lemonOrderNumber: foundOrderNumber || '' },
        },
      });
    } catch (e: any) {
      if (e?.code === 'P2002') {
        // Carrera: otro request ganó el create. Devolvemos el bot existente.
        const winner = await findBotByLemonOrderId(orderKey);
        if (winner) return res.json({ ...okResp(RC.PAY_ALREADY_VERIFIED, 'Payment already verified'), bot: winner });
      }
      throw e;
    }

    res.json({ ...okResp(RC.PAY_VERIFIED, 'Payment verified and bot created'), bot });
  } catch (error: any) {
    console.error('Verify error:', error);
    res.status(500).json(errResp(RC.PAY_VERIFY_FAIL, 'Failed to verify payment'));
  }
});

// Helper común: busca por la columna unique (rápido) y cae al campo legacy
// dentro de parameters para bots creados antes de la migración.
async function findBotByLemonOrderId(orderId: string) {
  const byColumn = await prisma.bot.findUnique({ where: { lemonOrderId: orderId } });
  if (byColumn) return byColumn;
  return prisma.bot.findFirst({
    where: { parameters: { path: ['lemonOrderId'], equals: orderId } as any },
  });
}

// ───── Webhook de Lemon Squeezy (auditoría / fallback) ─────
// ───── Recuperar bots de pagos previos ─────
// Lista todas las órdenes pagadas del usuario (por email o user_id en custom_data)
// y crea un bot para cada una que aún no tenga. Útil cuando:
//   - el usuario pagó con un email distinto al de su cuenta YudBot
//   - el redirect tras pago no llegó a verificar a tiempo
//   - se borró el pendingBotConfig de localStorage
// Crea bots con configuración por defecto + el bot_name del custom_data;
// el usuario puede editarlos después desde el detalle del bot.
router.post('/recover', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    if (!LEMON_API_KEY || !LEMON_STORE_ID) {
      return res.status(500).json(errResp(RC.PAY_GATEWAY_DOWN, 'Payment gateway not configured'));
    }

    const reqUser = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!reqUser) return res.status(404).json(errResp(RC.USER_NOT_FOUND, 'User not found'));

    const list = await lemonApi(
      `/orders?filter[store_id]=${encodeURIComponent(LEMON_STORE_ID)}&page[size]=100`
    );
    const allOrders = Array.isArray(list?.data) ? list.data : [];

    const recovered: any[] = [];

    for (const c of allOrders) {
      const cAttrs = c.attributes || {};
      if (cAttrs.status !== 'paid') continue; // ignora refunded/pending/failed

      // Solo aceptamos órdenes con custom_data.user_id == req.userId. El email
      // del comprador NO es prueba de propiedad (Lemon no verifica que el
      // checkout email pertenezca al pagador), así que el match-by-email
      // anterior permitía reclamar pedidos ajenos cambiando el email de cuenta.
      const cUserId = cAttrs?.first_order_item?.custom_data?.user_id || cAttrs?.custom_data?.user_id;
      if (!cUserId || cUserId !== req.userId) continue;

      const orderId = String(c.id);
      const already = await findBotByLemonOrderId(orderId);
      if (already) continue;

      const customBotName = cAttrs?.first_order_item?.custom_data?.bot_name
        || cAttrs?.custom_data?.bot_name
        || 'Mi Bot';

      try {
        const bot = await prisma.bot.create({
          data: {
            userId: req.userId!,
            name: String(customBotName).slice(0, 60),
            description: 'Bot recuperado de pago previo · puedes editarlo',
            strategy: 'momentum',
            lemonOrderId: orderId,
            parameters: {
              market: 'forex',
              pair: 'EURUSD',
              leverage: 30,
              indicators: ['rsi', 'ema'],
              timeframe: 'M15',
              lot: { mode: 'auto', fixedLot: 0.10 },
              risk: { stopLoss: 1.5, takeProfit: 3.0, posSize: 2, dailyLoss: 4 },
              news: { enabled: false, beforeMin: 30, afterMin: 15, impactMin: 'high', events: [] },
              funded: { enabled: false, firm: null },
              lemonOrderId: orderId,
              lemonOrderNumber: String(cAttrs.order_number || ''),
              recovered: true,
            },
          },
        });
        recovered.push({ id: bot.id, name: bot.name, orderNumber: cAttrs.order_number });
      } catch (e: any) {
        // P2002 = otro request en paralelo creó el bot; lo ignoramos y seguimos
        if (e?.code !== 'P2002') throw e;
      }
    }

    return res.json({
      ...okResp(RC.PAY_RECOVER_OK, `${recovered.length} bot(s) recovered`, { args: { count: recovered.length } }),
      count: recovered.length,
      recovered,
    });
  } catch (error: any) {
    console.error('Recover error:', error);
    res.status(500).json(errResp(RC.PAY_RECOVER_FAIL, 'Failed to recover bots'));
  }
});

router.post('/lemon-webhook', async (req: Request, res: Response) => {
  try {
    if (!LEMON_WEBHOOK_SECRET) {
      console.error('LEMON_WEBHOOK_SECRET no configurado');
      return res.status(500).send('Webhook no configurado');
    }

    const signature = (req.headers['x-signature'] || '') as string;
    const rawBody: Buffer | undefined = (req as any).rawBody;
    if (!rawBody || !signature) return res.status(401).send('Firma faltante');

    const expected = crypto
      .createHmac('sha256', LEMON_WEBHOOK_SECRET)
      .update(rawBody)
      .digest('hex');

    const sigBuf = Buffer.from(signature, 'hex');
    const expBuf = Buffer.from(expected, 'hex');
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return res.status(401).send('Firma inválida');
    }

    const event = (req.body?.meta?.event_name || '').toString();
    const orderId = req.body?.data?.id;
    console.log(`[lemon-webhook] event=${event} order_id=${orderId}`);

    // Solo registramos. La creación del bot se hace en /verify desde el frontend
    // (necesita el botConfig que vive en localStorage del usuario).
    res.json({ received: true });
  } catch (error: any) {
    console.error('Webhook error:', error);
    res.status(500).send('Error procesando webhook');
  }
});

export default router;
