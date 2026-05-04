// mqlGenerator.ts — Genera código MQL5 desde la config del bot

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
  news?: {
    enabled?: boolean;
    beforeMin?: number;
    afterMin?: number;
    impactMin?: 'high' | 'medium' | 'all';
    events?: string[]; // ids seleccionados desde el wizard
  };
  funded?: { enabled?: boolean; firm?: string };
}

export function generateMQL5(bot: {
  id?: string;
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
  const news = p.news || {};
  const newsEnabled = news.enabled !== false;
  const newsBefore = news.beforeMin ?? 30;
  const newsAfter = news.afterMin ?? 15;
  const newsImpactMQL = news.impactMin === 'all' ? 'CALENDAR_IMPORTANCE_LOW'
                     : news.impactMin === 'medium' ? 'CALENDAR_IMPORTANCE_MODERATE'
                     : 'CALENDAR_IMPORTANCE_HIGH';
  // Mapeo id -> patrones que matchean en el calendario de MT5
  // (multiple patterns separados por |, evaluado como substring case-insensitive)
  const NEWS_EVENT_PATTERNS: Record<string, string> = {
    'nfp':       'Nonfarm Payrolls',
    'fomc':      'Federal Funds Rate|FOMC',
    'cpi-us':    'Consumer Price Index|CPI',
    'powell':    'Powell|FOMC Press',
    'gdp-us':    'Gross Domestic Product|GDP',
    'retail-us': 'Retail Sales',
    'unemp-us':  'Unemployment Rate',
    'ism-us':    'ISM',
    'ecb-rate':  'Main Refinancing|Deposit Facility|ECB Interest',
    'ecb-press': 'ECB Press|Lagarde',
    'cpi-eu':    'Consumer Price Index|CPI|HICP',
    'gdp-eu':    'Gross Domestic Product|GDP',
    'pmi-eu':    'PMI',
    'boe-rate':  'Bank Rate|BOE Interest',
    'cpi-uk':    'Consumer Price Index|CPI',
    'gdp-uk':    'Gross Domestic Product|GDP',
    'boj-rate':  'BOJ Interest|Policy Rate',
  };
  const selectedEventIds = (news.events && Array.isArray(news.events))
    ? news.events
    : Object.keys(NEWS_EVENT_PATTERNS); // si no llega array, asumimos todos
  // Si el usuario marcó "Ninguno" (events=[]), su intent es NO filtrar por eventos.
  // Desactivamos el filtro completo en lugar de pausar en todos (que sería lo opuesto).
  const effectiveNewsEnabled = newsEnabled && selectedEventIds.length > 0;
  const newsPatternsStr = selectedEventIds
    .map(id => NEWS_EVENT_PATTERNS[id])
    .filter(Boolean)
    .join('||')
    .replace(/"/g, '\\"');
  const newsHasEventFilter = selectedEventIds.length > 0 && selectedEventIds.length < Object.keys(NEWS_EVENT_PATTERNS).length;
  const generatedDate = new Date().toISOString().split('T')[0];

  // Mapear estrategia a comentario descriptivo
  const strategyDescriptions: Record<string, string> = {
    scalping: 'Scalping rápido (1m-5m timeframe)',
    swing: 'Swing trading (4h-1d timeframe)',
    grid: 'Grid trading con niveles fijos',
    momentum: 'Momentum con detección de fuerza',
    mean: 'Mean reversion (reversión a la media)',
    breakout: 'Breakout de rango',
    dca: 'Dollar-cost averaging',
    arb: 'Arbitraje',
    ai: 'IA predictiva',
  };

  const sanitizeName = bot.name.replace(/[^a-zA-Z0-9_]/g, '_');

  return `//+------------------------------------------------------------------+
//|                                              ${sanitizeName}.mq5 |
//|                              Generado por YudBot · ${generatedDate} |
//|                                          https://yudbot.com |
//+------------------------------------------------------------------+
#property copyright "YudBot"
#property link      "https://yudbot.com"
#property version   "1.00"
#property description "${bot.description || bot.name}"
#property description "Estrategia: ${strategyDescriptions[strategy] || strategy}"
#property description "Par: ${pair} · Apalancamiento: 1:${leverage}"

#include <Trade\\Trade.mqh>
#include <Trade\\PositionInfo.mqh>
#include <Trade\\SymbolInfo.mqh>

//--- Configuración del bot (parámetros editables)
input group    "═══ CONFIGURACIÓN GENERAL ═══"
input string   InpSymbol           = "${symbol}";        // Símbolo a operar
input double   InpLotSize          = 0.10;               // Tamaño de lote inicial
input int      InpMagicNumber      = ${Math.floor(Math.random() * 900000) + 100000};            // Número mágico (identificador único)

input group    "═══ GESTIÓN DE RIESGO ═══"
input double   InpStopLoss         = ${stopLoss};        // Stop Loss (%)
input double   InpTakeProfit       = ${takeProfit};      // Take Profit (%)
input double   InpRiskPerTrade     = ${posSize};         // Riesgo por operación (% capital)
input double   InpMaxDailyLoss     = ${dailyLoss};       // Pérdida diaria máxima (%)
input int      InpLeverage         = ${leverage};        // Apalancamiento (1:X)

input group    "═══ HORARIO DE OPERACIÓN ═══"
input bool     InpUseTimeFilter    = true;               // Usar filtro horario
input int      InpStartHour        = 8;                  // Hora inicio (UTC)
input int      InpEndHour          = 22;                 // Hora fin (UTC)

input group    "═══ FILTRO DE NOTICIAS ═══"
input bool     InpFilterNews       = ${effectiveNewsEnabled};       // Pausar bot durante noticias
input int      InpNewsMinutesBefore = ${newsBefore};                // Minutos antes de la noticia
input int      InpNewsMinutesAfter  = ${newsAfter};                 // Minutos después de la noticia
input ENUM_CALENDAR_EVENT_IMPORTANCE InpNewsMinImpact = ${newsImpactMQL}; // Impacto mínimo a evitar
input bool     InpNewsFilterByName  = ${newsHasEventFilter};        // Filtrar solo eventos específicos
input string   InpNewsPatterns      = "${newsPatternsStr}";          // Patrones separados por || (no editar)

//--- Variables globales
CTrade        trade;
CPositionInfo position;
CSymbolInfo   symbolInfo;

double initialBalance;
double dailyStartBalance;
datetime lastDayCheck;
${indicators.includes('rsi') ? 'int handleRSI;' : ''}
${indicators.includes('ema') ? 'int handleEMA_fast;\nint handleEMA_slow;' : ''}
${indicators.includes('macd') ? 'int handleMACD;' : ''}
${indicators.includes('bb') ? 'int handleBB;' : ''}
${indicators.includes('atr') ? 'int handleATR;' : ''}

//+------------------------------------------------------------------+
//| Initialization                                                   |
//+------------------------------------------------------------------+
int OnInit()
{
   Print("═══════════════════════════════════════");
   Print("  ${bot.name}");
   Print("  Generado por YudBot · ${generatedDate}");
   Print("═══════════════════════════════════════");

   trade.SetExpertMagicNumber(InpMagicNumber);
   trade.SetMarginMode();
   trade.SetTypeFillingBySymbol(InpSymbol);
   trade.SetDeviationInPoints(10);

   if(!symbolInfo.Name(InpSymbol))
   {
      Print("Error: No se puede acceder al símbolo ", InpSymbol);
      return(INIT_FAILED);
   }

${indicators.includes('rsi') ? `   handleRSI = iRSI(InpSymbol, PERIOD_CURRENT, 14, PRICE_CLOSE);
   if(handleRSI == INVALID_HANDLE) { Print("Error creando RSI"); return INIT_FAILED; }` : ''}
${indicators.includes('ema') ? `   handleEMA_fast = iMA(InpSymbol, PERIOD_CURRENT, 9, 0, MODE_EMA, PRICE_CLOSE);
   handleEMA_slow = iMA(InpSymbol, PERIOD_CURRENT, 21, 0, MODE_EMA, PRICE_CLOSE);
   if(handleEMA_fast == INVALID_HANDLE || handleEMA_slow == INVALID_HANDLE) { Print("Error creando EMA"); return INIT_FAILED; }` : ''}
${indicators.includes('macd') ? `   handleMACD = iMACD(InpSymbol, PERIOD_CURRENT, 12, 26, 9, PRICE_CLOSE);
   if(handleMACD == INVALID_HANDLE) { Print("Error creando MACD"); return INIT_FAILED; }` : ''}
${indicators.includes('bb') ? `   handleBB = iBands(InpSymbol, PERIOD_CURRENT, 20, 0, 2.0, PRICE_CLOSE);
   if(handleBB == INVALID_HANDLE) { Print("Error creando Bollinger"); return INIT_FAILED; }` : ''}
${indicators.includes('atr') ? `   handleATR = iATR(InpSymbol, PERIOD_CURRENT, 14);
   if(handleATR == INVALID_HANDLE) { Print("Error creando ATR"); return INIT_FAILED; }` : ''}

   initialBalance = AccountInfoDouble(ACCOUNT_BALANCE);
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
${indicators.includes('rsi') ? '   IndicatorRelease(handleRSI);' : ''}
${indicators.includes('ema') ? '   IndicatorRelease(handleEMA_fast);\n   IndicatorRelease(handleEMA_slow);' : ''}
${indicators.includes('macd') ? '   IndicatorRelease(handleMACD);' : ''}
${indicators.includes('bb') ? '   IndicatorRelease(handleBB);' : ''}
${indicators.includes('atr') ? '   IndicatorRelease(handleATR);' : ''}
}

//+------------------------------------------------------------------+
//| Comprueba si el nombre del evento coincide con alguno de los     |
//| patrones (separados por "||"), comparación case-insensitive.     |
//+------------------------------------------------------------------+
bool EventMatchesPatterns(const string eventName, const string patterns)
{
   if(StringLen(patterns) == 0) return true; // Sin filtro, todos pasan
   string lname = eventName;
   StringToLower(lname);

   string parts[];
   int n = StringSplit(patterns, '|', parts);
   for(int i = 0; i < n; i++)
   {
      string p = parts[i];
      if(StringLen(p) == 0) continue;
      string lp = p;
      StringToLower(lp);
      if(StringFind(lname, lp) >= 0) return true;
   }
   return false;
}

//+------------------------------------------------------------------+
//| Filtro de noticias: usa el calendario económico de MetaTrader    |
//| para evitar operar en ventanas alrededor de eventos relevantes.  |
//+------------------------------------------------------------------+
bool IsNewsTime()
{
   if(!InpFilterNews) return false;

   // Buscar la divisa base y cotizada del símbolo (ej. EURUSD → EUR, USD)
   string base = StringSubstr(InpSymbol, 0, 3);
   string quote = StringSubstr(InpSymbol, 3, 3);

   datetime fromTime = TimeCurrent() - InpNewsMinutesAfter * 60;
   datetime toTime   = TimeCurrent() + InpNewsMinutesBefore * 60;

   string countries[2] = { base, quote };
   for(int c = 0; c < 2; c++)
   {
      MqlCalendarValue values[];
      int n = CalendarValueHistory(values, fromTime, toTime, NULL, countries[c]);
      for(int i = 0; i < n; i++)
      {
         MqlCalendarEvent ev;
         if(!CalendarEventById(values[i].event_id, ev)) continue;
         if(ev.importance < InpNewsMinImpact) continue;

         // Si el usuario pidió filtrar por evento específico, comprueba el nombre
         if(InpNewsFilterByName && !EventMatchesPatterns(ev.name, InpNewsPatterns))
            continue;

         long evTime = (long)values[i].time;
         long now    = (long)TimeCurrent();
         long diff   = evTime - now;
         if(diff <= InpNewsMinutesBefore * 60 && diff >= -InpNewsMinutesAfter * 60)
         {
            return true;
         }
      }
   }
   return false;
}

//+------------------------------------------------------------------+
//| Verificar pérdida diaria máxima                                  |
//+------------------------------------------------------------------+
bool CheckDailyLoss()
{
   MqlDateTime dt;
   TimeToStruct(TimeCurrent(), dt);
   MqlDateTime lastDt;
   TimeToStruct(lastDayCheck, lastDt);

   // Reset diario
   if(dt.day != lastDt.day)
   {
      dailyStartBalance = AccountInfoDouble(ACCOUNT_BALANCE);
      lastDayCheck = TimeCurrent();
   }

   double currentBalance = AccountInfoDouble(ACCOUNT_BALANCE);
   double dailyLossPct = ((dailyStartBalance - currentBalance) / dailyStartBalance) * 100.0;

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
   MqlDateTime dt;
   TimeToStruct(TimeCurrent(), dt);
   return (dt.hour >= InpStartHour && dt.hour < InpEndHour);
}

//+------------------------------------------------------------------+
//| Calcular tamaño de lote según riesgo                             |
//+------------------------------------------------------------------+
double CalculateLotSize(double stopLossPips)
{
   double balance = AccountInfoDouble(ACCOUNT_BALANCE);
   double riskAmount = balance * (InpRiskPerTrade / 100.0);
   double tickValue = SymbolInfoDouble(InpSymbol, SYMBOL_TRADE_TICK_VALUE);
   double tickSize = SymbolInfoDouble(InpSymbol, SYMBOL_TRADE_TICK_SIZE);
   double lot = NormalizeDouble(riskAmount / (stopLossPips * tickValue), 2);

   double minLot = SymbolInfoDouble(InpSymbol, SYMBOL_VOLUME_MIN);
   double maxLot = SymbolInfoDouble(InpSymbol, SYMBOL_VOLUME_MAX);
   if(lot < minLot) lot = minLot;
   if(lot > maxLot) lot = maxLot;

   return lot;
}

//+------------------------------------------------------------------+
//| Lógica principal de la estrategia                                |
//+------------------------------------------------------------------+
void OnTick()
{
   if(!CheckDailyLoss()) return;
   if(!IsTradingHours()) return;
   if(IsNewsTime()) return; // Pausado por noticia inminente / reciente
   if(PositionsTotal() > 0) return; // Solo una posición a la vez

   // Verificar si hay nuevas barras
   static datetime lastBarTime = 0;
   datetime currentBarTime = (datetime)SeriesInfoInteger(InpSymbol, PERIOD_CURRENT, SERIES_LASTBAR_DATE);
   if(currentBarTime == lastBarTime) return;
   lastBarTime = currentBarTime;

   //--- Obtener señales según estrategia: ${strategyDescriptions[strategy] || strategy}
   bool buySignal = false;
   bool sellSignal = false;

${generateStrategyLogic(strategy, indicators)}

   //--- Ejecutar órdenes
   if(buySignal)
   {
      double ask = SymbolInfoDouble(InpSymbol, SYMBOL_ASK);
      double sl = ask * (1 - InpStopLoss/100.0);
      double tp = ask * (1 + InpTakeProfit/100.0);
      double lot = CalculateLotSize(MathAbs(ask - sl) / SymbolInfoDouble(InpSymbol, SYMBOL_POINT));
      trade.Buy(lot, InpSymbol, ask, sl, tp, "${bot.name} BUY");
   }
   else if(sellSignal)
   {
      double bid = SymbolInfoDouble(InpSymbol, SYMBOL_BID);
      double sl = bid * (1 + InpStopLoss/100.0);
      double tp = bid * (1 - InpTakeProfit/100.0);
      double lot = CalculateLotSize(MathAbs(sl - bid) / SymbolInfoDouble(InpSymbol, SYMBOL_POINT));
      trade.Sell(lot, InpSymbol, bid, sl, tp, "${bot.name} SELL");
   }
}

//+------------------------------------------------------------------+
//| END OF FILE — Generado por YudBot                             |
//+------------------------------------------------------------------+
`;
}

// Genera la lógica específica de la estrategia
function generateStrategyLogic(strategy: string, indicators: string[]): string {
  const hasRSI = indicators.includes('rsi');
  const hasEMA = indicators.includes('ema');
  const hasMACD = indicators.includes('macd');
  const hasBB = indicators.includes('bb');

  if (strategy === 'scalping' || strategy === 'momentum') {
    return `   // Estrategia: ${strategy}
   double rsi[], emaFast[], emaSlow[];
${hasRSI ? '   CopyBuffer(handleRSI, 0, 0, 2, rsi);' : ''}
${hasEMA ? '   CopyBuffer(handleEMA_fast, 0, 0, 2, emaFast);\n   CopyBuffer(handleEMA_slow, 0, 0, 2, emaSlow);' : ''}

${hasRSI && hasEMA ? `   // Buy: RSI < 30 y EMA rápida > EMA lenta
   if(rsi[0] < 30 && emaFast[0] > emaSlow[0]) buySignal = true;
   // Sell: RSI > 70 y EMA rápida < EMA lenta
   if(rsi[0] > 70 && emaFast[0] < emaSlow[0]) sellSignal = true;` :
   hasRSI ? `   // Buy: RSI < 30 (sobrevendido)
   if(rsi[0] < 30) buySignal = true;
   // Sell: RSI > 70 (sobrecomprado)
   if(rsi[0] > 70) sellSignal = true;` :
   hasEMA ? `   // Buy: cruce alcista de EMAs
   if(emaFast[0] > emaSlow[0] && emaFast[1] <= emaSlow[1]) buySignal = true;
   // Sell: cruce bajista de EMAs
   if(emaFast[0] < emaSlow[0] && emaFast[1] >= emaSlow[1]) sellSignal = true;` :
   `   // Sin indicadores configurados — agrega RSI o EMA al bot
   buySignal = false;
   sellSignal = false;`}`;
  }

  if (strategy === 'mean') {
    return `   // Estrategia: Mean Reversion
   double bb_upper[], bb_lower[], bb_middle[];
${hasBB ? '   CopyBuffer(handleBB, UPPER_BAND, 0, 1, bb_upper);\n   CopyBuffer(handleBB, LOWER_BAND, 0, 1, bb_lower);\n   CopyBuffer(handleBB, BASE_LINE, 0, 1, bb_middle);' : ''}
   double price = SymbolInfoDouble(InpSymbol, SYMBOL_BID);

${hasBB ? `   // Buy: precio toca banda inferior
   if(price <= bb_lower[0]) buySignal = true;
   // Sell: precio toca banda superior
   if(price >= bb_upper[0]) sellSignal = true;` : `   // Activa Bollinger Bands para esta estrategia`}`;
  }

  if (strategy === 'breakout') {
    return `   // Estrategia: Breakout
   double high20 = iHigh(InpSymbol, PERIOD_CURRENT, iHighest(InpSymbol, PERIOD_CURRENT, MODE_HIGH, 20, 1));
   double low20  = iLow(InpSymbol, PERIOD_CURRENT, iLowest(InpSymbol, PERIOD_CURRENT, MODE_LOW, 20, 1));
   double price  = SymbolInfoDouble(InpSymbol, SYMBOL_BID);

   // Buy: ruptura de máximo de 20 velas
   if(price > high20) buySignal = true;
   // Sell: ruptura de mínimo de 20 velas
   if(price < low20) sellSignal = true;`;
  }

  // Default: lógica genérica
  return `   // Lógica de estrategia genérica
   // TODO: Personalizar según ${strategy}
   ${hasRSI ? `double rsi[]; CopyBuffer(handleRSI, 0, 0, 1, rsi);
   if(rsi[0] < 30) buySignal = true;
   if(rsi[0] > 70) sellSignal = true;` : 'buySignal = false; sellSignal = false;'}`;
}
