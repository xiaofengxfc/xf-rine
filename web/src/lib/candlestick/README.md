# candlestick（vendor）

来源：[cm45t3r/candlestick](https://github.com/cm45t3r/candlestick) v3.0.0，MIT（见同目录 LICENSE）。

只做了两件事：

1. 把 CJS 的 `require` / `module.exports` 机械转成 ESM（这个前端只认 ESM），逻辑一行没动；
2. 补了两个 `.d.ts`（`patternChain.d.ts`、`patternMetadata.d.ts`），只声明我们用到的那几个入口。

没引 npm 依赖是因为仓库的 pnpm 虚拟存储配置和当前 node_modules 不一致，`pnpm add` 会要求重建整个 node_modules。
以后要升级，按同样的机械转换替换 `src/*.js` 即可，不要手改规则。

为什么用它：形态判定（阈值、影线比例、孕线/吞没的边界）以这个库为准，我们只在外层做三件事 ——
趋势上下文过滤、一根 K 线只留一个形态、以及分段增量扫描。见 `web/src/lib/patterns.ts`。
