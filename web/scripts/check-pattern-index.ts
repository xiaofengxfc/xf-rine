/**
 * 点按形态箭头用的「全部命中」索引自检。
 *
 * 图上的箭头是稀疏之后的一小部分（thinHits），而手指点在箭头正上方那一根时，
 * 命中的可能是被稀疏掉的那个。所以点按走 groupHitsByIndex：同一根多个命中时，
 * 挑的还是稀疏化时那套标准（档位 → 方向增量 → 有效置信度）。
 * 这里的用例就是钉住这条规则：换掉挑法，图上点开看到的形态会悄悄变成另一个。
 *
 * 用法：pnpm check:pattern-index
 */
import { betterHit, groupHitsByIndex, type PatternHit } from '../src/lib/patterns.ts';

let failed = 0;
let total = 0;
function check(name: string, got: unknown, want: unknown): void {
  total += 1;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`
    + (ok ? '' : `\n     得到 ${JSON.stringify(got)}\n     期望 ${JSON.stringify(want)}`));
}

const hit = (index: number, id: string, tier: 0 | 1 | 2 | 3, excess: number, fit: number): PatternHit => ({
  index, time: 1_700_000_000 + index * 60, id, name: id, direction: 'bull', tier, fit,
  stat: { n: 500, win: 0.5, base: 0.49, excess, z: 1, q: 0.1, edgeAtr: 0.3 },
});

// ---- 1. 同一根两个命中：档位高的留下 ----
check('同一根：档位高的优先',
  groupHitsByIndex([hit(5, 'low', 0, 5, 0.9), hit(5, 'high', 2, -1, 0.1)]).get(5)?.id, 'high');

// ---- 2. 档位相同：方向增量大的留下 ----
check('同一根、同档位：增量大的优先',
  groupHitsByIndex([hit(6, 'small', 1, 0.4, 0.9), hit(6, 'big', 1, 1.7, 0.2)]).get(6)?.id, 'big');

// ---- 3. 档位和增量都一样：置信度高的留下（最后一档兜底，别让结果靠输入顺序） ----
check('同一根、同档位同增量：置信度高的优先',
  groupHitsByIndex([hit(7, 'weak', 1, 0.5, 0.3), hit(7, 'strong', 1, 0.5, 0.8)]).get(7)?.id, 'strong');

// ---- 4. 不同根互不影响 ----
const grouped = groupHitsByIndex([hit(1, 'a', 0, 0, 0), hit(1, 'b', 1, 0, 0), hit(2, 'c', 0, 0, 0)]);
check('不同根各留各的', [grouped.get(1)?.id, grouped.get(2)?.id], ['b', 'c']);

// ---- 5. betterHit 是严格偏序：打平时不换人（稀疏化只换「更好」的，不换「一样好」的） ----
check('完全打平的时候不换', betterHit(hit(9, 'x', 1, 0.2, 0.5), hit(9, 'y', 1, 0.2, 0.5)), false);

console.log(failed === 0
  ? `形态索引自检通过：${total} 条`
  : `形态索引自检失败：${failed}/${total}`);
if (failed > 0) process.exitCode = 1;
