# 巡风 · Cloudflare Worker

手机直连交易所的那一套后端。手机 App 里把「服务器地址」填成这个 Worker 的地址、
「口令」填成 `REMOTE_TOKEN`，就不用开着电脑了。

## 这套连接有什么、没有什么

| 有 | 没有 |
|---|---|
| 合约表、行情、K 线 | 支撑阻力（关键位引擎是 Python，Worker 里跑不了） |
| 账户、持仓、挂单、止损止盈 | AI 分析、AI 交易 |
| 下单、撤单、改单、平仓、反手、加仓 | 量化研究台、回测 |
| 改杠杆、保证金模式 | 本地 Parquet 数据目录、备份与恢复 |

没有的那些，页面会显示「这套连接下没有」，不会假装成功。

## 部署

```bash
cd worker
pnpm install
pnpm exec wrangler login                     # 第一次要登录一次

# 选一家交易所，把密钥设进去（不要写进 wrangler.toml）
pnpm exec wrangler secret put REMOTE_TOKEN   # 手机连 Worker 的口令，随便一串 20 位以上
pnpm exec wrangler secret put GATE_KEY
pnpm exec wrangler secret put GATE_SECRET
# 或者 Bitget：
# pnpm exec wrangler secret put BITGET_KEY
# pnpm exec wrangler secret put BITGET_SECRET
# pnpm exec wrangler secret put BITGET_PASSPHRASE

pnpm exec wrangler deploy
```

部署完会给你一个 `https://xf-rine.<你的子域>.workers.dev`。

## 国内访问

`*.workers.dev` 在国内经常连不上。到 Cloudflare 后台给这个 Worker 加一个自己的域名
（Workers → 你的 Worker → Settings → Domains & Routes → Add custom domain），
然后用那个域名填进手机。

## 先跑本地

```bash
cd worker
pnpm exec wrangler dev
```

本地模式用的是真 workerd，会真的打到交易所，所以照样要设 secret：

```bash
pnpm exec wrangler secret put REMOTE_TOKEN --local
```

## 安全

- 所有请求都要带 `x-remote-token`，没设这个 secret 的 Worker 直接拒绝服务。
- 下单、撤单、平仓、改杠杆还要额外的解锁令牌（`POST /api/trade/arm`），
  令牌存在 Durable Object 里，换设备或重新部署就失效。
- `LIVE_TRADING` 不是 `true` 时，解锁直接回 403 —— 先看清楚再打开。
- 单笔名义价值超过 `MAX_NOTIONAL` 会被拒。手机上看不到风控面板，这道闸是最后一道。
- 密钥只在 Worker 的 secret 里，页面和手机都拿不到。
