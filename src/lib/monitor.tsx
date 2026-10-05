import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api, type Overview } from './api';
import { useStore } from './store';

type MonitorValue = {
  overview: Overview | null;
  loading: boolean;
  error: string | null;
  timeframe: string;
  setTimeframe: (tf: string) => void;
  node: string;
  setNode: (node: string) => void;
  refresh: () => Promise<void>;
  toggleEco: (enabled: boolean) => Promise<void>;
  ecoBusy: boolean;
  lastUpdated: number | null;
  secondsLeft: number;
};

const MonitorContext = createContext<MonitorValue | null>(null);

export function useMonitor(): MonitorValue {
  const ctx = useContext(MonitorContext);
  if (!ctx) throw new Error('useMonitor 必须在 MonitorProvider 内使用');
  return ctx;
}

export function MonitorProvider({ children }: { children: React.ReactNode }) {
  const { settings } = useStore();
  const interval = Math.max(5, settings?.refreshSeconds ?? 60);

  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [timeframe, setTimeframe] = useState('hour');
  const [node, setNode] = useState('');
  const [ecoBusy, setEcoBusy] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(interval);
  const inFlight = useRef(false);

  const load = useCallback(
    async (tf = timeframe, nodeName = node) => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const data = await api.pve.overview({ timeframe: tf, node: nodeName || undefined });
        setOverview(data);
        setError(null);
        setLastUpdated(Date.now());
      } catch (err) {
        setError(err instanceof Error ? err.message : '监控数据获取失败');
      } finally {
        setLoading(false);
        setSecondsLeft(interval);
        inFlight.current = false;
      }
    },
    [timeframe, node, interval],
  );

  useEffect(() => {
    void load(timeframe, node);
    // timeframe / node 变化时立即重取
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeframe, node]);

  useEffect(() => {
    const tick = window.setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          void load(timeframe);
          return interval;
        }
        return s - 1;
      });
    }, 1000);
    return () => window.clearInterval(tick);
  }, [load, timeframe, interval]);

  const toggleEco = useCallback(
    async (enabled: boolean) => {
      setEcoBusy(true);
      try {
        await api.pve.setEco(enabled);
        await load(timeframe, node);
      } catch (err) {
        setError(err instanceof Error ? err.message : '节能模式切换失败');
      } finally {
        setEcoBusy(false);
      }
    },
    [load, timeframe, node],
  );

  const value: MonitorValue = {
    overview,
    loading,
    error,
    timeframe,
    setTimeframe,
    node,
    setNode,
    refresh: () => load(timeframe, node),
    toggleEco,
    ecoBusy,
    lastUpdated,
    secondsLeft,
  };

  return <MonitorContext.Provider value={value}>{children}</MonitorContext.Provider>;
}
