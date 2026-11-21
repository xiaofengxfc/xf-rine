import { useCallback, useEffect, useRef, useState } from 'react';
import { jget, jsend, setNotArmedHandler } from '../lib/api.ts';
import type { Account, AppConfig, OpenOrder, Position, PriceOrder, PrivateState } from '../lib/api.ts';

type Toast = (kind: 'ok' | 'err', title: string, detail?: string) => void;

interface Options {
  config: AppConfig | null;
  onToast: Toast;
  onResyncTail: () => void | Promise<void>;
  onEnvironmentChange: () => void;
}

export function useTradingSession({ config, onToast, onResyncTail, onEnvironmentChange }: Options) {
  const [account, setAccount] = useState<Account | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [orders, setOrders] = useState<OpenOrder[]>([]);
  const [priceOrders, setPriceOrders] = useState<PriceOrder[]>([]);
  const [privateAt, setPrivateAt] = useState(0);
  const [privateErr, setPrivateErr] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [armCheck, setArmCheck] = useState<{ token: string; ok: boolean } | null>(null);

  const tokenRef = useRef<string | null>(null);
  tokenRef.current = token;
  const privateSeqRef = useRef(0);

  const loadPrivate = useCallback(async () => {
    if (!config) return;
    if (!config.keys.configured) {
      setAccount(null);
      setAccountError(`当前${config.envLabel}未配置 API Key`);
      return;
    }

    const seq = ++privateSeqRef.current;
    try {
      const currentToken = tokenRef.current;
      const state = await jget<PrivateState>('/api/private-state', {
        headers: currentToken ? { 'x-arm-token': currentToken } : undefined,
      });
      if (seq !== privateSeqRef.current) return;
      if (state.account) {
        setAccount(state.account);
        setAccountError(null);
      } else if (state.errors?.account) {
        setAccountError(state.errors.account);
      }
      if (state.positions) setPositions(state.positions.filter((position) => Math.abs(position.size) > 0));
      if (state.orders) setOrders(state.orders);
      if (state.priceOrders) setPriceOrders(state.priceOrders);
      if (currentToken) setArmCheck({ token: currentToken, ok: state.armed === true });

      const labels = { account: '账户', positions: '持仓', orders: '委托', priceOrders: '保护单' };
      const errors = Object.entries(state.errors ?? {}).map(([key, detail]) =>
        `${labels[key as keyof typeof labels] ?? key}：${detail}`,
      );
      if (errors.length) setPrivateErr(errors.join(' · '));
      else {
        setPrivateAt(Date.now());
        setPrivateErr(null);
      }
    } catch (error) {
      if (seq !== privateSeqRef.current) return;
      const message = (error as Error).message || '刷新失败';
      setPrivateErr(message);
      try {
        const nextAccount = await jget<Account>('/api/account');
        if (seq !== privateSeqRef.current) return;
        setAccount(nextAccount);
        setAccountError(null);
      } catch (accountFailure) {
        if (seq !== privateSeqRef.current) return;
        setAccountError((accountFailure as Error).message || message);
      }
    }
  }, [config?.envLabel, config?.keys.configured]);

  useEffect(() => {
    void loadPrivate();
    const timer = window.setInterval(() => void loadPrivate(), 3_000);
    return () => window.clearInterval(timer);
  }, [loadPrivate]);

  useEffect(() => {
    if (!privateErr) return;
    const timer = window.setTimeout(() => void loadPrivate(), 1_200);
    return () => window.clearTimeout(timer);
  }, [privateErr, privateAt, loadPrivate]);

  useEffect(() => {
    const wake = () => {
      if (document.visibilityState !== 'visible') return;
      void loadPrivate();
      void onResyncTail();
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('focus', wake);
    return () => {
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('focus', wake);
    };
  }, [loadPrivate, onResyncTail]);

  const lockTrading = useCallback((title?: string, detail?: string) => {
    setArmed(false);
    setToken(null);
    if (title) onToast('ok', title, detail);
  }, [onToast]);

  const toggleArm = useCallback(async () => {
    if (armed) {
      try {
        await jsend('POST', '/api/trade/arm', { on: false });
      } catch {
        // The local lock remains effective when the server is unavailable.
      }
      lockTrading('交易已锁定');
      return;
    }

    try {
      const result = await jsend<{ armed: boolean; token?: string }>('POST', '/api/trade/arm', { on: true });
      if (!result.armed || !result.token) return;
      setArmed(true);
      setToken(result.token);
      onToast('ok', '交易已解锁', '一直有效，随时可锁定');
    } catch (error) {
      onToast('err', '无法解锁交易', (error as Error).message);
    }
  }, [armed, lockTrading, onToast]);

  const envSeenRef = useRef<string | null>(null);
  useEffect(() => {
    const env = config?.env;
    if (!env) return;
    if (envSeenRef.current && envSeenRef.current !== env) {
      lockTrading(
        '环境已切换，交易已锁定',
        (env === 'live' ? '现在打的是实盘，花真钱。' : '现在打的是模拟盘。') + '要交易请重新解锁',
      );
      onEnvironmentChange();
    }
    envSeenRef.current = env;
  }, [config?.env, lockTrading, onEnvironmentChange]);

  useEffect(() => {
    if (config && !config.liveTrading) lockTrading();
  }, [config, lockTrading]);

  useEffect(() => {
    if (!armed || !token || !armCheck || armCheck.token !== token || armCheck.ok) return;
    lockTrading('交易已锁定', '服务端已经不认这次解锁了（服务重启过，或者被锁定过）。要交易请再点一次「解锁交易」');
  }, [armed, token, armCheck, lockTrading]);

  useEffect(() => {
    setNotArmedHandler(() => {
      if (!tokenRef.current) return;
      lockTrading('交易已锁定', '服务端已经不认这次解锁了。要交易请再点一次「解锁交易」');
    });
    return () => setNotArmedHandler(null);
  }, [lockTrading]);

  return {
    account,
    accountError,
    positions,
    orders,
    priceOrders,
    privateAt,
    privateErr,
    armed,
    token,
    loadPrivate,
    toggleArm,
  };
}
