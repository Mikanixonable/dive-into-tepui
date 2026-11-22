import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decideUsage } from './usage-verdict.mjs';

const exhaustedClaude = {
  known: true,
  fiveHour: { usedPct: 0, resetsAt: null },
  sevenDay: { usedPct: 100, resetsAt: 200 },
};
const availableLuna = {
  known: true,
  daily: { remainingPct: 100, resetsAt: 300 },
  weekly: { remainingPct: 100, resetsAt: 400 },
};

assert.equal(
  decideUsage('claude', { claude: exhaustedClaude, devinPaidQuota: availableLuna, threshold: 95 }).verdict,
  'SLEEP',
);
assert.equal(
  decideUsage('devin-luna', { claude: exhaustedClaude, devinPaidQuota: availableLuna, threshold: 95 }).verdict,
  'CONTINUE',
);
assert.deepEqual(
  decideUsage('devin-luna', {
    claude: exhaustedClaude,
    devinPaidQuota: {
      known: true,
      daily: { remainingPct: 0, resetsAt: 200 },
      weekly: { remainingPct: 0, resetsAt: 400 },
    },
    threshold: 95,
  }),
  { verdict: 'SLEEP', wakeAt: 400 },
);
assert.equal(
  decideUsage('devin-luna', { claude: exhaustedClaude, devinPaidQuota: { known: false }, threshold: 95 }).verdict,
  'UNKNOWN',
);
assert.equal(
  decideUsage('devin-luna', { claude: exhaustedClaude, devinPaidQuota: { known: true }, threshold: 95 }).verdict,
  'UNKNOWN',
);
assert.equal(
  decideUsage('devin-luna', {
    claude: exhaustedClaude,
    devinPaidQuota: { known: true, daily: { remainingPct: Number.NaN } },
    threshold: 95,
  }).verdict,
  'UNKNOWN',
);

const usageScript = fileURLToPath(new URL('./usage-limits.mjs', import.meta.url));
const missingRuntime = spawnSync(process.execPath, [usageScript], { encoding: 'utf8' });
assert.equal(missingRuntime.status, 2);
assert.match(missingRuntime.stderr, /--runtime=claude/);
const missingBriefRuntime = spawnSync(process.execPath, [usageScript, '--brief'], { encoding: 'utf8' });
assert.equal(missingBriefRuntime.status, 2);
assert.match(missingBriefRuntime.stderr, /--runtime=devin-luna/);

console.log('usage-limits selftest: all PASS');
