// mql4Generator.ts — Genera código MQL4 (MetaTrader 4) desde la config del bot
//
// Mismo modelo trigger+filter que mqlGenerator.ts, pero MQL4 no usa handles:
// las funciones iX() devuelven el valor directamente.

import { MQL_COPY, Lang, strategyDesc } from './mqlCopy';

interface BotParams {
  market?: string;
  pair?: string;
  leverage?: number;
  indicators?: string[];
  timeframe?: 'M1' | 'M5' | 'M15' | 'M30' | 'H1' | 'H4' | 'D1';
  lot?: { mode?: 'auto' | 'fixed'; fixedLot?: number };
  risk?: { stopLoss?: number; takeProfit?: number; posSize?: number; dailyLoss?: number };
  funded?: { enabled?: boolean; firm?: string };
}

const TIMEFRAME_TO_MQL4: Record<string, string> = {
  M1: 'PERIOD_M1', M5: 'PERIOD_M5', M15: 'PERIOD_M15', M30: 'PERIOD_M30',
  H1: 'PERIOD_H1', H4: 'PERIOD_H4', D1: 'PERIOD_D1',
};
const STRATEGY_DEFAULT_TF_MQL4: Record<string, string> = {
  scalping: 'M5', momentum: 'M15', mean: 'M15', breakout: 'H1',
  swing: 'H4', trend: 'H1', reversal: 'M30', grid: 'M15',
  dca: 'H4', hedge: 'H1',
};

// Escapa una cadena para que sea segura como literal MQL4 (backslash y comillas
// dobles). Sin esto, un nombre como `Bot "Pro"` rompería la compilación.
function escapeMQL(s: string): string {
  if (!s) return '';
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

type IndDef4 = {
  logic: (strategy: string) => {
    setup: string[];
    triggerBuy?: string;
    triggerSell?: string;
    filterBuy?: string;
    filterSell?: string;
  };
};
const isReversal = (s: string) => s === 'mean' || s === 'reversal';

const INDICATOR_DEFS_MQL4: Record<string, IndDef4> = {
  // Momentum
  rsi: {
    logic: (s) => {
      const lo = isReversal(s) ? 35 : 30;
      const hi = isReversal(s) ? 65 : 70;
      return {
        setup: [
          `double rsi1 = iRSI(Symbol(), InpTimeframe, 14, PRICE_CLOSE, 1);`,
          `double rsi2 = iRSI(Symbol(), InpTimeframe, 14, PRICE_CLOSE, 2);`,
        ],
        triggerBuy:  `(rsi1 < ${lo} && rsi2 >= ${lo})`,
        triggerSell: `(rsi1 > ${hi} && rsi2 <= ${hi})`,
        filterBuy:   `rsi1 < ${lo + 10}`,
        filterSell:  `rsi1 > ${hi - 10}`,
      };
    },
  },
  stoch: {
    logic: (s) => {
      const lo = isReversal(s) ? 25 : 20;
      const hi = isReversal(s) ? 75 : 80;
      return {
        setup: [
          `double stochM1 = iStochastic(Symbol(), InpTimeframe, 5, 3, 3, MODE_SMA, 0, MODE_MAIN, 1);`,
          `double stochS1 = iStochastic(Symbol(), InpTimeframe, 5, 3, 3, MODE_SMA, 0, MODE_SIGNAL, 1);`,
          `double stochM2 = iStochastic(Symbol(), InpTimeframe, 5, 3, 3, MODE_SMA, 0, MODE_MAIN, 2);`,
          `double stochS2 = iStochastic(Symbol(), InpTimeframe, 5, 3, 3, MODE_SMA, 0, MODE_SIGNAL, 2);`,
        ],
        triggerBuy:  `(stochM1 > stochS1 && stochM2 <= stochS2 && stochM1 < ${lo + 30})`,
        triggerSell: `(stochM1 < stochS1 && stochM2 >= stochS2 && stochM1 > ${hi - 30})`,
        filterBuy:   `stochM1 < ${lo + 20}`,
        filterSell:  `stochM1 > ${hi - 20}`,
      };
    },
  },
  stochrsi: {
    logic: (s) => {
      const lo = isReversal(s) ? 25 : 20;
      const hi = isReversal(s) ? 75 : 80;
      return {
        setup: [
          // 17 RSI (bars 0-16) para Stoch RSI sobre bars cerradas 1, 2, 3
          `double srsi_rsi[17]; for(int sri = 0; sri < 17; sri++) srsi_rsi[sri] = iRSI(Symbol(), InpTimeframe, 14, PRICE_CLOSE, sri);`,
          `double srsi_K_raw[3];`,
          `for(int sriI = 1; sriI <= 3; sriI++) {`,
          `   double sri_lo = srsi_rsi[sriI], sri_hi = srsi_rsi[sriI];`,
          `   for(int sriJ = sriI; sriJ < sriI + 14; sriJ++) { if(srsi_rsi[sriJ] < sri_lo) sri_lo = srsi_rsi[sriJ]; if(srsi_rsi[sriJ] > sri_hi) sri_hi = srsi_rsi[sriJ]; }`,
          `   srsi_K_raw[sriI - 1] = (sri_hi > sri_lo) ? (srsi_rsi[sriI] - sri_lo) / (sri_hi - sri_lo) * 100.0 : 50.0;`,
          `}`,
          `double srsi_K = (srsi_K_raw[0] + srsi_K_raw[1] + srsi_K_raw[2]) / 3.0;`,
          // Sembrar estado con valores reales en la primera evaluación, no con
          // 50 hardcoded — si el K real está lejos de 50 al cargar el bot
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
    logic: () => ({
      setup: [
        `double cci1 = iCCI(Symbol(), InpTimeframe, 14, PRICE_TYPICAL, 1);`,
        `double cci2 = iCCI(Symbol(), InpTimeframe, 14, PRICE_TYPICAL, 2);`,
      ],
      triggerBuy:  `(cci1 < -100 && cci2 >= -100)`,
      triggerSell: `(cci1 > 100 && cci2 <= 100)`,
      filterBuy:   `cci1 < 0`,
      filterSell:  `cci1 > 0`,
    }),
  },
  williams: {
    logic: () => ({
      setup: [
        `double wpr1 = iWPR(Symbol(), InpTimeframe, 14, 1);`,
        `double wpr2 = iWPR(Symbol(), InpTimeframe, 14, 2);`,
      ],
      triggerBuy:  `(wpr1 < -80 && wpr2 >= -80)`,
      triggerSell: `(wpr1 > -20 && wpr2 <= -20)`,
      filterBuy:   `wpr1 < -50`,
      filterSell:  `wpr1 > -50`,
    }),
  },
  roc: {
    logic: () => ({
      setup: [
        `double mom1 = iMomentum(Symbol(), InpTimeframe, 14, PRICE_CLOSE, 1);`,
        `double mom2 = iMomentum(Symbol(), InpTimeframe, 14, PRICE_CLOSE, 2);`,
        `double roc = mom1 - 100.0;`,
        `double rocPrev = mom2 - 100.0;`,
      ],
      triggerBuy:  `(roc > 0 && rocPrev <= 0)`,
      triggerSell: `(roc < 0 && rocPrev >= 0)`,
      filterBuy:   `roc > 0`,
      filterSell:  `roc < 0`,
    }),
  },

  // Tendencia
  ema: {
    logic: () => ({
      setup: [
        `double emaFast1 = iMA(Symbol(), InpTimeframe, 9, 0, MODE_EMA, PRICE_CLOSE, 1);`,
        `double emaSlow1 = iMA(Symbol(), InpTimeframe, 21, 0, MODE_EMA, PRICE_CLOSE, 1);`,
        `double emaFast2 = iMA(Symbol(), InpTimeframe, 9, 0, MODE_EMA, PRICE_CLOSE, 2);`,
        `double emaSlow2 = iMA(Symbol(), InpTimeframe, 21, 0, MODE_EMA, PRICE_CLOSE, 2);`,
      ],
      triggerBuy:  `(emaFast1 > emaSlow1 && emaFast2 <= emaSlow2)`,
      triggerSell: `(emaFast1 < emaSlow1 && emaFast2 >= emaSlow2)`,
      filterBuy:   `emaFast1 > emaSlow1`,
      filterSell:  `emaFast1 < emaSlow1`,
    }),
  },
  sma: {
    logic: () => ({
      setup: [
        `double smaFast1 = iMA(Symbol(), InpTimeframe, 9, 0, MODE_SMA, PRICE_CLOSE, 1);`,
        `double smaSlow1 = iMA(Symbol(), InpTimeframe, 21, 0, MODE_SMA, PRICE_CLOSE, 1);`,
        `double smaFast2 = iMA(Symbol(), InpTimeframe, 9, 0, MODE_SMA, PRICE_CLOSE, 2);`,
        `double smaSlow2 = iMA(Symbol(), InpTimeframe, 21, 0, MODE_SMA, PRICE_CLOSE, 2);`,
      ],
      triggerBuy:  `(smaFast1 > smaSlow1 && smaFast2 <= smaSlow2)`,
      triggerSell: `(smaFast1 < smaSlow1 && smaFast2 >= smaSlow2)`,
      filterBuy:   `smaFast1 > smaSlow1`,
      filterSell:  `smaFast1 < smaSlow1`,
    }),
  },
  macd: {
    logic: () => ({
      setup: [
        `double macdM1 = iMACD(Symbol(), InpTimeframe, 12, 26, 9, PRICE_CLOSE, MODE_MAIN, 1);`,
        `double macdS1 = iMACD(Symbol(), InpTimeframe, 12, 26, 9, PRICE_CLOSE, MODE_SIGNAL, 1);`,
        `double macdM2 = iMACD(Symbol(), InpTimeframe, 12, 26, 9, PRICE_CLOSE, MODE_MAIN, 2);`,
        `double macdS2 = iMACD(Symbol(), InpTimeframe, 12, 26, 9, PRICE_CLOSE, MODE_SIGNAL, 2);`,
      ],
      triggerBuy:  `(macdM1 > macdS1 && macdM2 <= macdS2)`,
      triggerSell: `(macdM1 < macdS1 && macdM2 >= macdS2)`,
      filterBuy:   `macdM1 > macdS1`,
      filterSell:  `macdM1 < macdS1`,
    }),
  },
  adx: {
    logic: () => ({
      setup: [
        `double adxM1     = iADX(Symbol(), InpTimeframe, 14, PRICE_CLOSE, MODE_MAIN, 1);`,
        `double adxPlus1  = iADX(Symbol(), InpTimeframe, 14, PRICE_CLOSE, MODE_PLUSDI, 1);`,
        `double adxMinus1 = iADX(Symbol(), InpTimeframe, 14, PRICE_CLOSE, MODE_MINUSDI, 1);`,
        `double adxPlus2  = iADX(Symbol(), InpTimeframe, 14, PRICE_CLOSE, MODE_PLUSDI, 2);`,
        `double adxMinus2 = iADX(Symbol(), InpTimeframe, 14, PRICE_CLOSE, MODE_MINUSDI, 2);`,
      ],
      triggerBuy:  `(adxPlus1 > adxMinus1 && adxPlus2 <= adxMinus2 && adxM1 > 20)`,
      triggerSell: `(adxPlus1 < adxMinus1 && adxPlus2 >= adxMinus2 && adxM1 > 20)`,
      filterBuy:   `(adxM1 > 20 && adxPlus1 > adxMinus1)`,
      filterSell:  `(adxM1 > 20 && adxPlus1 < adxMinus1)`,
    }),
  },
  ichi: {
    logic: () => ({
      setup: [
        `double ichiTen1 = iIchimoku(Symbol(), InpTimeframe, 9, 26, 52, MODE_TENKANSEN, 1);`,
        `double ichiKij1 = iIchimoku(Symbol(), InpTimeframe, 9, 26, 52, MODE_KIJUNSEN, 1);`,
        `double ichiTen2 = iIchimoku(Symbol(), InpTimeframe, 9, 26, 52, MODE_TENKANSEN, 2);`,
        `double ichiKij2 = iIchimoku(Symbol(), InpTimeframe, 9, 26, 52, MODE_KIJUNSEN, 2);`,
        // Senkou A/B en MQL4 con shift=0 da el cloud proyectado +26 al futuro;
        // para comparar el precio actual contra el cloud actual se lee con
        // shift = Kijun period (26).
        `double ichiSpA  = iIchimoku(Symbol(), InpTimeframe, 9, 26, 52, MODE_SENKOUSPANA, 26);`,
        `double ichiSpB  = iIchimoku(Symbol(), InpTimeframe, 9, 26, 52, MODE_SENKOUSPANB, 26);`,
      ],
      triggerBuy:  `(ichiTen1 > ichiKij1 && ichiTen2 <= ichiKij2 && Bid > ichiSpA && Bid > ichiSpB)`,
      triggerSell: `(ichiTen1 < ichiKij1 && ichiTen2 >= ichiKij2 && Bid < ichiSpA && Bid < ichiSpB)`,
      filterBuy:   `(ichiTen1 > ichiKij1 && Bid > ichiSpA && Bid > ichiSpB)`,
      filterSell:  `(ichiTen1 < ichiKij1 && Bid < ichiSpA && Bid < ichiSpB)`,
    }),
  },
  psar: {
    logic: () => ({
      setup: [
        `double sar1 = iSAR(Symbol(), InpTimeframe, 0.02, 0.2, 1);`,
        `double sar2 = iSAR(Symbol(), InpTimeframe, 0.02, 0.2, 2);`,
        `double psarPrevClose = iClose(Symbol(), InpTimeframe, 1);`,
        `double psarPrevPrevClose = iClose(Symbol(), InpTimeframe, 2);`,
      ],
      // Comparamos close[1] vs sar[1] y close[2] vs sar[2] (alineados en tiempo)
      triggerBuy:  `(psarPrevClose > sar1 && psarPrevPrevClose <= sar2)`,
      triggerSell: `(psarPrevClose < sar1 && psarPrevPrevClose >= sar2)`,
      filterBuy:   `psarPrevClose > sar1`,
      filterSell:  `psarPrevClose < sar1`,
    }),
  },
  supertrend: {
    logic: () => ({
      setup: [
        // ATR de la barra cerrada (shift=1). Si lo leyéramos en shift 0, el
        // valor cambia con cada tick y st_line/st_dir repintarían dentro de
        // la misma barra dando flips fantasma.
        `double stAtr1 = iATR(Symbol(), InpTimeframe, 10, 1);`,
        `double stMid = (iHigh(Symbol(), InpTimeframe, 1) + iLow(Symbol(), InpTimeframe, 1)) / 2.0;`,
        `double stClosePrev = iClose(Symbol(), InpTimeframe, 1);`,
        `double stBasicUp = stMid + 3.0 * stAtr1;`,
        `double stBasicDn = stMid - 3.0 * stAtr1;`,
        `static double st_line = 0;`,
        `static int st_dir = 0;`,
        `static bool st_init = false;`,
        `int st_prevDir = st_dir;`,
        `if(!st_init) {`,
        `   st_dir = (stClosePrev > stMid) ? 1 : -1;`,
        `   st_line = (st_dir == 1) ? stBasicDn : stBasicUp;`,
        `   st_prevDir = st_dir;`,
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

  // Volatilidad
  bb: {
    logic: (s) => {
      // Bandas leídas en barras CERRADAS (shift 1 y 2): el breakout no
      // repinta dentro de la barra que se está formando.
      const setup = [
        `double bbU1 = iBands(Symbol(), InpTimeframe, 20, 2, 0, PRICE_CLOSE, MODE_UPPER, 1);`,
        `double bbL1 = iBands(Symbol(), InpTimeframe, 20, 2, 0, PRICE_CLOSE, MODE_LOWER, 1);`,
        `double bbM1 = iBands(Symbol(), InpTimeframe, 20, 2, 0, PRICE_CLOSE, MODE_MAIN, 1);`,
        `double bbU2 = iBands(Symbol(), InpTimeframe, 20, 2, 0, PRICE_CLOSE, MODE_UPPER, 2);`,
        `double bbL2 = iBands(Symbol(), InpTimeframe, 20, 2, 0, PRICE_CLOSE, MODE_LOWER, 2);`,
        `double bbPrevClose     = iClose(Symbol(), InpTimeframe, 1);`,
        `double bbPrevPrevClose = iClose(Symbol(), InpTimeframe, 2);`,
      ];
      if (isReversal(s)) {
        return {
          setup,
          triggerBuy:  `(bbPrevClose <= bbL1 && bbPrevPrevClose > bbL2)`,
          triggerSell: `(bbPrevClose >= bbU1 && bbPrevPrevClose < bbU2)`,
          filterBuy:   `bbPrevClose <= bbM1`,
          filterSell:  `bbPrevClose >= bbM1`,
        };
      }
      return {
        setup,
        triggerBuy:  `(bbPrevClose >= bbU1 && bbPrevPrevClose < bbU2)`,
        triggerSell: `(bbPrevClose <= bbL1 && bbPrevPrevClose > bbL2)`,
        filterBuy:   `bbPrevClose >= bbM1`,
        filterSell:  `bbPrevClose <= bbM1`,
      };
    },
  },
  atr: {
    logic: () => ({
      setup: [
        `double atr0 = iATR(Symbol(), InpTimeframe, 14, 0);`,
        `double atrAvg = 0; for(int aiI = 0; aiI < 50; aiI++) atrAvg += iATR(Symbol(), InpTimeframe, 14, aiI); atrAvg /= 50.0;`,
        `bool atrActive = (atr0 >= atrAvg * 0.5);`,
      ],
      filterBuy:  `atrActive`,
      filterSell: `atrActive`,
    }),
  },
  donchian: {
    logic: (s) => {
      const setup = [
        `double donHigh = iHigh(Symbol(), InpTimeframe, iHighest(Symbol(), InpTimeframe, MODE_HIGH, 20, 1));`,
        `double donLow  = iLow(Symbol(), InpTimeframe, iLowest(Symbol(), InpTimeframe, MODE_LOW, 20, 1));`,
      ];
      if (isReversal(s)) {
        return { setup, triggerBuy: `Bid <= donLow`, triggerSell: `Bid >= donHigh` };
      }
      return { setup, triggerBuy: `Bid >= donHigh`, triggerSell: `Bid <= donLow` };
    },
  },
  kc: {
    logic: (s) => {
      // EMA y ATR de barras CERRADAS (shift 1 y 2). Breakout sobre cierres,
      // sin repaint dentro de la barra que se está formando.
      const setup = [
        `double kcEma1 = iMA(Symbol(), InpTimeframe, 20, 0, MODE_EMA, PRICE_CLOSE, 1);`,
        `double kcAtr1 = iATR(Symbol(), InpTimeframe, 10, 1);`,
        `double kcEma2 = iMA(Symbol(), InpTimeframe, 20, 0, MODE_EMA, PRICE_CLOSE, 2);`,
        `double kcAtr2 = iATR(Symbol(), InpTimeframe, 10, 2);`,
        `double kcUpper     = kcEma1 + 2.0 * kcAtr1;`,
        `double kcLower     = kcEma1 - 2.0 * kcAtr1;`,
        `double kcUpperPrev = kcEma2 + 2.0 * kcAtr2;`,
        `double kcLowerPrev = kcEma2 - 2.0 * kcAtr2;`,
        `double kcPrevClose     = iClose(Symbol(), InpTimeframe, 1);`,
        `double kcPrevPrevClose = iClose(Symbol(), InpTimeframe, 2);`,
      ];
      if (isReversal(s)) {
        return {
          setup,
          triggerBuy:  `(kcPrevClose <= kcLower && kcPrevPrevClose > kcLowerPrev)`,
          triggerSell: `(kcPrevClose >= kcUpper && kcPrevPrevClose < kcUpperPrev)`,
          filterBuy:   `kcPrevClose <= kcEma1`,
          filterSell:  `kcPrevClose >= kcEma1`,
        };
      }
      return {
        setup,
        triggerBuy:  `(kcPrevClose >= kcUpper && kcPrevPrevClose < kcUpperPrev)`,
        triggerSell: `(kcPrevClose <= kcLower && kcPrevPrevClose > kcLowerPrev)`,
        filterBuy:   `kcPrevClose >= kcEma1`,
        filterSell:  `kcPrevClose <= kcEma1`,
      };
    },
  },

  // Volumen
  vol: {
    logic: () => ({
      setup: [
        // iVolume(0) en MQL4 es la barra recién abierta (~0 ticks). Usamos
        // bar 1 como volumen de referencia y promedio sobre bars 2-21.
        `long volNow = iVolume(Symbol(), InpTimeframe, 1);`,
        `long volAvg = 0; for(int viI = 2; viI <= 21; viI++) volAvg += iVolume(Symbol(), InpTimeframe, viI); volAvg /= 20;`,
        `bool volSpike = (volNow > volAvg * 1.5);`,
        `double volHi5 = iHigh(Symbol(), InpTimeframe, iHighest(Symbol(), InpTimeframe, MODE_HIGH, 5, 1));`,
        `double volLo5 = iLow(Symbol(), InpTimeframe, iLowest(Symbol(), InpTimeframe, MODE_LOW, 5, 1));`,
      ],
      triggerBuy:  `(volSpike && Bid > volHi5)`,
      triggerSell: `(volSpike && Bid < volLo5)`,
      filterBuy:   `volSpike`,
      filterSell:  `volSpike`,
    }),
  },
  obv: {
    logic: () => ({
      setup: [
        // Comenzamos desde oiI=1 para evitar incluir la barra recién abierta
        // (su precio aún no se ha movido significativamente).
        `double obvSum = 0; for(int oiI = 1; oiI <= 20; oiI++) { double prev = iClose(Symbol(), InpTimeframe, oiI + 1); double curr = iClose(Symbol(), InpTimeframe, oiI); long v = iVolume(Symbol(), InpTimeframe, oiI); if(curr > prev) obvSum += v; else if(curr < prev) obvSum -= v; }`,
      ],
      filterBuy:  `obvSum > 0`,
      filterSell: `obvSum < 0`,
    }),
  },
  vwap: {
    logic: () => ({
      // VWAP intra-día con WARM-UP: si el bot se carga a media sesión, sin
      // back-fill el acumulado arrancaría en 0 y el VWAP sería inútil hasta
      // acumular suficiente. Al cambiar de día (o en la primera ejecución)
      // reconstruimos cumPV/cumV recorriendo todas las barras cerradas del
      // día desde 00:00. La clave del día usa year+month+day para no
      // confundir días separados un mes exacto.
      setup: [
        `datetime vwap_now = TimeCurrent();`,
        `int vwap_today = TimeYear(vwap_now)*10000 + TimeMonth(vwap_now)*100 + TimeDay(vwap_now);`,
        `static int vwap_day = 0;`,
        `static double vwap_cumPV = 0;`,
        `static double vwap_cumV = 0;`,
        `static double vwap_prev = 0;`,
        `static double vwap_prevPrice = 0;`,
        `if(vwap_today != vwap_day) {`,
        `   vwap_cumPV = 0; vwap_cumV = 0; vwap_day = vwap_today;`,
        `   datetime vwap_dayStart = vwap_now - TimeHour(vwap_now)*3600 - TimeMinute(vwap_now)*60 - TimeSeconds(vwap_now);`,
        `   for(int vbi = 1; vbi < 10000; vbi++) {`,
        `      datetime vbT = iTime(Symbol(), InpTimeframe, vbi);`,
        `      if(vbT == 0 || vbT < vwap_dayStart) break;`,
        `      double vbTp = (iHigh(Symbol(), InpTimeframe, vbi) + iLow(Symbol(), InpTimeframe, vbi) + iClose(Symbol(), InpTimeframe, vbi)) / 3.0;`,
        `      long vbV = iVolume(Symbol(), InpTimeframe, vbi);`,
        `      vwap_cumPV += vbTp * vbV;`,
        `      vwap_cumV  += vbV;`,
        `   }`,
        `} else {`,
        `   double vwap_tp = (iHigh(Symbol(), InpTimeframe, 1) + iLow(Symbol(), InpTimeframe, 1) + iClose(Symbol(), InpTimeframe, 1)) / 3.0;`,
        `   long vwap_v = iVolume(Symbol(), InpTimeframe, 1);`,
        `   vwap_cumPV += vwap_tp * vwap_v;`,
        `   vwap_cumV  += vwap_v;`,
        `}`,
        `double vwap = (vwap_cumV > 0) ? vwap_cumPV / vwap_cumV : Bid;`,
        `bool vwap_crossUp   = (vwap_prev > 0 && vwap_prevPrice <= vwap_prev && Bid > vwap);`,
        `bool vwap_crossDown = (vwap_prev > 0 && vwap_prevPrice >= vwap_prev && Bid < vwap);`,
        `vwap_prev = vwap; vwap_prevPrice = Bid;`,
      ],
      triggerBuy:  `vwap_crossUp`,
      triggerSell: `vwap_crossDown`,
      filterBuy:   `Bid > vwap`,
      filterSell:  `Bid < vwap`,
    }),
  },
  mfi: {
    logic: (s) => {
      const lo = isReversal(s) ? 25 : 20;
      const hi = isReversal(s) ? 75 : 80;
      return {
        setup: [
          `double mfi1 = iMFI(Symbol(), InpTimeframe, 14, 1);`,
          `double mfi2 = iMFI(Symbol(), InpTimeframe, 14, 2);`,
        ],
        triggerBuy:  `(mfi1 < ${lo} && mfi2 >= ${lo})`,
        triggerSell: `(mfi1 > ${hi} && mfi2 <= ${hi})`,
        filterBuy:   `mfi1 < 50`,
        filterSell:  `mfi1 > 50`,
      };
    },
  },

  // S/R
  fib: {
    logic: () => ({
      setup: [
        `double fib_swingHigh = 0; int fib_swingHighBar = -1;`,
        `for(int fi = 2; fi < 100 && fib_swingHighBar == -1; fi++) {`,
        `   double fr = iFractals(Symbol(), InpTimeframe, MODE_UPPER, fi);`,
        `   if(fr != 0 && fr != EMPTY_VALUE) { fib_swingHigh = fr; fib_swingHighBar = fi; }`,
        `}`,
        `double fib_swingLow = 0; int fib_swingLowBar = -1;`,
        `for(int fj = 2; fj < 100 && fib_swingLowBar == -1; fj++) {`,
        `   double frL = iFractals(Symbol(), InpTimeframe, MODE_LOWER, fj);`,
        `   if(frL != 0 && frL != EMPTY_VALUE) { fib_swingLow = frL; fib_swingLowBar = fj; }`,
        `}`,
        `bool fib_uptrend = (fib_swingLowBar > fib_swingHighBar);`,
        `double fib_range = fib_swingHigh - fib_swingLow;`,
        `double fib_382 = fib_uptrend ? fib_swingHigh - fib_range * 0.382 : fib_swingLow + fib_range * 0.382;`,
        `double fib_50  = (fib_swingHigh + fib_swingLow) / 2.0;`,
        `double fib_618 = fib_uptrend ? fib_swingHigh - fib_range * 0.618 : fib_swingLow + fib_range * 0.618;`,
        `double fib_tol = fib_range * 0.04;`,
        `bool fib_atKeyLevel = (MathAbs(Bid - fib_382) < fib_tol || MathAbs(Bid - fib_50) < fib_tol || MathAbs(Bid - fib_618) < fib_tol);`,
      ],
      triggerBuy:  `(fib_range > 0 && fib_uptrend && fib_atKeyLevel)`,
      triggerSell: `(fib_range > 0 && !fib_uptrend && fib_atKeyLevel)`,
      filterBuy:   `(fib_range > 0 && fib_uptrend)`,
      filterSell:  `(fib_range > 0 && !fib_uptrend)`,
    }),
  },
  pivots: {
    logic: () => ({
      setup: [
        `double piv_yH = iHigh(Symbol(), PERIOD_D1, 1);`,
        `double piv_yL = iLow(Symbol(), PERIOD_D1, 1);`,
        `double piv_yC = iClose(Symbol(), PERIOD_D1, 1);`,
        `double piv_yRange = piv_yH - piv_yL;`,
        `double piv_P  = (piv_yH + piv_yL + piv_yC) / 3.0;`,
        `double piv_R1 = 2.0 * piv_P - piv_yL;`,
        `double piv_S1 = 2.0 * piv_P - piv_yH;`,
        `double piv_R2 = piv_P + piv_yRange;`,
        `double piv_S2 = piv_P - piv_yRange;`,
        `double piv_R3 = piv_yH + 2.0 * (piv_P - piv_yL);`,
        `double piv_S3 = piv_yL - 2.0 * (piv_yH - piv_P);`,
        `double piv_tol = piv_yRange * 0.08;`,
        `bool piv_nearS = (MathAbs(Bid - piv_S1) < piv_tol || MathAbs(Bid - piv_S2) < piv_tol || MathAbs(Bid - piv_S3) < piv_tol);`,
        `bool piv_nearR = (MathAbs(Bid - piv_R1) < piv_tol || MathAbs(Bid - piv_R2) < piv_tol || MathAbs(Bid - piv_R3) < piv_tol);`,
        `double piv_prevClose = iClose(Symbol(), InpTimeframe, 1);`,
        `bool piv_bounceUp = (Bid > piv_prevClose);`,
        `bool piv_bounceDown = (Bid < piv_prevClose);`,
      ],
      triggerBuy:  `(piv_yRange > 0 && piv_nearS && piv_bounceUp)`,
      triggerSell: `(piv_yRange > 0 && piv_nearR && piv_bounceDown)`,
      filterBuy:  `(piv_yRange > 0 && Bid < piv_P)`,
      filterSell: `(piv_yRange > 0 && Bid > piv_P)`,
    }),
  },
  sr: {
    logic: () => ({
      setup: [
        `double srLevels[400]; int srLevelCount = 0;`,
        `for(int sri = 2; sri < 200 && srLevelCount < 400; sri++) {`,
        `   double srU = iFractals(Symbol(), InpTimeframe, MODE_UPPER, sri);`,
        `   if(srU != 0 && srU != EMPTY_VALUE) srLevels[srLevelCount++] = srU;`,
        `   double srD = iFractals(Symbol(), InpTimeframe, MODE_LOWER, sri);`,
        `   if(srD != 0 && srD != EMPTY_VALUE) srLevels[srLevelCount++] = srD;`,
        `}`,
        `double srAtr0 = iATR(Symbol(), InpTimeframe, 14, 0);`,
        `double srTol = srAtr0 * 1.5;`,
        `double srSupport = 0;`,
        `double srResistance = 999999;`,
        `for(int srI = 0; srI < srLevelCount; srI++) {`,
        `   int srTouches = 0;`,
        `   for(int srJ = 0; srJ < srLevelCount; srJ++) if(MathAbs(srLevels[srI] - srLevels[srJ]) < srTol) srTouches++;`,
        `   if(srTouches < 3) continue;`,
        `   if(srLevels[srI] < Bid && srLevels[srI] > srSupport) srSupport = srLevels[srI];`,
        `   if(srLevels[srI] > Bid && srLevels[srI] < srResistance) srResistance = srLevels[srI];`,
        `}`,
        `double srBounceTol = srAtr0 * 0.5;`,
        `double sr_prevClose = iClose(Symbol(), InpTimeframe, 1);`,
      ],
      triggerBuy:  `(srSupport > 0 && (Bid - srSupport) < srBounceTol && (Bid - srSupport) > 0 && Bid > sr_prevClose)`,
      triggerSell: `(srResistance < 999999 && (srResistance - Bid) < srBounceTol && (srResistance - Bid) > 0 && Bid < sr_prevClose)`,
      filterBuy:  `(srSupport > 0 && Bid > srSupport)`,
      filterSell: `(srResistance < 999999 && Bid < srResistance)`,
    }),
  },
};

function buildIndicatorBlocksMQL4(indicators: string[], strategy: string) {
  const setupLines: string[] = [];
  const triggerBuys: string[] = [];
  const triggerSells: string[] = [];
  const filterBuys: string[] = [];
  const filterSells: string[] = [];
  for (const id of indicators) {
    const def = INDICATOR_DEFS_MQL4[id];
    if (!def) continue;
    const r = def.logic(strategy);
    setupLines.push(...r.setup);
    if (r.triggerBuy) triggerBuys.push(`(${r.triggerBuy})`);
    if (r.triggerSell) triggerSells.push(`(${r.triggerSell})`);
    if (r.filterBuy) filterBuys.push(`(${r.filterBuy})`);
    if (r.filterSell) filterSells.push(`(${r.filterSell})`);
  }
  return { setupLines, triggerBuys, triggerSells, filterBuys, filterSells };
}

// Cuando solo hay filtros (sin triggers), el fallback price-action sirve
// como evento de entrada y los filtros confirman. Sin esto, los indicadores
// "filter-only" (ATR, OBV) harían que el bot disparara continuamente.
function combine(triggers: string[], filters: string[], fallback: string): string {
  const triggerOr = triggers.length > 0 ? `(${triggers.join(' || ')})` : '';
  const filterAnd = filters.length > 0 ? `(${filters.join(' && ')})` : '';
  if (triggers.length > 0 && filters.length > 0) return `${triggerOr} && ${filterAnd}`;
  if (triggers.length > 0) return triggerOr;
  if (filters.length > 0) return `(${fallback}) && ${filterAnd}`;
  return fallback;
}

export function generateMQL4(bot: {
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
  const generatedDate = new Date().toISOString().split('T')[0];
  const magicNumber = Math.floor(Math.random() * 900000) + 100000;

  const tfKey = (p.timeframe && TIMEFRAME_TO_MQL4[p.timeframe])
    ? p.timeframe
    : (STRATEGY_DEFAULT_TF_MQL4[strategy] || 'M15');
  const timeframeMQL = TIMEFRAME_TO_MQL4[tfKey];

  const lotConf = p.lot || {};
  const lotMode = lotConf.mode === 'fixed' ? 'fixed' : 'auto';
  const fixedLotRaw = typeof lotConf.fixedLot === 'number' ? lotConf.fixedLot : 0.10;
  const fixedLot = Math.min(100, Math.max(0.01, fixedLotRaw));


  const sanitizeName = bot.name.replace(/[^a-zA-Z0-9_]/g, '_');

  const ind = buildIndicatorBlocksMQL4(indicators, strategy);

  const needsPriceAction = ind.triggerBuys.length === 0;
  if (needsPriceAction) {
    ind.setupLines.push(`double recentHigh = iHigh(Symbol(), InpTimeframe, iHighest(Symbol(), InpTimeframe, MODE_HIGH, 10, 1));`);
    ind.setupLines.push(`double recentLow  = iLow(Symbol(), InpTimeframe, iLowest(Symbol(), InpTimeframe, MODE_LOW, 10, 1));`);
  }
  const fallbackBuy = needsPriceAction ? `Bid > recentHigh` : `false`;
  const fallbackSell = needsPriceAction ? `Bid < recentLow` : `false`;

  const buyExpr = combine(ind.triggerBuys, ind.filterBuys, fallbackBuy);
  const sellExpr = combine(ind.triggerSells, ind.filterSells, fallbackSell);

  return `//+------------------------------------------------------------------+
//|                                              ${sanitizeName}.mq4 |
//|                              ${T.headerGenerated} · ${generatedDate} |
//|                                          https://yudbot.com |
//+------------------------------------------------------------------+
#property copyright "YudBot"
#property link      "https://yudbot.com"
#property version   "1.00"
#property strict
#property description "${escapeMQL(bot.description || bot.name)}"
#property description "${T.propStrategy}: ${strategyDesc(strategy, lang)}"
#property description "${T.propPair}: ${pair} · ${T.propLeverage}: 1:${leverage}"

extern string  _GENERAL              = "${T.groupGeneral}";
extern string  InpSymbol             = "${symbol}";
extern int     InpTimeframe          = ${timeframeMQL};
extern int     InpMagicNumber        = ${magicNumber};
extern int     InpSlippage           = 10;

extern string  _LOT                  = "${T.groupLot}";
extern bool    InpUseFixedLot        = ${lotMode === 'fixed' ? 'true' : 'false'};
extern double  InpFixedLot           = ${fixedLot.toFixed(2)};

extern string  _RISK                 = "${T.groupRisk}";
extern double  InpStopLoss           = ${stopLoss};
extern double  InpTakeProfit         = ${takeProfit};
extern double  InpRiskPerTrade       = ${posSize};
extern double  InpMaxDailyLoss       = ${dailyLoss};
extern int     InpLeverage           = ${leverage};

extern string  _TIME                 = "${T.groupTime}";
extern bool    InpUseTimeFilter      = true;
extern int     InpStartHour          = 8;
extern int     InpEndHour            = 22;

double initialBalance;
double dailyStartBalance;
datetime lastDayCheck;
int lastBarTime = 0;

int OnInit()
{
   Print("═══════════════════════════════════════");
   Print("  ${escapeMQL(bot.name)}");
   Print("  ${T.headerGenerated} · ${generatedDate}");
   Print("═══════════════════════════════════════");

   // Refuso operar sobre un chart de símbolo distinto al configurado: si
   // generaste el bot para EURUSD y lo arrastras a un chart de GBPUSD, el
   // EA debe abortar en lugar de operar silenciosamente en el par
   // equivocado.
   if(StringCompare(Symbol(), InpSymbol, false) != 0)
   {
      Print("${T.chartMismatchPre} ", InpSymbol, " ${T.chartMismatchMid} ", Symbol(), ". ${T.chartMismatchTail} ", InpSymbol, ".");
      return INIT_FAILED;
   }

   initialBalance = AccountBalance();
   dailyStartBalance = initialBalance;
   lastDayCheck = TimeCurrent();
   Print("${T.initSuccess}");
   Print("${T.initBalance} ", initialBalance);
   Print("${T.initLeverage}", InpLeverage);
   return(INIT_SUCCEEDED);
}

void OnDeinit(const int reason) { Print("${T.deinitStopped} ", reason); }

bool CheckDailyLoss()
{
   datetime now = TimeCurrent();
   // TimeDay solo devuelve día del mes (1-31). Comparar TimeDay(now) vs
   // TimeDay(lastDayCheck) falla si entre ambos pasó exactamente un mes
   // (mismo día numérico distinto mes). Comparamos year+month+day.
   int nowKey  = TimeYear(now)*10000 + TimeMonth(now)*100 + TimeDay(now);
   int lastKey = TimeYear(lastDayCheck)*10000 + TimeMonth(lastDayCheck)*100 + TimeDay(lastDayCheck);
   if(nowKey != lastKey)
   {
      dailyStartBalance = AccountBalance();
      lastDayCheck = now;
   }
   double dailyLossPct = ((dailyStartBalance - AccountBalance()) / dailyStartBalance) * 100.0;
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
   int hour = TimeHour(TimeCurrent());
   return (hour >= InpStartHour && hour < InpEndHour);
}

double ClampLotToSymbol(double lot)
{
   double minLot  = MarketInfo(Symbol(), MODE_MINLOT);
   double maxLot  = MarketInfo(Symbol(), MODE_MAXLOT);
   double stepLot = MarketInfo(Symbol(), MODE_LOTSTEP);
   if(stepLot <= 0) stepLot = 0.01;
   lot = MathFloor(lot / stepLot) * stepLot;
   if(lot < minLot) lot = minLot;
   if(lot > maxLot) lot = maxLot;
   return NormalizeDouble(lot, 2);
}

double CalculateLotSize(double stopLossPips)
{
   double balance = AccountBalance();
   double riskAmount = balance * (InpRiskPerTrade / 100.0);
   double tickValue = MarketInfo(Symbol(), MODE_TICKVALUE);
   if(tickValue <= 0 || stopLossPips <= 0) return ClampLotToSymbol(InpFixedLot);
   double lot = riskAmount / (stopLossPips * tickValue);
   return ClampLotToSymbol(lot);
}

double GetTradeLot(double stopLossPips)
{
   if(InpUseFixedLot) return ClampLotToSymbol(InpFixedLot);
   return CalculateLotSize(stopLossPips);
}

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

void OnTick()
{
   if(Time[0] == lastBarTime) return;
   lastBarTime = Time[0];

   if(!CheckDailyLoss()) { Print("${T.skipDailyLoss}"); return; }
   if(!IsTradingHours()) { Print("${T.skipHours}", InpStartHour, "-", InpEndHour, "${T.skipBrokerTime}"); return; }
   if(HasOpenPosition()) { Print("${T.skipPosition}"); return; }

   //--- ${T.commentStrategy}: ${strategy} · ${T.commentIndicators}: ${indicators.join(', ') || T.commentNone}
   //--- ${T.commentLogic}
   bool buySignal = false;
   bool sellSignal = false;

   ${ind.setupLines.join('\n   ')}

   if(${buyExpr}) buySignal = true;
   if(${sellExpr}) sellSignal = true;

   Print("[eval] bar=", TimeToString(Time[0], TIME_DATE|TIME_MINUTES), " buy=", buySignal, " sell=", sellSignal);

   if(buySignal)
   {
      double sl = Ask * (1 - InpStopLoss/100.0);
      double tp = Ask * (1 + InpTakeProfit/100.0);
      double lot = GetTradeLot(MathAbs(Ask - sl) / Point);
      int ticket = OrderSend(Symbol(), OP_BUY, lot, Ask, InpSlippage, sl, tp, "${escapeMQL(bot.name)} BUY", InpMagicNumber, 0, clrGreen);
      if(ticket < 0) Print("${T.buyOpenError} ", GetLastError());
      else Print("${T.buyOpened} ", ticket, " · ${T.lot} ", lot);
   }
   else if(sellSignal)
   {
      double sl = Bid * (1 + InpStopLoss/100.0);
      double tp = Bid * (1 - InpTakeProfit/100.0);
      double lot = GetTradeLot(MathAbs(sl - Bid) / Point);
      int ticket = OrderSend(Symbol(), OP_SELL, lot, Bid, InpSlippage, sl, tp, "${escapeMQL(bot.name)} SELL", InpMagicNumber, 0, clrRed);
      if(ticket < 0) Print("${T.sellOpenError} ", GetLastError());
      else Print("${T.sellOpened} ", ticket, " · ${T.lot} ", lot);
   }
}

//+------------------------------------------------------------------+
//| ${T.headerEndOfFile}                             |
//+------------------------------------------------------------------+
`;
}
