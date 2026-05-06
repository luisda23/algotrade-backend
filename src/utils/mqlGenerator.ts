// mqlGenerator.ts — Genera código MQL5 desde la config del bot
//
// Arquitectura trigger+filter:
//   Cada indicador define hasta 4 condiciones por dirección:
//     triggerBuy / triggerSell  → fire on transition (cruce, flip, bounce)
//     filterBuy / filterSell    → continuous (mientras el estado se cumple)
//
//   La lógica final del bot:
//     buySignal = (al menos un trigger fire) AND (todos los filtros agree)
//
//   Si el usuario solo elige indicadores de tipo filtro → AND de filtros
//   Si solo elige triggers → OR de triggers
//   Si mezcla → trigger fire + filtros confirman
//
//   Esto permite combinar 24 indicadores cualquiera de forma sensata:
//   p.ej. MACD-trigger + RSI-filter + Fib-trigger → entra cuando MACD cruzó
//   o el precio toca Fib mientras RSI está sobrevendido.

import { MQL_COPY, Lang, strategyDesc } from './mqlCopy';

interface BotParams {
  market?: string;
  pair?: string;
  leverage?: number;
  indicators?: string[];
  timeframe?: 'M1' | 'M5' | 'M15' | 'M30' | 'H1' | 'H4' | 'D1';
  lot?: { mode?: 'auto' | 'fixed'; fixedLot?: number };
  risk?: { stopLoss?: number; takeProfit?: number; posSize?: number; dailyLoss?: number };
  news?: {
    enabled?: boolean;
    beforeMin?: number;
    afterMin?: number;
    impactMin?: 'high' | 'medium' | 'all';
    events?: string[];
  };
  funded?: { enabled?: boolean; firm?: string };
}

const TIMEFRAME_TO_MQL: Record<string, string> = {
  M1: 'PERIOD_M1', M5: 'PERIOD_M5', M15: 'PERIOD_M15', M30: 'PERIOD_M30',
  H1: 'PERIOD_H1', H4: 'PERIOD_H4', D1: 'PERIOD_D1',
};
const STRATEGY_DEFAULT_TIMEFRAME: Record<string, string> = {
  scalping: 'M5', momentum: 'M15', mean: 'M15', breakout: 'H1',
  swing: 'H4', trend: 'H1', reversal: 'M30', grid: 'M15',
  dca: 'H4', hedge: 'H1',
};

// Escapa una cadena para que sea segura como literal MQL5/MQL4 (backslash y
// comillas dobles). Sin esto, un usuario podría poner un nombre como
// `Bot "Pro"` y el .mq5 no compilaría.
function escapeMQL(s: string): string {
  if (!s) return '';
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

type IndDef = {
  globals?: string;
  init?: string;
  release?: string;
  logic: (strategy: string) => {
    setup: string[];
    triggerBuy?: string;
    triggerSell?: string;
    filterBuy?: string;
    filterSell?: string;
  };
};

const isReversal = (s: string) => s === 'mean' || s === 'reversal';

const INDICATOR_DEFS_MQL5: Record<string, IndDef> = {
  // ─── MOMENTUM ───
  rsi: {
    globals: 'int handleRSI;',
    init: '   handleRSI = iRSI(InpSymbol, InpTimeframe, 14, PRICE_CLOSE);\n   if(handleRSI == INVALID_HANDLE) { Print("Error creando RSI"); return INIT_FAILED; }',
    release: '   IndicatorRelease(handleRSI);',
    logic: (s) => {
      const lo = isReversal(s) ? 35 : 30;
      const hi = isReversal(s) ? 65 : 70;
      return {
        setup: [`double rsi[]; ArraySetAsSeries(rsi, true); CopyBuffer(handleRSI, 0, 0, 3, rsi);`],
        // Trigger en barras cerradas ([1] vs [2]): cruce confirmado al cierre.
        // Usar [0] (barra recién abierta) detectaría apenas crosses porque
        // el indicador en bar 0 es casi idéntico al de bar 1.
        triggerBuy:  `(rsi[1] < ${lo} && rsi[2] >= ${lo})`,
        triggerSell: `(rsi[1] > ${hi} && rsi[2] <= ${hi})`,
        filterBuy:   `rsi[1] < ${lo + 10}`,
        filterSell:  `rsi[1] > ${hi - 10}`,
      };
    },
  },
  stoch: {
    globals: 'int handleStoch;',
    init: '   handleStoch = iStochastic(InpSymbol, InpTimeframe, 5, 3, 3, MODE_SMA, STO_LOWHIGH);\n   if(handleStoch == INVALID_HANDLE) { Print("Error creando Stochastic"); return INIT_FAILED; }',
    release: '   IndicatorRelease(handleStoch);',
    logic: (s) => {
      const lo = isReversal(s) ? 25 : 20;
      const hi = isReversal(s) ? 75 : 80;
      return {
        setup: [
          `double stochMain[], stochSignal[]; ArraySetAsSeries(stochMain, true); ArraySetAsSeries(stochSignal, true);`,
          `CopyBuffer(handleStoch, 0, 0, 3, stochMain);`,
          `CopyBuffer(handleStoch, 1, 0, 3, stochSignal);`,
        ],
        triggerBuy:  `(stochMain[1] > stochSignal[1] && stochMain[2] <= stochSignal[2] && stochMain[1] < ${lo + 30})`,
        triggerSell: `(stochMain[1] < stochSignal[1] && stochMain[2] >= stochSignal[2] && stochMain[1] > ${hi - 30})`,
        filterBuy:   `stochMain[1] < ${lo + 20}`,
        filterSell:  `stochMain[1] > ${hi - 20}`,
      };
    },
  },
  stochrsi: {
    globals: 'int handleStochRSI_internalRSI;',
    init: '   handleStochRSI_internalRSI = iRSI(InpSymbol, InpTimeframe, 14, PRICE_CLOSE);\n   if(handleStochRSI_internalRSI == INVALID_HANDLE) { Print("Error creando Stoch RSI"); return INIT_FAILED; }',
    release: '   IndicatorRelease(handleStochRSI_internalRSI);',
    logic: (s) => {
      const lo = isReversal(s) ? 25 : 20;
      const hi = isReversal(s) ? 75 : 80;
      return {
        setup: [
          // Pedimos 17 valores RSI (barras 0 a 16) para calcular el Stoch RSI
          // de las últimas 3 barras CERRADAS (índices 1, 2, 3 con sus ventanas
          // de 14 RSI). Bar 0 (forming) se ignora porque su valor casi no
          // cambia respecto a bar 1.
          `double srsi_rsi[]; ArraySetAsSeries(srsi_rsi, true); CopyBuffer(handleStochRSI_internalRSI, 0, 0, 17, srsi_rsi);`,
          `double srsi_K_raw[3];`,
          `for(int sri = 1; sri <= 3; sri++) {`,
          `   double sri_lo = srsi_rsi[sri], sri_hi = srsi_rsi[sri];`,
          `   for(int sri2 = sri; sri2 < sri + 14; sri2++) { if(srsi_rsi[sri2] < sri_lo) sri_lo = srsi_rsi[sri2]; if(srsi_rsi[sri2] > sri_hi) sri_hi = srsi_rsi[sri2]; }`,
          `   srsi_K_raw[sri - 1] = (sri_hi > sri_lo) ? (srsi_rsi[sri] - sri_lo) / (sri_hi - sri_lo) * 100.0 : 50.0;`,
          `}`,
          `double srsi_K = (srsi_K_raw[0] + srsi_K_raw[1] + srsi_K_raw[2]) / 3.0;`,
          // Sembrar estado con valores reales en la primera evaluación, no con
          // 50 hardcoded — si el K real está lejos de 50 al cargar el bot,
          // genera un cruce falso espurio.
          `static double srsi_D_prev1 = 0.0, srsi_D_prev2 = 0.0;`,
          `static double srsi_K_prev = 0.0;`,
          `static bool srsi_init = false;`,
          `double srsi_D = (srsi_K + srsi_D_prev1 + srsi_D_prev2) / 3.0;`,
          `bool srsi_crossUp   = srsi_init && (srsi_K_prev <= srsi_D_prev1 && srsi_K > srsi_D);`,
          `bool srsi_crossDown = srsi_init && (srsi_K_prev >= srsi_D_prev1 && srsi_K < srsi_D);`,
          `srsi_D_prev2 = srsi_D_prev1; srsi_D_prev1 = srsi_D; srsi_K_prev = srsi_K; srsi_init = true;`,
        ],
        triggerBuy:  `(srsi_crossUp && srsi_K < ${lo + 30})`,
        triggerSell: `(srsi_crossDown && srsi_K > ${hi - 30})`,
        filterBuy:   `srsi_K < 50`,
        filterSell:  `srsi_K > 50`,
      };
    },
  },
  cci: {
    globals: 'int handleCCI;',
    init: '   handleCCI = iCCI(InpSymbol, InpTimeframe, 14, PRICE_TYPICAL);\n   if(handleCCI == INVALID_HANDLE) { Print("Error creando CCI"); return INIT_FAILED; }',
    release: '   IndicatorRelease(handleCCI);',
    logic: () => ({
      setup: [`double cci[]; ArraySetAsSeries(cci, true); CopyBuffer(handleCCI, 0, 0, 3, cci);`],
      triggerBuy:  `(cci[1] < -100 && cci[2] >= -100)`,
      triggerSell: `(cci[1] > 100  && cci[2] <= 100)`,
      filterBuy:   `cci[1] < 0`,
      filterSell:  `cci[1] > 0`,
    }),
  },
  williams: {
    globals: 'int handleWPR;',
    init: '   handleWPR = iWPR(InpSymbol, InpTimeframe, 14);\n   if(handleWPR == INVALID_HANDLE) { Print("Error creando Williams %R"); return INIT_FAILED; }',
    release: '   IndicatorRelease(handleWPR);',
    logic: () => ({
      setup: [`double wpr[]; ArraySetAsSeries(wpr, true); CopyBuffer(handleWPR, 0, 0, 3, wpr);`],
      triggerBuy:  `(wpr[1] < -80 && wpr[2] >= -80)`,
      triggerSell: `(wpr[1] > -20 && wpr[2] <= -20)`,
      filterBuy:   `wpr[1] < -50`,
      filterSell:  `wpr[1] > -50`,
    }),
  },
  roc: {
    globals: 'int handleMomentum;',
    init: '   handleMomentum = iMomentum(InpSymbol, InpTimeframe, 14, PRICE_CLOSE);\n   if(handleMomentum == INVALID_HANDLE) { Print("Error creando ROC"); return INIT_FAILED; }',
    release: '   IndicatorRelease(handleMomentum);',
    logic: () => ({
      setup: [
        `double momBuf[]; ArraySetAsSeries(momBuf, true); CopyBuffer(handleMomentum, 0, 0, 3, momBuf);`,
        `double roc = momBuf[1] - 100.0;`,
        `double rocPrev = momBuf[2] - 100.0;`,
      ],
      triggerBuy:  `(roc > 0 && rocPrev <= 0)`,
      triggerSell: `(roc < 0 && rocPrev >= 0)`,
      filterBuy:   `roc > 0`,
      filterSell:  `roc < 0`,
    }),
  },

  // ─── TENDENCIA ───
  ema: {
    globals: 'int handleEMA_fast;\nint handleEMA_slow;',
    init: '   handleEMA_fast = iMA(InpSymbol, InpTimeframe, 9, 0, MODE_EMA, PRICE_CLOSE);\n   handleEMA_slow = iMA(InpSymbol, InpTimeframe, 21, 0, MODE_EMA, PRICE_CLOSE);\n   if(handleEMA_fast == INVALID_HANDLE || handleEMA_slow == INVALID_HANDLE) { Print("Error creando EMA"); return INIT_FAILED; }',
    release: '   IndicatorRelease(handleEMA_fast);\n   IndicatorRelease(handleEMA_slow);',
    logic: () => ({
      setup: [
        `double emaFast[], emaSlow[]; ArraySetAsSeries(emaFast, true); ArraySetAsSeries(emaSlow, true);`,
        `CopyBuffer(handleEMA_fast, 0, 0, 3, emaFast);`,
        `CopyBuffer(handleEMA_slow, 0, 0, 3, emaSlow);`,
      ],
      triggerBuy:  `(emaFast[1] > emaSlow[1] && emaFast[2] <= emaSlow[2])`,
      triggerSell: `(emaFast[1] < emaSlow[1] && emaFast[2] >= emaSlow[2])`,
      filterBuy:   `emaFast[1] > emaSlow[1]`,
      filterSell:  `emaFast[1] < emaSlow[1]`,
    }),
  },
  sma: {
    globals: 'int handleSMA_fast;\nint handleSMA_slow;',
    init: '   handleSMA_fast = iMA(InpSymbol, InpTimeframe, 9, 0, MODE_SMA, PRICE_CLOSE);\n   handleSMA_slow = iMA(InpSymbol, InpTimeframe, 21, 0, MODE_SMA, PRICE_CLOSE);\n   if(handleSMA_fast == INVALID_HANDLE || handleSMA_slow == INVALID_HANDLE) { Print("Error creando SMA"); return INIT_FAILED; }',
    release: '   IndicatorRelease(handleSMA_fast);\n   IndicatorRelease(handleSMA_slow);',
    logic: () => ({
      setup: [
        `double smaFast[], smaSlow[]; ArraySetAsSeries(smaFast, true); ArraySetAsSeries(smaSlow, true);`,
        `CopyBuffer(handleSMA_fast, 0, 0, 3, smaFast);`,
        `CopyBuffer(handleSMA_slow, 0, 0, 3, smaSlow);`,
      ],
      triggerBuy:  `(smaFast[1] > smaSlow[1] && smaFast[2] <= smaSlow[2])`,
      triggerSell: `(smaFast[1] < smaSlow[1] && smaFast[2] >= smaSlow[2])`,
      filterBuy:   `smaFast[1] > smaSlow[1]`,
      filterSell:  `smaFast[1] < smaSlow[1]`,
    }),
  },
  macd: {
    globals: 'int handleMACD;',
    init: '   handleMACD = iMACD(InpSymbol, InpTimeframe, 12, 26, 9, PRICE_CLOSE);\n   if(handleMACD == INVALID_HANDLE) { Print("Error creando MACD"); return INIT_FAILED; }',
    release: '   IndicatorRelease(handleMACD);',
    logic: () => ({
      setup: [
        `double macdMain[], macdSignal[]; ArraySetAsSeries(macdMain, true); ArraySetAsSeries(macdSignal, true);`,
        `CopyBuffer(handleMACD, 0, 0, 3, macdMain);`,
        `CopyBuffer(handleMACD, 1, 0, 3, macdSignal);`,
      ],
      triggerBuy:  `(macdMain[1] > macdSignal[1] && macdMain[2] <= macdSignal[2])`,
      triggerSell: `(macdMain[1] < macdSignal[1] && macdMain[2] >= macdSignal[2])`,
      filterBuy:   `macdMain[1] > macdSignal[1]`,
      filterSell:  `macdMain[1] < macdSignal[1]`,
    }),
  },
  adx: {
    globals: 'int handleADX;',
    init: '   handleADX = iADX(InpSymbol, InpTimeframe, 14);\n   if(handleADX == INVALID_HANDLE) { Print("Error creando ADX"); return INIT_FAILED; }',
    release: '   IndicatorRelease(handleADX);',
    logic: () => ({
      setup: [
        `double adxMain[], adxPlus[], adxMinus[]; ArraySetAsSeries(adxMain, true); ArraySetAsSeries(adxPlus, true); ArraySetAsSeries(adxMinus, true);`,
        `CopyBuffer(handleADX, 0, 0, 3, adxMain);`,
        `CopyBuffer(handleADX, 1, 0, 3, adxPlus);`,
        `CopyBuffer(handleADX, 2, 0, 3, adxMinus);`,
      ],
      triggerBuy:  `(adxPlus[1] > adxMinus[1] && adxPlus[2] <= adxMinus[2] && adxMain[1] > 20)`,
      triggerSell: `(adxPlus[1] < adxMinus[1] && adxPlus[2] >= adxMinus[2] && adxMain[1] > 20)`,
      filterBuy:   `(adxMain[1] > 20 && adxPlus[1] > adxMinus[1])`,
      filterSell:  `(adxMain[1] > 20 && adxPlus[1] < adxMinus[1])`,
    }),
  },
  ichi: {
    globals: 'int handleIchi;',
    init: '   handleIchi = iIchimoku(InpSymbol, InpTimeframe, 9, 26, 52);\n   if(handleIchi == INVALID_HANDLE) { Print("Error creando Ichimoku"); return INIT_FAILED; }',
    release: '   IndicatorRelease(handleIchi);',
    logic: () => ({
      setup: [
        // Senkou A/B vienen ya proyectados +26 barras al futuro: el index 0
        // del buffer es el cloud que estará vigente DENTRO de 26 barras. Para
        // comparar el precio actual contra el cloud actual hay que leer con
        // shift = Kijun period (26).
        `double ichiTenkan[], ichiKijun[], ichiSenkouA[], ichiSenkouB[]; ArraySetAsSeries(ichiTenkan, true); ArraySetAsSeries(ichiKijun, true); ArraySetAsSeries(ichiSenkouA, true); ArraySetAsSeries(ichiSenkouB, true);`,
        `CopyBuffer(handleIchi, 0, 0, 3, ichiTenkan);`,
        `CopyBuffer(handleIchi, 1, 0, 3, ichiKijun);`,
        `CopyBuffer(handleIchi, 2, 26, 1, ichiSenkouA);`,
        `CopyBuffer(handleIchi, 3, 26, 1, ichiSenkouB);`,
      ],
      triggerBuy:  `(ichiTenkan[1] > ichiKijun[1] && ichiTenkan[2] <= ichiKijun[2] && bidPrice > ichiSenkouA[0] && bidPrice > ichiSenkouB[0])`,
      triggerSell: `(ichiTenkan[1] < ichiKijun[1] && ichiTenkan[2] >= ichiKijun[2] && bidPrice < ichiSenkouA[0] && bidPrice < ichiSenkouB[0])`,
      filterBuy:   `(ichiTenkan[1] > ichiKijun[1] && bidPrice > ichiSenkouA[0] && bidPrice > ichiSenkouB[0])`,
      filterSell:  `(ichiTenkan[1] < ichiKijun[1] && bidPrice < ichiSenkouA[0] && bidPrice < ichiSenkouB[0])`,
    }),
  },
  psar: {
    globals: 'int handleSAR;',
    init: '   handleSAR = iSAR(InpSymbol, InpTimeframe, 0.02, 0.2);\n   if(handleSAR == INVALID_HANDLE) { Print("Error creando Parabolic SAR"); return INIT_FAILED; }',
    release: '   IndicatorRelease(handleSAR);',
    logic: () => ({
      setup: [
        `double sar[]; ArraySetAsSeries(sar, true); CopyBuffer(handleSAR, 0, 0, 3, sar);`,
        `double psarPrevClose = iClose(InpSymbol, InpTimeframe, 1);`,
        `double psarPrevPrevClose = iClose(InpSymbol, InpTimeframe, 2);`,
      ],
      // Trigger: SAR cambió de lado en barra 1 (close[1] > sar[1] mientras antes close[2] <= sar[2])
      triggerBuy:  `(psarPrevClose > sar[1] && psarPrevPrevClose <= sar[2])`,
      triggerSell: `(psarPrevClose < sar[1] && psarPrevPrevClose >= sar[2])`,
      // Filter: cierre de la última barra cerrada vs su SAR
      filterBuy:   `psarPrevClose > sar[1]`,
      filterSell:  `psarPrevClose < sar[1]`,
    }),
  },
  supertrend: {
    globals: 'int handleST_ATR;',
    init: '   handleST_ATR = iATR(InpSymbol, InpTimeframe, 10);\n   if(handleST_ATR == INVALID_HANDLE) { Print("Error creando SuperTrend"); return INIT_FAILED; }',
    release: '   IndicatorRelease(handleST_ATR);',
    logic: () => ({
      setup: [
        // ATR de la barra cerrada (shift=1). Si lo leyéramos en shift 0, el
        // valor cambia con cada tick y st_line/st_dir repintarían dentro de
        // la misma barra, dando flips fantasma.
        `double stAtrBuf[]; ArraySetAsSeries(stAtrBuf, true); CopyBuffer(handleST_ATR, 0, 1, 1, stAtrBuf);`,
        `double stMid = (iHigh(InpSymbol, InpTimeframe, 1) + iLow(InpSymbol, InpTimeframe, 1)) / 2.0;`,
        `double stClosePrev = iClose(InpSymbol, InpTimeframe, 1);`,
        `double stBasicUp = stMid + 3.0 * stAtrBuf[0];`,
        `double stBasicDn = stMid - 3.0 * stAtrBuf[0];`,
        `static double st_line = 0;`,
        `static int st_dir = 0;`,
        `static bool st_init = false;`,
        `int st_prevDir = st_dir;`,
        `if(!st_init) {`,
        `   st_dir = (stClosePrev > stMid) ? 1 : -1;`,
        `   st_line = (st_dir == 1) ? stBasicDn : stBasicUp;`,
        `   st_prevDir = st_dir; // sin flip espurio en la primera barra`,
        `   st_init = true;`,
        `} else if(st_dir == 1) {`,
        `   double newLine = MathMax(stBasicDn, st_line);`,
        `   if(stClosePrev < newLine) { st_dir = -1; st_line = stBasicUp; } else { st_line = newLine; }`,
        `} else {`,
        `   double newLine = MathMin(stBasicUp, st_line);`,
        `   if(stClosePrev > newLine) { st_dir = 1; st_line = stBasicDn; } else { st_line = newLine; }`,
        `}`,
      ],
      triggerBuy:  `(st_dir == 1 && st_prevDir != 1)`,
      triggerSell: `(st_dir == -1 && st_prevDir != -1)`,
      filterBuy:   `st_dir == 1`,
      filterSell:  `st_dir == -1`,
    }),
  },

  // ─── VOLATILIDAD ───
  bb: {
    globals: 'int handleBB;',
    init: '   handleBB = iBands(InpSymbol, InpTimeframe, 20, 0, 2.0, PRICE_CLOSE);\n   if(handleBB == INVALID_HANDLE) { Print("Error creando Bollinger"); return INIT_FAILED; }',
    release: '   IndicatorRelease(handleBB);',
    logic: (s) => {
      // Bandas leídas en barras CERRADAS (shift 1 y 2): así el breakout no
      // repinta dentro de la barra que se está formando. arr[0]=bar1, arr[1]=bar2.
      const setup = [
        `double bbUpper[], bbLower[], bbMiddle[]; ArraySetAsSeries(bbUpper, true); ArraySetAsSeries(bbLower, true); ArraySetAsSeries(bbMiddle, true);`,
        `CopyBuffer(handleBB, UPPER_BAND, 1, 2, bbUpper);`,
        `CopyBuffer(handleBB, LOWER_BAND, 1, 2, bbLower);`,
        `CopyBuffer(handleBB, BASE_LINE, 1, 2, bbMiddle);`,
        `double bbPrevClose     = iClose(InpSymbol, InpTimeframe, 1);`,
        `double bbPrevPrevClose = iClose(InpSymbol, InpTimeframe, 2);`,
      ];
      if (isReversal(s)) {
        return {
          setup,
          triggerBuy:  `(bbPrevClose <= bbLower[0] && bbPrevPrevClose > bbLower[1])`,
          triggerSell: `(bbPrevClose >= bbUpper[0] && bbPrevPrevClose < bbUpper[1])`,
          filterBuy:   `bbPrevClose <= bbMiddle[0]`,
          filterSell:  `bbPrevClose >= bbMiddle[0]`,
        };
      }
      return {
        setup,
        triggerBuy:  `(bbPrevClose >= bbUpper[0] && bbPrevPrevClose < bbUpper[1])`,
        triggerSell: `(bbPrevClose <= bbLower[0] && bbPrevPrevClose > bbLower[1])`,
        filterBuy:   `bbPrevClose >= bbMiddle[0]`,
        filterSell:  `bbPrevClose <= bbMiddle[0]`,
      };
    },
  },
  atr: {
    globals: 'int handleATR;',
    init: '   handleATR = iATR(InpSymbol, InpTimeframe, 14);\n   if(handleATR == INVALID_HANDLE) { Print("Error creando ATR"); return INIT_FAILED; }',
    release: '   IndicatorRelease(handleATR);',
    logic: () => ({
      // ATR es solo filtro: confirma que la volatilidad es operable.
      setup: [
        `double atrBuf[]; ArraySetAsSeries(atrBuf, true); CopyBuffer(handleATR, 0, 0, 50, atrBuf);`,
        `double atrAvg = 0; for(int aiI = 0; aiI < 50; aiI++) atrAvg += atrBuf[aiI]; atrAvg /= 50.0;`,
        `bool atrActive = (atrBuf[0] >= atrAvg * 0.5);`,
      ],
      filterBuy:  `atrActive`,
      filterSell: `atrActive`,
    }),
  },
  donchian: {
    logic: (s) => {
      const setup = [
        `double donHigh = iHigh(InpSymbol, InpTimeframe, iHighest(InpSymbol, InpTimeframe, MODE_HIGH, 20, 1));`,
        `double donLow  = iLow(InpSymbol, InpTimeframe, iLowest(InpSymbol, InpTimeframe, MODE_LOW, 20, 1));`,
      ];
      const buyPx = isReversal(s) ? `donLow` : `donHigh`;
      const sellPx = isReversal(s) ? `donHigh` : `donLow`;
      const buyOp = isReversal(s) ? `<=` : `>=`;
      const sellOp = isReversal(s) ? `>=` : `<=`;
      return {
        setup,
        triggerBuy:  `(bidPrice ${buyOp} ${buyPx})`,
        triggerSell: `(bidPrice ${sellOp} ${sellPx})`,
      };
    },
  },
  kc: {
    globals: 'int handleKC_EMA;\nint handleKC_ATR;',
    init: '   handleKC_EMA = iMA(InpSymbol, InpTimeframe, 20, 0, MODE_EMA, PRICE_CLOSE);\n   handleKC_ATR = iATR(InpSymbol, InpTimeframe, 10);\n   if(handleKC_EMA == INVALID_HANDLE || handleKC_ATR == INVALID_HANDLE) { Print("Error creando Keltner"); return INIT_FAILED; }',
    release: '   IndicatorRelease(handleKC_EMA);\n   IndicatorRelease(handleKC_ATR);',
    logic: (s) => {
      // EMA y ATR de barras CERRADAS (shift 1 y 2). arr[0]=bar1, arr[1]=bar2.
      const setup = [
        `double kcEma[], kcAtr[]; ArraySetAsSeries(kcEma, true); ArraySetAsSeries(kcAtr, true);`,
        `CopyBuffer(handleKC_EMA, 0, 1, 2, kcEma);`,
        `CopyBuffer(handleKC_ATR, 0, 1, 2, kcAtr);`,
        `double kcUpper      = kcEma[0] + 2.0 * kcAtr[0];`,
        `double kcLower      = kcEma[0] - 2.0 * kcAtr[0];`,
        `double kcUpperPrev  = kcEma[1] + 2.0 * kcAtr[1];`,
        `double kcLowerPrev  = kcEma[1] - 2.0 * kcAtr[1];`,
        `double kcPrevClose     = iClose(InpSymbol, InpTimeframe, 1);`,
        `double kcPrevPrevClose = iClose(InpSymbol, InpTimeframe, 2);`,
      ];
      if (isReversal(s)) {
        return {
          setup,
          triggerBuy:  `(kcPrevClose <= kcLower && kcPrevPrevClose > kcLowerPrev)`,
          triggerSell: `(kcPrevClose >= kcUpper && kcPrevPrevClose < kcUpperPrev)`,
          filterBuy:   `kcPrevClose <= kcEma[0]`,
          filterSell:  `kcPrevClose >= kcEma[0]`,
        };
      }
      return {
        setup,
        triggerBuy:  `(kcPrevClose >= kcUpper && kcPrevPrevClose < kcUpperPrev)`,
        triggerSell: `(kcPrevClose <= kcLower && kcPrevPrevClose > kcLowerPrev)`,
        filterBuy:   `kcPrevClose >= kcEma[0]`,
        filterSell:  `kcPrevClose <= kcEma[0]`,
      };
    },
  },

  // ─── VOLUMEN ───
  vol: {
    logic: () => ({
      setup: [
        // Importante: iVolume(symbol, period, 0) es la barra RECIÉN ABIERTA
        // y casi siempre es ~0. Usamos bar 1 (cerrada) como volumen "actual"
        // para spike detection, comparado contra la media de barras 2-21.
        `long volNow = iVolume(InpSymbol, InpTimeframe, 1);`,
        `long volAvg = 0; for(int viI = 2; viI <= 21; viI++) volAvg += iVolume(InpSymbol, InpTimeframe, viI); volAvg /= 20;`,
        `bool volSpike = (volNow > volAvg * 1.5);`,
        `double volHi5 = iHigh(InpSymbol, InpTimeframe, iHighest(InpSymbol, InpTimeframe, MODE_HIGH, 5, 1));`,
        `double volLo5 = iLow(InpSymbol, InpTimeframe, iLowest(InpSymbol, InpTimeframe, MODE_LOW, 5, 1));`,
      ],
      triggerBuy:  `(volSpike && bidPrice > volHi5)`,
      triggerSell: `(volSpike && bidPrice < volLo5)`,
      filterBuy:   `volSpike`,
      filterSell:  `volSpike`,
    }),
  },
  obv: {
    globals: 'int handleOBV;',
    init: '   handleOBV = iOBV(InpSymbol, InpTimeframe, VOLUME_TICK);\n   if(handleOBV == INVALID_HANDLE) { Print("Error creando OBV"); return INIT_FAILED; }',
    release: '   IndicatorRelease(handleOBV);',
    logic: () => ({
      // Usamos bar 1 (cerrada) y promedio sobre bars 1-20 para evitar que
      // el OBV de la barra recién abierta distorsione la lectura.
      setup: [
        `double obv[]; ArraySetAsSeries(obv, true); CopyBuffer(handleOBV, 0, 0, 21, obv);`,
        `double obvAvg = 0; for(int oiI = 1; oiI <= 20; oiI++) obvAvg += obv[oiI]; obvAvg /= 20.0;`,
      ],
      filterBuy:  `obv[1] > obvAvg`,
      filterSell: `obv[1] < obvAvg`,
    }),
  },
  vwap: {
    logic: () => ({
      // VWAP intra-día con WARM-UP: si el bot se carga a media sesión, sin
      // back-fill el acumulado arrancaría en 0 y el VWAP sería inútil hasta
      // acumular suficiente. Aquí, al cambiar de día (o en la primera
      // ejecución) reconstruimos cumPV/cumV recorriendo todas las barras
      // cerradas del día actual desde la 00:00.
      setup: [
        `MqlDateTime vwap_dt; TimeToStruct(TimeCurrent(), vwap_dt);`,
        `int vwap_today = vwap_dt.year * 10000 + vwap_dt.mon * 100 + vwap_dt.day;`,
        `static int vwap_day = 0;`,
        `static double vwap_cumPV = 0;`,
        `static double vwap_cumV = 0;`,
        `static double vwap_prev = 0;`,
        `static double vwap_prevPrice = 0;`,
        `if(vwap_today != vwap_day) {`,
        `   vwap_cumPV = 0; vwap_cumV = 0; vwap_day = vwap_today;`,
        `   // Back-fill: sumar TP*V de cada barra cerrada del día actual.`,
        `   datetime vwap_dayStart = StructToTime(vwap_dt) - vwap_dt.hour*3600 - vwap_dt.min*60 - vwap_dt.sec;`,
        `   for(int vbi = 1; vbi < 10000; vbi++) {`,
        `      datetime vbT = iTime(InpSymbol, InpTimeframe, vbi);`,
        `      if(vbT == 0 || vbT < vwap_dayStart) break;`,
        `      double vbTp = (iHigh(InpSymbol, InpTimeframe, vbi) + iLow(InpSymbol, InpTimeframe, vbi) + iClose(InpSymbol, InpTimeframe, vbi)) / 3.0;`,
        `      long vbV = iVolume(InpSymbol, InpTimeframe, vbi);`,
        `      vwap_cumPV += vbTp * vbV;`,
        `      vwap_cumV  += vbV;`,
        `   }`,
        `} else {`,
        `   // Mismo día: solo sumamos la barra recién cerrada (bar 1).`,
        `   double vwap_tp = (iHigh(InpSymbol, InpTimeframe, 1) + iLow(InpSymbol, InpTimeframe, 1) + iClose(InpSymbol, InpTimeframe, 1)) / 3.0;`,
        `   long vwap_v = iVolume(InpSymbol, InpTimeframe, 1);`,
        `   vwap_cumPV += vwap_tp * vwap_v;`,
        `   vwap_cumV  += vwap_v;`,
        `}`,
        `double vwap = (vwap_cumV > 0) ? vwap_cumPV / vwap_cumV : bidPrice;`,
        `bool vwap_crossUp   = (vwap_prev > 0 && vwap_prevPrice <= vwap_prev && bidPrice > vwap);`,
        `bool vwap_crossDown = (vwap_prev > 0 && vwap_prevPrice >= vwap_prev && bidPrice < vwap);`,
        `vwap_prev = vwap; vwap_prevPrice = bidPrice;`,
      ],
      triggerBuy:  `vwap_crossUp`,
      triggerSell: `vwap_crossDown`,
      filterBuy:   `bidPrice > vwap`,
      filterSell:  `bidPrice < vwap`,
    }),
  },
  mfi: {
    globals: 'int handleMFI;',
    init: '   handleMFI = iMFI(InpSymbol, InpTimeframe, 14, VOLUME_TICK);\n   if(handleMFI == INVALID_HANDLE) { Print("Error creando MFI"); return INIT_FAILED; }',
    release: '   IndicatorRelease(handleMFI);',
    logic: (s) => {
      const lo = isReversal(s) ? 25 : 20;
      const hi = isReversal(s) ? 75 : 80;
      return {
        setup: [`double mfi[]; ArraySetAsSeries(mfi, true); CopyBuffer(handleMFI, 0, 0, 3, mfi);`],
        triggerBuy:  `(mfi[1] < ${lo} && mfi[2] >= ${lo})`,
        triggerSell: `(mfi[1] > ${hi} && mfi[2] <= ${hi})`,
        filterBuy:   `mfi[1] < 50`,
        filterSell:  `mfi[1] > 50`,
      };
    },
  },

  // ─── SOPORTE / RESISTENCIA (solo trigger, no continuos) ───
  fib: {
    globals: 'int handleFib_Fractals;',
    init: '   handleFib_Fractals = iFractals(InpSymbol, InpTimeframe);\n   if(handleFib_Fractals == INVALID_HANDLE) { Print("Error creando Fib Fractals"); return INIT_FAILED; }',
    release: '   IndicatorRelease(handleFib_Fractals);',
    logic: () => ({
      setup: [
        `double fibUp[], fibDn[]; ArraySetAsSeries(fibUp, true); ArraySetAsSeries(fibDn, true);`,
        `CopyBuffer(handleFib_Fractals, 0, 0, 100, fibUp);`,
        `CopyBuffer(handleFib_Fractals, 1, 0, 100, fibDn);`,
        `double fib_swingHigh = 0; int fib_swingHighBar = -1;`,
        `for(int fi = 2; fi < 100 && fib_swingHighBar == -1; fi++) {`,
        `   if(fibUp[fi] != EMPTY_VALUE && fibUp[fi] > 0) { fib_swingHigh = fibUp[fi]; fib_swingHighBar = fi; }`,
        `}`,
        `double fib_swingLow = 0; int fib_swingLowBar = -1;`,
        `for(int fj = 2; fj < 100 && fib_swingLowBar == -1; fj++) {`,
        `   if(fibDn[fj] != EMPTY_VALUE && fibDn[fj] > 0) { fib_swingLow = fibDn[fj]; fib_swingLowBar = fj; }`,
        `}`,
        `bool fib_uptrend = (fib_swingLowBar > fib_swingHighBar);`,
        `double fib_range = fib_swingHigh - fib_swingLow;`,
        `double fib_382 = fib_uptrend ? fib_swingHigh - fib_range * 0.382 : fib_swingLow + fib_range * 0.382;`,
        `double fib_50  = (fib_swingHigh + fib_swingLow) / 2.0;`,
        `double fib_618 = fib_uptrend ? fib_swingHigh - fib_range * 0.618 : fib_swingLow + fib_range * 0.618;`,
        `double fib_tol = fib_range * 0.04;`,
        `bool fib_atKeyLevel = (MathAbs(bidPrice - fib_382) < fib_tol || MathAbs(bidPrice - fib_50) < fib_tol || MathAbs(bidPrice - fib_618) < fib_tol);`,
      ],
      triggerBuy:  `(fib_range > 0 && fib_uptrend && fib_atKeyLevel)`,
      triggerSell: `(fib_range > 0 && !fib_uptrend && fib_atKeyLevel)`,
      filterBuy:   `(fib_range > 0 && fib_uptrend)`,   // mientras la tendencia sea alcista
      filterSell:  `(fib_range > 0 && !fib_uptrend)`,
    }),
  },
  pivots: {
    logic: () => ({
      setup: [
        `double piv_yH = iHigh(InpSymbol, PERIOD_D1, 1);`,
        `double piv_yL = iLow(InpSymbol, PERIOD_D1, 1);`,
        `double piv_yC = iClose(InpSymbol, PERIOD_D1, 1);`,
        `double piv_yRange = piv_yH - piv_yL;`,
        `double piv_P  = (piv_yH + piv_yL + piv_yC) / 3.0;`,
        `double piv_R1 = 2.0 * piv_P - piv_yL;`,
        `double piv_S1 = 2.0 * piv_P - piv_yH;`,
        `double piv_R2 = piv_P + piv_yRange;`,
        `double piv_S2 = piv_P - piv_yRange;`,
        `double piv_R3 = piv_yH + 2.0 * (piv_P - piv_yL);`,
        `double piv_S3 = piv_yL - 2.0 * (piv_yH - piv_P);`,
        `double piv_tol = piv_yRange * 0.08;`,
        `bool piv_nearS = (MathAbs(bidPrice - piv_S1) < piv_tol || MathAbs(bidPrice - piv_S2) < piv_tol || MathAbs(bidPrice - piv_S3) < piv_tol);`,
        `bool piv_nearR = (MathAbs(bidPrice - piv_R1) < piv_tol || MathAbs(bidPrice - piv_R2) < piv_tol || MathAbs(bidPrice - piv_R3) < piv_tol);`,
        `double piv_prevClose = iClose(InpSymbol, InpTimeframe, 1);`,
        `bool piv_bounceUp = (bidPrice > piv_prevClose);`,
        `bool piv_bounceDown = (bidPrice < piv_prevClose);`,
      ],
      triggerBuy:  `(piv_yRange > 0 && piv_nearS && piv_bounceUp)`,
      triggerSell: `(piv_yRange > 0 && piv_nearR && piv_bounceDown)`,
      // filter: precio en la mitad inferior (vendedor) o superior (compradora) del rango pivotal
      filterBuy:  `(piv_yRange > 0 && bidPrice < piv_P)`,
      filterSell: `(piv_yRange > 0 && bidPrice > piv_P)`,
    }),
  },
  sr: {
    globals: 'int handleSR_Fractals;\nint handleSR_ATR;',
    init: '   handleSR_Fractals = iFractals(InpSymbol, InpTimeframe);\n   handleSR_ATR = iATR(InpSymbol, InpTimeframe, 14);\n   if(handleSR_Fractals == INVALID_HANDLE || handleSR_ATR == INVALID_HANDLE) { Print("Error creando S/R"); return INIT_FAILED; }',
    release: '   IndicatorRelease(handleSR_Fractals);\n   IndicatorRelease(handleSR_ATR);',
    logic: () => ({
      setup: [
        `double srUpBuf[], srDnBuf[], srAtrBuf[];`,
        `ArraySetAsSeries(srUpBuf, true); ArraySetAsSeries(srDnBuf, true); ArraySetAsSeries(srAtrBuf, true);`,
        `CopyBuffer(handleSR_Fractals, 0, 0, 200, srUpBuf);`,
        `CopyBuffer(handleSR_Fractals, 1, 0, 200, srDnBuf);`,
        `CopyBuffer(handleSR_ATR, 0, 0, 1, srAtrBuf);`,
        `double srLevels[400]; int srLevelCount = 0;`,
        `for(int sri = 2; sri < 200 && srLevelCount < 400; sri++) {`,
        `   if(srUpBuf[sri] != EMPTY_VALUE && srUpBuf[sri] > 0) srLevels[srLevelCount++] = srUpBuf[sri];`,
        `   if(srDnBuf[sri] != EMPTY_VALUE && srDnBuf[sri] > 0) srLevels[srLevelCount++] = srDnBuf[sri];`,
        `}`,
        `double srTol = srAtrBuf[0] * 1.5;`,
        `double srSupport = 0;`,
        `double srResistance = 999999;`,
        `for(int srI = 0; srI < srLevelCount; srI++) {`,
        `   int srTouches = 0;`,
        `   for(int srJ = 0; srJ < srLevelCount; srJ++) if(MathAbs(srLevels[srI] - srLevels[srJ]) < srTol) srTouches++;`,
        `   if(srTouches < 3) continue;`,
        `   if(srLevels[srI] < bidPrice && srLevels[srI] > srSupport) srSupport = srLevels[srI];`,
        `   if(srLevels[srI] > bidPrice && srLevels[srI] < srResistance) srResistance = srLevels[srI];`,
        `}`,
        `double srBounceTol = srAtrBuf[0] * 0.5;`,
        `double sr_prevClose = iClose(InpSymbol, InpTimeframe, 1);`,
      ],
      triggerBuy:  `(srSupport > 0 && (bidPrice - srSupport) < srBounceTol && (bidPrice - srSupport) > 0 && bidPrice > sr_prevClose)`,
      triggerSell: `(srResistance < 999999 && (srResistance - bidPrice) < srBounceTol && (srResistance - bidPrice) > 0 && bidPrice < sr_prevClose)`,
      filterBuy:   `(srSupport > 0 && bidPrice > srSupport)`,    // por encima de soporte = lado bullish
      filterSell:  `(srResistance < 999999 && bidPrice < srResistance)`,
    }),
  },
};

function buildIndicatorBlocks(indicators: string[], strategy: string) {
  const globals: string[] = [];
  const inits: string[] = [];
  const releases: string[] = [];
  const setupLines: string[] = [];
  const triggerBuys: string[] = [];
  const triggerSells: string[] = [];
  const filterBuys: string[] = [];
  const filterSells: string[] = [];

  for (const id of indicators) {
    const def = INDICATOR_DEFS_MQL5[id];
    if (!def) continue;
    if (def.globals) globals.push(def.globals);
    if (def.init) inits.push(def.init);
    if (def.release) releases.push(def.release);
    const r = def.logic(strategy);
    setupLines.push(...r.setup);
    if (r.triggerBuy) triggerBuys.push(`(${r.triggerBuy})`);
    if (r.triggerSell) triggerSells.push(`(${r.triggerSell})`);
    if (r.filterBuy) filterBuys.push(`(${r.filterBuy})`);
    if (r.filterSell) filterSells.push(`(${r.filterSell})`);
  }

  return { globals, inits, releases, setupLines, triggerBuys, triggerSells, filterBuys, filterSells };
}

// Combina trigger (OR — al menos uno fire) y filter (AND — todos confirman).
//   1+ trigger + 0+ filter   → triggerOr && filterAnd
//   0   trigger + 1+ filter  → fallback && filterAnd  (price-action como trigger,
//                                                       filtros como confirmación)
//   0   trigger + 0   filter → fallback               (price action 10 velas)
//
// El fallback price-action es necesario cuando solo hay indicadores filtro
// (ATR, OBV) — sin él el bot no tiene una señal de entrada y dispararía
// continuamente mientras los filtros se cumplan.
function combine(triggers: string[], filters: string[], fallback: string): string {
  const triggerOr = triggers.length > 0 ? `(${triggers.join(' || ')})` : '';
  const filterAnd = filters.length > 0 ? `(${filters.join(' && ')})` : '';
  if (triggers.length > 0 && filters.length > 0) return `${triggerOr} && ${filterAnd}`;
  if (triggers.length > 0) return triggerOr;
  if (filters.length > 0) return `(${fallback}) && ${filterAnd}`;
  return fallback;
}

export function generateMQL5(bot: {
  id?: string;
  name: string;
  description?: string | null;
  strategy: string;
  parameters: BotParams;
}, lang: Lang = 'es'): string {
  const T = MQL_COPY[lang];
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

  const tfKey = (p.timeframe && TIMEFRAME_TO_MQL[p.timeframe])
    ? p.timeframe
    : (STRATEGY_DEFAULT_TIMEFRAME[strategy] || 'M15');
  const timeframeMQL = TIMEFRAME_TO_MQL[tfKey];

  const lotConf = p.lot || {};
  const lotMode = lotConf.mode === 'fixed' ? 'fixed' : 'auto';
  const fixedLotRaw = typeof lotConf.fixedLot === 'number' ? lotConf.fixedLot : 0.10;
  const fixedLot = Math.min(100, Math.max(0.01, fixedLotRaw));

  const news = p.news || {};
  const newsEnabled = news.enabled !== false;
  const newsBefore = news.beforeMin ?? 30;
  const newsAfter = news.afterMin ?? 15;
  const newsImpactMQL = news.impactMin === 'all' ? 'CALENDAR_IMPORTANCE_LOW'
                     : news.impactMin === 'medium' ? 'CALENDAR_IMPORTANCE_MODERATE'
                     : 'CALENDAR_IMPORTANCE_HIGH';
  const NEWS_EVENT_PATTERNS: Record<string, string> = {
    'nfp': 'Nonfarm Payrolls', 'fomc': 'Federal Funds Rate|FOMC',
    'cpi-us': 'Consumer Price Index|CPI', 'powell': 'Powell|FOMC Press',
    'gdp-us': 'Gross Domestic Product|GDP', 'retail-us': 'Retail Sales',
    'unemp-us': 'Unemployment Rate', 'ism-us': 'ISM',
    'ecb-rate': 'Main Refinancing|Deposit Facility|ECB Interest',
    'ecb-press': 'ECB Press|Lagarde', 'cpi-eu': 'Consumer Price Index|CPI|HICP',
    'gdp-eu': 'Gross Domestic Product|GDP', 'pmi-eu': 'PMI',
    'boe-rate': 'Bank Rate|BOE Interest', 'cpi-uk': 'Consumer Price Index|CPI',
    'gdp-uk': 'Gross Domestic Product|GDP', 'boj-rate': 'BOJ Interest|Policy Rate',
  };
  const selectedEventIds = (news.events && Array.isArray(news.events))
    ? news.events
    : Object.keys(NEWS_EVENT_PATTERNS);
  const effectiveNewsEnabled = newsEnabled && selectedEventIds.length > 0;
  const newsPatternsStr = selectedEventIds
    .map(id => NEWS_EVENT_PATTERNS[id])
    .filter(Boolean)
    .join('||')
    .replace(/"/g, '\\"');
  const newsHasEventFilter = selectedEventIds.length > 0 && selectedEventIds.length < Object.keys(NEWS_EVENT_PATTERNS).length;
  const generatedDate = new Date().toISOString().split('T')[0];

  const sanitizeName = bot.name.replace(/[^a-zA-Z0-9_]/g, '_');

  const ind = buildIndicatorBlocks(indicators, strategy);

  // Si NO hay triggers, hace falta un trigger de price-action.
  // Con filtros: actúa como entrada que los filtros confirman.
  // Sin nada: única lógica del bot (10-bar breakout puro).
  const needsPriceAction = ind.triggerBuys.length === 0;
  if (needsPriceAction) {
    ind.setupLines.push(`double recentHigh = iHigh(InpSymbol, InpTimeframe, iHighest(InpSymbol, InpTimeframe, MODE_HIGH, 10, 1));`);
    ind.setupLines.push(`double recentLow  = iLow(InpSymbol, InpTimeframe, iLowest(InpSymbol, InpTimeframe, MODE_LOW, 10, 1));`);
  }
  const fallbackBuy = needsPriceAction ? `bidPrice > recentHigh` : `false`;
  const fallbackSell = needsPriceAction ? `bidPrice < recentLow` : `false`;

  const buyExpr = combine(ind.triggerBuys, ind.filterBuys, fallbackBuy);
  const sellExpr = combine(ind.triggerSells, ind.filterSells, fallbackSell);

  return `//+------------------------------------------------------------------+
//|                                              ${sanitizeName}.mq5 |
//|                              ${T.headerGenerated} · ${generatedDate} |
//|                                          https://yudbot.com |
//+------------------------------------------------------------------+
#property copyright "YudBot"
#property link      "https://yudbot.com"
#property version   "1.00"
#property description "${escapeMQL(bot.description || bot.name)}"
#property description "${T.propStrategy}: ${strategyDesc(strategy, lang)}"
#property description "${T.propPair}: ${pair} · ${T.propLeverage}: 1:${leverage}"

#include <Trade\\Trade.mqh>
#include <Trade\\PositionInfo.mqh>
#include <Trade\\SymbolInfo.mqh>

input group    "${T.groupGeneral}"
input string         InpSymbol      = "${symbol}";
input ENUM_TIMEFRAMES InpTimeframe  = ${timeframeMQL};
input int            InpMagicNumber = ${Math.floor(Math.random() * 900000) + 100000};

input group    "${T.groupLot}"
input bool     InpUseFixedLot      = ${lotMode === 'fixed' ? 'true' : 'false'};
input double   InpFixedLot         = ${fixedLot.toFixed(2)};

input group    "${T.groupRisk}"
input double   InpStopLoss         = ${stopLoss};
input double   InpTakeProfit       = ${takeProfit};
input double   InpRiskPerTrade     = ${posSize};
input double   InpMaxDailyLoss     = ${dailyLoss};
input int      InpLeverage         = ${leverage};

input group    "${T.groupTime}"
input bool     InpUseTimeFilter    = true;
input int      InpStartHour        = 8;
input int      InpEndHour          = 22;

input group    "${T.groupNews}"
input bool     InpFilterNews       = ${effectiveNewsEnabled};
input int      InpNewsMinutesBefore = ${newsBefore};
input int      InpNewsMinutesAfter  = ${newsAfter};
input ENUM_CALENDAR_EVENT_IMPORTANCE InpNewsMinImpact = ${newsImpactMQL};
input bool     InpNewsFilterByName  = ${newsHasEventFilter};
input string   InpNewsPatterns      = "${newsPatternsStr}";

CTrade        trade;
CPositionInfo position;
CSymbolInfo   symbolInfo;

double initialBalance;
double dailyStartBalance;
datetime lastDayCheck;

${ind.globals.join('\n')}

int OnInit()
{
   Print("═══════════════════════════════════════");
   Print("  ${escapeMQL(bot.name)}");
   Print("  ${T.headerGenerated} · ${generatedDate}");
   Print("═══════════════════════════════════════");

   trade.SetExpertMagicNumber(InpMagicNumber);
   trade.SetMarginMode();
   trade.SetTypeFillingBySymbol(InpSymbol);
   trade.SetDeviationInPoints(10);

   if(!symbolInfo.Name(InpSymbol))
   {
      Print("${T.initSymbolError} ", InpSymbol);
      return(INIT_FAILED);
   }

${ind.inits.join('\n')}

   initialBalance = AccountInfoDouble(ACCOUNT_BALANCE);
   dailyStartBalance = initialBalance;
   lastDayCheck = TimeCurrent();

   Print("${T.initSuccess}");
   Print("${T.initBalance} ", initialBalance);
   Print("${T.initLeverage}", InpLeverage);

   return(INIT_SUCCEEDED);
}

void OnDeinit(const int reason)
{
${ind.releases.join('\n')}
}

bool EventMatchesPatterns(const string eventName, const string patterns)
{
   if(StringLen(patterns) == 0) return true;
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

bool IsNewsTime()
{
   if(!InpFilterNews) return false;
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
         if(InpNewsFilterByName && !EventMatchesPatterns(ev.name, InpNewsPatterns)) continue;
         long evTime = (long)values[i].time;
         long now    = (long)TimeCurrent();
         long diff   = evTime - now;
         if(diff <= InpNewsMinutesBefore * 60 && diff >= -InpNewsMinutesAfter * 60) return true;
      }
   }
   return false;
}

bool CheckDailyLoss()
{
   MqlDateTime dt;
   TimeToStruct(TimeCurrent(), dt);
   MqlDateTime lastDt;
   TimeToStruct(lastDayCheck, lastDt);
   if(dt.day != lastDt.day)
   {
      dailyStartBalance = AccountInfoDouble(ACCOUNT_BALANCE);
      lastDayCheck = TimeCurrent();
   }
   double currentBalance = AccountInfoDouble(ACCOUNT_BALANCE);
   double dailyLossPct = ((dailyStartBalance - currentBalance) / dailyStartBalance) * 100.0;
   if(dailyLossPct >= InpMaxDailyLoss)
   {
      Print("${T.dailyLossHit} (", dailyLossPct, "%) - ${T.dailyLossPaused}");
      return false;
   }
   return true;
}

bool IsTradingHours()
{
   if(!InpUseTimeFilter) return true;
   MqlDateTime dt;
   TimeToStruct(TimeCurrent(), dt);
   return (dt.hour >= InpStartHour && dt.hour < InpEndHour);
}

double ClampLotToSymbol(double lot)
{
   double minLot  = SymbolInfoDouble(InpSymbol, SYMBOL_VOLUME_MIN);
   double maxLot  = SymbolInfoDouble(InpSymbol, SYMBOL_VOLUME_MAX);
   double stepLot = SymbolInfoDouble(InpSymbol, SYMBOL_VOLUME_STEP);
   if(stepLot <= 0) stepLot = 0.01;
   lot = MathFloor(lot / stepLot) * stepLot;
   if(lot < minLot) lot = minLot;
   if(lot > maxLot) lot = maxLot;
   return NormalizeDouble(lot, 2);
}

double CalculateLotSize(double stopLossPips)
{
   double balance = AccountInfoDouble(ACCOUNT_BALANCE);
   double riskAmount = balance * (InpRiskPerTrade / 100.0);
   double tickValue = SymbolInfoDouble(InpSymbol, SYMBOL_TRADE_TICK_VALUE);
   if(tickValue <= 0 || stopLossPips <= 0) return ClampLotToSymbol(InpFixedLot);
   double lot = riskAmount / (stopLossPips * tickValue);
   return ClampLotToSymbol(lot);
}

double GetTradeLot(double stopLossPips)
{
   if(InpUseFixedLot) return ClampLotToSymbol(InpFixedLot);
   return CalculateLotSize(stopLossPips);
}

// Cuenta solo posiciones abiertas POR ESTE bot (mismo magic + símbolo). Sin
// este filtro, PositionsTotal() incluye posiciones de otros EAs o trades
// manuales y bloquearía al bot mientras existan.
bool HasOwnPosition()
{
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      if(position.SelectByIndex(i))
      {
         if(position.Magic() == InpMagicNumber && position.Symbol() == InpSymbol)
            return true;
      }
   }
   return false;
}

void OnTick()
{
   static datetime lastBarTime = 0;
   datetime currentBarTime = (datetime)SeriesInfoInteger(InpSymbol, InpTimeframe, SERIES_LASTBAR_DATE);
   if(currentBarTime == lastBarTime) return;
   lastBarTime = currentBarTime;

   // Filtros de bloqueo evaluados solo en barra nueva (más eficiente y con
   // log claro para que sepas por qué el bot no operó este ciclo).
   if(!CheckDailyLoss())  { Print("${T.skipDailyLoss}"); return; }
   if(!IsTradingHours())  { Print("${T.skipHours}", InpStartHour, "-", InpEndHour, "${T.skipBrokerTime}"); return; }
   if(IsNewsTime())       { Print("${T.skipNews}"); return; }
   if(HasOwnPosition())   { Print("${T.skipPosition}"); return; }

   //--- ${T.commentStrategy}: ${strategy} · ${T.commentIndicators}: ${indicators.join(', ') || T.commentNone}
   //--- ${T.commentLogic}
   double bidPrice = SymbolInfoDouble(InpSymbol, SYMBOL_BID);
   bool buySignal = false;
   bool sellSignal = false;

   ${ind.setupLines.join('\n   ')}

   if(${buyExpr}) buySignal = true;
   if(${sellExpr}) sellSignal = true;

   Print("[eval] bar=", TimeToString(currentBarTime, TIME_DATE|TIME_MINUTES), " buy=", buySignal, " sell=", sellSignal);

   if(buySignal)
   {
      double ask = SymbolInfoDouble(InpSymbol, SYMBOL_ASK);
      double sl = ask * (1 - InpStopLoss/100.0);
      double tp = ask * (1 + InpTakeProfit/100.0);
      double lot = GetTradeLot(MathAbs(ask - sl) / SymbolInfoDouble(InpSymbol, SYMBOL_POINT));
      if(!trade.Buy(lot, InpSymbol, ask, sl, tp, "${escapeMQL(bot.name)} BUY"))
         Print("${T.buyRejected} ", trade.ResultRetcode(), " ", trade.ResultRetcodeDescription(), " (lot=", lot, " sl=", sl, " tp=", tp, ")");
      else
         Print("${T.buySent} lot=", lot, " sl=", sl, " tp=", tp);
   }
   else if(sellSignal)
   {
      double bid = SymbolInfoDouble(InpSymbol, SYMBOL_BID);
      double sl = bid * (1 + InpStopLoss/100.0);
      double tp = bid * (1 - InpTakeProfit/100.0);
      double lot = GetTradeLot(MathAbs(sl - bid) / SymbolInfoDouble(InpSymbol, SYMBOL_POINT));
      if(!trade.Sell(lot, InpSymbol, bid, sl, tp, "${escapeMQL(bot.name)} SELL"))
         Print("${T.sellRejected} ", trade.ResultRetcode(), " ", trade.ResultRetcodeDescription(), " (lot=", lot, " sl=", sl, " tp=", tp, ")");
      else
         Print("${T.sellSent} lot=", lot, " sl=", sl, " tp=", tp);
   }
}

//+------------------------------------------------------------------+
//| ${T.headerEndOfFile}                             |
//+------------------------------------------------------------------+
`.replace(/Print\("Error creando ([A-Za-z0-9 \/%]+)"\)/g, (_m, name) => `Print("${T.indicatorErrorPrefix} ${name}")`);
}
