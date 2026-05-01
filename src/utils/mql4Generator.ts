// mql4Generator.ts — Genera código MQL4 (MetaTrader 4) desde la config del bot

interface BotParams {
  market?: string;
  pair?: string;
  leverage?: number;
  indicators?: string[];
  risk?: {
    stopLoss?: number;
    takeProfit?: number;
    posSize?: number;
    dailyLoss?: number;
  };
  funded?: { enabled?: boolean; firm?: string };
}

export function generateMQL4(bot: {
  name: string;
  description?: string | null;
  strategy: string;
  parameters: BotParams;
}): string {
  const p = bot.parameters || {};
  const risk = p.risk || {};
  const stopLoss = risk.stopLoss || 1.5;
  const takeProfit = risk.takeProfit || 3.0;
  const posSize = risk.posSize || 2.0;
  const dailyLoss = risk.dailyLoss || 4.0;
  const leverage = p.leverage || 30;
  const pair = p.pair || 'EURUSD';
  const symbol = pair.replace('/', '');
  const indicators = p.indicators || [];
  const strategy = bot.strategy || 'momentum';
  const generatedDate = new Date().toISOString().split('T')[0];
  const magicNumber = Math.floor(Math.random() * 900000) + 100000;

  const strategyDescriptions: Record<string, string> = {
    scalping: 'Scalping rápido (M1-M5)',
    swing: 'Swing trading (H4-D1)',
    grid: 'Grid trading',
    momentum: 'Momentum',
    mean: 'Mean reversion',
    breakout: 'Breakout',
    dca: 'DCA',
    arb: 'Arbitraje',
    ai: 'IA predictiva',
  };

  const sanitizeName = bot.name.replace(/[^a-zA-Z0-9_]/g, '_');

  return `//+------------------------------------------------------------------+
//|                                              ${sanitizeName}.mq4 |
//|                              Generado por AlgoTrade · ${generatedDate} |
//|                                          https://algotrade.app |
//+------------------------------------------------------------------+
#property copyright "AlgoTrade"
#property link      "https://algotrade.app"
#property version   "1.00"
#property strict
#property description "${bot.description || bot.name}"
#property description "Estrategia: ${strategyDescriptions[strategy] || strategy}"
#property description "Par: ${pair} · Apalancamiento: 1:${leverage}"

//--- Configuración del bot
extern string  _GENERAL              = "═══ CONFIGURACIÓN GENERAL ═══";
extern double  InpLotSize            = 0.10;          // Tamaño de lote inicial
extern int     InpMagicNumber        = ${magicNumber};        // Número mágico (identificador único)
extern int     InpSlippage           = 10;             // Slippage máximo (puntos)

extern string  _RISK                 = "═══ GESTIÓN DE RIESGO ═══";
extern double  InpStopLoss           = ${stopLoss};        // Stop Loss (%)
extern double  InpTakeProfit         = ${takeProfit};      // Take Profit (%)
extern double  InpRiskPerTrade       = ${posSize};         // Riesgo por operación (% capital)
extern double  InpMaxDailyLoss       = ${dailyLoss};       // Pérdida diaria máxima (%)
extern int     InpLeverage           = ${leverage};        // Apalancamiento (1:X)

extern string  _TIME                 = "═══ HORARIO DE OPERACIÓN ═══";
extern bool    InpUseTimeFilter      = true;           // Usar filtro horario
extern int     InpStartHour          = 8;              // Hora inicio (UTC)
extern int     InpEndHour            = 22;             // Hora fin (UTC)

//--- Variables globales
double initialBalance;
double dailyStartBalance;
datetime lastDayCheck;
int lastBarTime = 0;

//+------------------------------------------------------------------+
//| Initialization                                                   |
//+------------------------------------------------------------------+
int OnInit()
{
   Print("═══════════════════════════════════════");
   Print("  ${bot.name}");
   Print("  Generado por AlgoTrade · ${generatedDate}");
   Print("  Estrategia: ${strategyDescriptions[strategy] || strategy}");
   Print("═══════════════════════════════════════");

   initialBalance = AccountBalance();
   dailyStartBalance = initialBalance;
   lastDayCheck = TimeCurrent();

   Print("Bot inicializado correctamente");
   Print("Balance inicial: ", initialBalance);
   Print("Apalancamiento: 1:", InpLeverage);

   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
//| Deinitialization                                                 |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   Print("Bot detenido. Razón: ", reason);
}

//+------------------------------------------------------------------+
//| Verificar pérdida diaria máxima                                  |
//+------------------------------------------------------------------+
bool CheckDailyLoss()
{
   datetime now = TimeCurrent();
   if(TimeDay(now) != TimeDay(lastDayCheck))
   {
      dailyStartBalance = AccountBalance();
      lastDayCheck = now;
   }

   double dailyLossPct = ((dailyStartBalance - AccountBalance()) / dailyStartBalance) * 100.0;
   if(dailyLossPct >= InpMaxDailyLoss)
   {
      Print("⚠️ Pérdida diaria máxima alcanzada (", dailyLossPct, "%) - Bot pausado");
      return false;
   }
   return true;
}

//+------------------------------------------------------------------+
//| Verificar horario de operación                                   |
//+------------------------------------------------------------------+
bool IsTradingHours()
{
   if(!InpUseTimeFilter) return true;
   int hour = TimeHour(TimeCurrent());
   return (hour >= InpStartHour && hour < InpEndHour);
}

//+------------------------------------------------------------------+
//| Calcular tamaño de lote según riesgo                             |
//+------------------------------------------------------------------+
double CalculateLotSize(double stopLossPips)
{
   double balance = AccountBalance();
   double riskAmount = balance * (InpRiskPerTrade / 100.0);
   double tickValue = MarketInfo(Symbol(), MODE_TICKVALUE);
   double lot = NormalizeDouble(riskAmount / (stopLossPips * tickValue), 2);

   double minLot = MarketInfo(Symbol(), MODE_MINLOT);
   double maxLot = MarketInfo(Symbol(), MODE_MAXLOT);
   if(lot < minLot) lot = minLot;
   if(lot > maxLot) lot = maxLot;

   return lot;
}

//+------------------------------------------------------------------+
//| Verificar si hay posiciones abiertas                             |
//+------------------------------------------------------------------+
bool HasOpenPosition()
{
   for(int i = OrdersTotal() - 1; i >= 0; i--)
   {
      if(!OrderSelect(i, SELECT_BY_POS, MODE_TRADES)) continue;
      if(OrderMagicNumber() == InpMagicNumber && OrderSymbol() == Symbol())
         return true;
   }
   return false;
}

//+------------------------------------------------------------------+
//| Lógica principal — se ejecuta en cada tick                       |
//+------------------------------------------------------------------+
void OnTick()
{
   if(!CheckDailyLoss()) return;
   if(!IsTradingHours()) return;
   if(HasOpenPosition()) return; // Solo una posición a la vez

   // Solo evaluar en una nueva barra
   if(Time[0] == lastBarTime) return;
   lastBarTime = Time[0];

   //--- Obtener señales según estrategia: ${strategyDescriptions[strategy] || strategy}
   bool buySignal = false;
   bool sellSignal = false;

${generateStrategyLogic(strategy, indicators)}

   //--- Ejecutar órdenes
   if(buySignal)
   {
      double sl = Ask * (1 - InpStopLoss/100.0);
      double tp = Ask * (1 + InpTakeProfit/100.0);
      double lot = CalculateLotSize(MathAbs(Ask - sl) / Point);
      int ticket = OrderSend(Symbol(), OP_BUY, lot, Ask, InpSlippage, sl, tp, "${bot.name} BUY", InpMagicNumber, 0, clrGreen);
      if(ticket < 0) Print("Error al abrir BUY: ", GetLastError());
      else Print("BUY abierta · Ticket: ", ticket, " · Lote: ", lot);
   }
   else if(sellSignal)
   {
      double sl = Bid * (1 + InpStopLoss/100.0);
      double tp = Bid * (1 - InpTakeProfit/100.0);
      double lot = CalculateLotSize(MathAbs(sl - Bid) / Point);
      int ticket = OrderSend(Symbol(), OP_SELL, lot, Bid, InpSlippage, sl, tp, "${bot.name} SELL", InpMagicNumber, 0, clrRed);
      if(ticket < 0) Print("Error al abrir SELL: ", GetLastError());
      else Print("SELL abierta · Ticket: ", ticket, " · Lote: ", lot);
   }
}

//+------------------------------------------------------------------+
//| END OF FILE — Generado por AlgoTrade                             |
//+------------------------------------------------------------------+
`;
}

// Genera la lógica específica de la estrategia (MQL4)
function generateStrategyLogic(strategy: string, indicators: string[]): string {
  const hasRSI = indicators.includes('rsi');
  const hasEMA = indicators.includes('ema');
  const hasMACD = indicators.includes('macd');
  const hasBB = indicators.includes('bb');

  if (strategy === 'scalping' || strategy === 'momentum') {
    if (hasRSI && hasEMA) {
      return `   // Estrategia: ${strategy} con RSI + EMA
   double rsi = iRSI(Symbol(), PERIOD_CURRENT, 14, PRICE_CLOSE, 0);
   double emaFast = iMA(Symbol(), PERIOD_CURRENT, 9, 0, MODE_EMA, PRICE_CLOSE, 0);
   double emaSlow = iMA(Symbol(), PERIOD_CURRENT, 21, 0, MODE_EMA, PRICE_CLOSE, 0);

   // Buy: RSI < 30 (sobrevendido) y EMA rápida > EMA lenta (tendencia alcista)
   if(rsi < 30 && emaFast > emaSlow) buySignal = true;
   // Sell: RSI > 70 (sobrecomprado) y EMA rápida < EMA lenta (tendencia bajista)
   if(rsi > 70 && emaFast < emaSlow) sellSignal = true;`;
    }
    if (hasRSI) {
      return `   // Estrategia: ${strategy} con RSI
   double rsi = iRSI(Symbol(), PERIOD_CURRENT, 14, PRICE_CLOSE, 0);
   if(rsi < 30) buySignal = true;
   if(rsi > 70) sellSignal = true;`;
    }
    if (hasEMA) {
      return `   // Estrategia: ${strategy} con cruce de EMAs
   double emaFast0 = iMA(Symbol(), PERIOD_CURRENT, 9, 0, MODE_EMA, PRICE_CLOSE, 0);
   double emaSlow0 = iMA(Symbol(), PERIOD_CURRENT, 21, 0, MODE_EMA, PRICE_CLOSE, 0);
   double emaFast1 = iMA(Symbol(), PERIOD_CURRENT, 9, 0, MODE_EMA, PRICE_CLOSE, 1);
   double emaSlow1 = iMA(Symbol(), PERIOD_CURRENT, 21, 0, MODE_EMA, PRICE_CLOSE, 1);

   if(emaFast0 > emaSlow0 && emaFast1 <= emaSlow1) buySignal = true;
   if(emaFast0 < emaSlow0 && emaFast1 >= emaSlow1) sellSignal = true;`;
    }
    return `   // Sin indicadores configurados — agrega RSI o EMA al bot
   buySignal = false;
   sellSignal = false;`;
  }

  if (strategy === 'mean') {
    return `   // Estrategia: Mean Reversion con Bollinger Bands
   double bb_upper = iBands(Symbol(), PERIOD_CURRENT, 20, 2, 0, PRICE_CLOSE, MODE_UPPER, 0);
   double bb_lower = iBands(Symbol(), PERIOD_CURRENT, 20, 2, 0, PRICE_CLOSE, MODE_LOWER, 0);

   // Buy: precio toca banda inferior
   if(Bid <= bb_lower) buySignal = true;
   // Sell: precio toca banda superior
   if(Bid >= bb_upper) sellSignal = true;`;
  }

  if (strategy === 'breakout') {
    return `   // Estrategia: Breakout de máximos/mínimos de 20 velas
   double high20 = iHigh(Symbol(), PERIOD_CURRENT, iHighest(Symbol(), PERIOD_CURRENT, MODE_HIGH, 20, 1));
   double low20  = iLow(Symbol(), PERIOD_CURRENT, iLowest(Symbol(), PERIOD_CURRENT, MODE_LOW, 20, 1));

   // Buy: ruptura de máximo
   if(Bid > high20) buySignal = true;
   // Sell: ruptura de mínimo
   if(Bid < low20) sellSignal = true;`;
  }

  // Default
  return `   // Lógica genérica
   double rsi = iRSI(Symbol(), PERIOD_CURRENT, 14, PRICE_CLOSE, 0);
   if(rsi < 30) buySignal = true;
   if(rsi > 70) sellSignal = true;`;
}
