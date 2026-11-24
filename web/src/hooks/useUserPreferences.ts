import { useEffect, useState } from 'react';
import { instrumentKey, storedSymbol, type VenueId } from '../lib/instrument.ts';

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

/**
 * @param venue 当前连的交易所；配置还没拿到时传 null。
 *   身份串里带交易所，不知道是哪一家就不能写 —— 写进去就是错的，而且要等到下次才发现。
 */
export function useUserPreferences(venue: VenueId | null) {
  const [initial] = useState(readPrefs);
  const [contract, setContract] = useState(initial.contract);
  const [interval, setInterval] = useState(initial.interval);
  const [posPct, setPosPct] = useState(initial.posPct);
  const [instrument, setInstrument] = useState(initial.instrument);

  /**
   * 交易所确定之后（或者换了品种）才把身份写实。
   *
   * 换交易所时这里会跟着改写成新那一家 —— 身份里的 venue 以当前配置为准，
   * 存档里留着旧家的身份，下次启动就会拿它去查另一家的数据。
   */
  useEffect(() => {
    if (!venue) return;
    const next = instrumentKey({ venue, market: 'perp', symbol: contract });
    setInstrument((cur) => (cur === next ? cur : next));
  }, [venue, contract]);

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({
        contract,
        interval,
        posPct,
        ...(instrument ? { instrument } : {}),
      }));
    } catch {
      // Preferences are optional and must not prevent the trading desk from opening.
    }
  }, [contract, interval, posPct, instrument]);

  return { contract, setContract, interval, setInterval, posPct, setPosPct };
}
