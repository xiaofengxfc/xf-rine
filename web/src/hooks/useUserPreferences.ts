import { useEffect, useState } from 'react';

const PREFS_KEY = 'xf-rine:prefs';
const DEFAULT_CONTRACT = 'BTC_USDT';
const INTERVALS = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];

interface Prefs {
  contract: string;
  interval: string;
  posPct: number;
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
    return {
      contract: isContractName(raw.contract) ? raw.contract : DEFAULT_PREFS.contract,
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
      localStorage.setItem(PREFS_KEY, JSON.stringify({ contract, interval, posPct }));
    } catch {
      // Preferences are optional and must not prevent the trading desk from opening.
    }
  }, [contract, interval, posPct]);

  return { contract, setContract, interval, setInterval, posPct, setPosPct };
}
