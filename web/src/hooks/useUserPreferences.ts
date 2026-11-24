import { useEffect, useState } from 'react';
import { storedSymbol } from '../lib/instrument.ts';

const PREFS_KEY = 'xf-rine:prefs';
const DEFAULT_CONTRACT = 'BTC_USDT';
const INTERVALS = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];

interface Prefs {
  contract: string;
  interval: string;
  posPct: number;
  /**
   * 完整身份（`gate:perp:BTC_USDT`）。
   *
   * 这一版只**读**不写：还不知道当前是哪家交易所，写进去就会写错。
   * 但读到的一定要原样留住 —— 存一次就把它抹掉的话，旧数据升级一次就没了。
   */
  instrument?: string;
}

const DEFAULT_PREFS: Prefs = { contract: DEFAULT_CONTRACT, interval: '15m', posPct: 25 };

function isContractName(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const name = value.trim();
  return name.length >= 2 && name.length <= 40 && !/[\s/\\?#%]/.test(name);
}

function readPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Record<string, unknown>;
    // 有完整身份就以它为准，裸符号只是老存档的退路
    const fromInstrument = storedSymbol(raw.instrument);
    return {
      contract: fromInstrument ?? (isContractName(raw.contract) ? raw.contract : DEFAULT_PREFS.contract),
      ...(typeof raw.instrument === 'string' && fromInstrument ? { instrument: raw.instrument } : {}),
      interval: typeof raw.interval === 'string' && INTERVALS.includes(raw.interval)
        ? raw.interval
        : DEFAULT_PREFS.interval,
      posPct: typeof raw.posPct === 'number' && raw.posPct > 0 && raw.posPct <= 100
        ? raw.posPct
        : DEFAULT_PREFS.posPct,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function useUserPreferences() {
  const [initial] = useState(readPrefs);
  const [contract, setContract] = useState(initial.contract);
  const [interval, setInterval] = useState(initial.interval);
  const [posPct, setPosPct] = useState(initial.posPct);

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({
        contract,
        interval,
        posPct,
        ...(initial.instrument ? { instrument: initial.instrument } : {}),
      }));
    } catch {
      // Preferences are optional and must not prevent the trading desk from opening.
    }
  }, [contract, interval, posPct, initial.instrument]);

  return { contract, setContract, interval, setInterval, posPct, setPosPct };
}
