import { applyPromptBaseline } from '../src/quant/routes.js';

let passes = 0;
let fails = 0;

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passes += 1;
    console.log('  ✓ ' + name);
  } else {
    fails += 1;
    console.error('  ✗ ' + name + (detail ? '：' + detail : ''));
  }
}

const cleanVerdict = { passed: true, failed: [], checks: [] };

console.log('[1] 提示词策略必须超过随机基线');
const winner = applyPromptBaseline(cleanVerdict, 4.2, 1.7);
check('超过基线时通过基线判定', winner.passed && winner.checks[0]?.pass === true);
check('显示策略收益和基线门槛', winner.checks[0]?.value === '4.20%' && winner.checks[0]?.threshold === '> 1.70%');

const tied = applyPromptBaseline(cleanVerdict, 1.7, 1.7);
check('与基线持平时判定失败', !tied.passed && tied.failed[0]?.key === 'baseline');

const underperformer = applyPromptBaseline(cleanVerdict, -0.4, 0.2);
check('低于基线时判定失败', !underperformer.passed && underperformer.failed[0]?.key === 'baseline');

const priorFailure = {
  passed: false,
  failed: [{ key: 'expectancy', label: '样本外期望', pass: false, value: '-1%', threshold: '> 0', why: '测试' }],
  checks: [{ key: 'expectancy', label: '样本外期望', pass: false, value: '-1%', threshold: '> 0', why: '测试' }],
};
const combined = applyPromptBaseline(priorFailure, 2, 1);
check('保留原有失败项并追加基线判定', !combined.passed && combined.failed.length === 1 && combined.checks.length === 2);

console.log('\n通过 ' + passes + ' 项，失败 ' + fails + ' 项');
if (fails > 0) process.exitCode = 1;
