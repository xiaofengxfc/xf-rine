/**
 * 研究台接口（/api/research/*）。
 *
 * 这一组接口对应上游 Flask 应用的全部对外能力：
 *   health      引擎自检（概率模型 / 校准表装没装）
 *   dir         数据目录（读 / 写）
 *   analyze     单品种深度分析
 *   scan        全市场扫描（按有效概率排序）
 *
 * 和交易台接口的分工：这里只读本地 parquet / csv，不碰交易所、不碰钱，
 * 所以路径校验（必须落在允许的根目录里）由调用方传进来的 deps 负责，
 * 这里只负责「把请求翻成 sidecar 调用、把错误翻成人话」。
 */

import { Router, type Request, type Response } from 'express';
import { SidecarError } from './client.js';
import * as sr from './client.js';
import type { Direction } from './types.js';

export interface ResearchDeps {
  /** 只允许本机访问（选目录等于让程序读硬盘） */
  requireLocal(req: Request, what: string): void;
  /** 当前记住的数据目录，没有就是空串 */
  getDataDir(): string;
  /** 记住数据目录：校验通过后落盘，返回绝对路径 */
  setDataDir(raw: string): string;
  /** 把异常翻成统一的错误响应 */
  fail(res: Response, err: unknown): void;
  /** 包一层 catch，保持和别的接口一致 */
  wrap(fn: (req: Request, res: Response) => Promise<void>): (req: Request, res: Response) => void;
}

function num(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Number(raw ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function direction(raw: unknown): Direction {
  const d = String(raw ?? 'long').trim().toLowerCase();
  return d === 'short' || d === 'both' ? d : 'long';
}

export function mountResearch(router: Router, deps: ResearchDeps): void {
  /**
   * 引擎自检。
   *
   * 这个接口本身不该抛错：引擎没起来时界面要能显示「为什么没起来」，
   * 而不是拿到一个 500 之后再猜。所以失败也返回 200，用 ok=false + detail 说明。
   */
  router.get('/research/health', deps.wrap(async (_req, res) => {
    const h = await sr.health();
    if (!h.ok) {
      res.json({ ok: false, detail: h.detail ?? '关键位引擎没有启动' });
      return;
    }
    const data = h.data as { engine?: string; python?: string; numpy?: string; prob_ready?: boolean; calibrated?: boolean; prob_meta?: unknown; calib_meta?: unknown };
    res.json({
      ok: true,
      engine: data.engine ?? 'v3fusion',
      python: data.python ?? '',
      numpy: data.numpy ?? '',
      probReady: data.prob_ready === true,
      calibrated: data.calibrated === true,
      probMeta: data.prob_meta ?? {},
      calibMeta: data.calib_meta ?? {},
    });
  }));

  /** 当前数据目录 + 品种列表 */
  router.get('/research/dir', deps.wrap(async (_req, res) => {
    const dir = deps.getDataDir();
    if (!dir) {
      res.json({ dir: '', exists: false, count: 0, instruments: [], files: 0 });
      return;
    }
    try {
      const out = await sr.instruments(dir);
      res.json({
        dir: out.data_dir,
        exists: true,
        count: out.count,
        instruments: out.instruments,
        files: (out as { files?: number }).files ?? 0,
        tfLabels: out.tf_labels,
      });
    } catch (e) {
      // 目录在，但引擎没起来 / 目录里有坏文件：如实说，不要把整个页面弄崩
      const detail = (e as Error).message;
      res.json({ dir, exists: true, count: 0, instruments: [], files: 0, warning: detail });
    }
  }));

  /** 换数据目录：只认本机，且必须是一个真能读出品种的目录 */
  router.post('/research/dir', deps.wrap(async (req, res) => {
    deps.requireLocal(req, '选择数据目录');
    const raw = String((req.body as { dir?: string })?.dir ?? '').trim();
    const dir = deps.setDataDir(raw);
    try {
      const out = await sr.instruments(dir);
      res.json({
        ok: true,
        dir: out.data_dir,
        count: out.count,
        instruments: out.instruments,
        files: (out as { files?: number }).files ?? 0,
        tfLabels: out.tf_labels,
      });
    } catch (e) {
      // 目录已经记住了，但引擎读不出来：照实说，别让用户以为选错了地方
      res.json({ ok: true, dir, count: 0, instruments: [], files: 0, warning: (e as Error).message });
    }
  }));

  /** 单品种深度分析 */
  router.get('/research/analyze', deps.wrap(async (req, res) => {
    const dir = deps.getDataDir();
    const symbol = String(req.query.symbol ?? '').trim();
    const tf = String(req.query.tf ?? 'D1').trim().toUpperCase();
    const out = await sr.analyzeLocal({
      dir,
      symbol,
      tf,
      window: num(req.query.window, 40, 10, 500),
      n_zones: num(req.query.n_zones, 3, 1, 8),
      direction: direction(req.query.direction),
      mtf: String(req.query.mtf ?? 'true').toLowerCase() !== 'false',
      n_bars: num(req.query.n_bars, 300, 60, 2000),
    });
    res.json(out);
  }));

  /** 全市场扫描 */
  router.get('/research/scan', deps.wrap(async (req, res) => {
    const dir = deps.getDataDir();
    const out = await sr.scan(dir, {
      tf: String(req.query.tf ?? 'D1').trim().toUpperCase(),
      window: num(req.query.window, 40, 10, 500),
      n_zones: num(req.query.n_zones, 3, 1, 8),
      direction: direction(req.query.direction),
    });
    res.json(out);
  }));
}

export { SidecarError };
