// 近傍拡散補正の走査の解像度(1/8・1/4・1/2・1)ごとの GPU の費用。手順 9。
//
//   node tools/render-lab-screen-space-scan-scale-load.mjs session <N>   ページを開いて 1 セッションを測り load/session-<N>.json へ
//   node tools/render-lab-screen-space-scan-scale-load.mjs report        残したセッションから load/report.md と report.json を書く
//
// 1 セッション = ページを開き直した 1 回。撮影 bay と cornell-box ごとに、4 つの段を同じページで 3 巡(巡ごとに順を逆に)
// 交互に測り、GPU の行ごとの p50 を残す。ms を比べてよいのは同じセッションの中だけ。
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tierOf } from './screen-space-chain-setup.mjs';
import { fixed, headHash, selectedEntries, shotsDir, table, withLab } from './screen-space-lab.mjs';

const dir = path.join(shotsDir, 'ssd-9', 'load');
const ROUNDS = 3;
const SCALES = [{ label: '1/8', scale: 0.125 }, { label: '1/4', scale: 0.25 }, { label: '1/2', scale: 0.5 }, { label: '1', scale: 1 }];
const BASE = 1;
const SHOTS = ['bay', 'cornell-box'];
// GPU_PASS(src/render/gpu-timings.ts)の値の並びで GPU の行の名前を引く。近傍拡散の行は 7〜14(拡大は 13)、マテリアルは 18。
const MATERIAL_INDEX = 18;
const ROWS = [
  { name: '写しと源', index: 7 }, { name: '代表縮小', index: 9 }, { name: '走査', index: 8 }, { name: '帯縮小', index: 10 },
  { name: '合流', index: 11 }, { name: '最後の拡大', index: 13 },
];
const NEARBY_INDICES = [7, 8, 9, 10, 11, 12, 13, 14];

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

async function session(number) {
  mkdirSync(dir, { recursive: true });
  const record = await withLab(async (lab) => {
    const out = {};
    for (const shot of SHOTS) {
      const entry = selectedEntries({ entries: shot })[0];
      await lab.show(entry);
      // 測る前に全部の形を描いて、シェーダを組み終える。
      for (const { scale } of SCALES) {
        await lab.setTier({ ...tierOf(0.38), scale });
        await lab.readSettled(['correction']);
      }
      const rounds = await lab.measureTierRounds(SCALES.map(({ scale }) => ({ ...tierOf(0.38), scale })), ROUNDS);
      if (rounds === null) throw new Error('GPU timing is not supported in this session');
      out[shot] = rounds;
    }
    return out;
  });
  writeFileSync(path.join(dir, `session-${number}.json`), JSON.stringify({ head: headHash(), rounds: ROUNDS, shots: record }));
  console.log(`session ${number} done`);
}

// 1 セッション・1 撮影の、解像度ごとの行の ms(巡の中央値)。{ rows: [{ name, ms: [解像度ごと] }], sum, material }。
function rowsOf(rounds) {
  const labels = Object.keys(rounds[0][0]);
  const cell = (tier, label) => median(rounds[tier].map((round) => round[label]));
  const perScale = (label) => SCALES.map((_, tier) => cell(tier, label));
  const sums = SCALES.map((_, tier) => NEARBY_INDICES.reduce((total, index) => total + cell(tier, labels[index]), 0));
  return {
    rows: ROWS.map(({ name, index }) => ({ name, label: labels[index], ms: perScale(labels[index]) })),
    sum: sums, material: perScale(labels[MATERIAL_INDEX]), materialLabel: labels[MATERIAL_INDEX],
  };
}

function report() {
  const files = readdirSync(dir).filter((f) => /^session-\d+\.json$/.test(f)).sort();
  const sessions = files.map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf8')));
  const lines = [`# 走査の解像度の GPU 費用(commit ${sessions[0].head}、${sessions.length} セッション × ${ROUNDS} 巡の中央値)`, '',
    'ms を比べてよいのは同じセッションの中だけ。行の名前: ' + ROWS.map((r) => `${r.name} = 「${rowsOf(sessions[0].shots.bay).rows.find((x) => x.name === r.name).label}」`).join('、')
    + `、和 = 近傍拡散の全行(写しと源・走査・代表縮小・帯縮小・合流・均し・拡大・パス平均)、マテリアル = 「${rowsOf(sessions[0].shots.bay).materialLabel}」。`, ''];
  const json = {};
  for (const shot of SHOTS) {
    lines.push(`## ${shot}`, '');
    const perSession = sessions.map((s) => rowsOf(s.shots[shot]));
    json[shot] = perSession;
    for (const [i, s] of perSession.entries()) {
      const items = [...s.rows.map((r) => [r.name, r.ms]), ['和', s.sum], ['マテリアル', s.material]];
      lines.push(`### セッション ${i + 1}(ms、1/4 に対する倍率)`, '',
        ...table(['行', ...SCALES.map((x) => x.label), ...SCALES.map((x) => `${x.label} / 1/4`)],
          items.map(([name, ms]) => [name, ...ms.map((v) => fixed(v, 3)), ...ms.map((v) => (ms[BASE] > 0 ? fixed(v / ms[BASE], 2) : '—'))])),
        '', `和 / マテリアル: ${s.sum.map((v, k) => fixed(v / s.material[k], 2)).join(' / ')}`, '');
    }
    const items = [...perSession[0].rows.map((r, k) => [r.name, perSession.map((s) => s.rows[k].ms)]),
      ['和', perSession.map((s) => s.sum)]];
    lines.push('### 1/4 に対する倍率の 3 セッションの min〜max', '',
      ...table(['行', ...SCALES.map((x) => x.label)], items.map(([name, all]) => [name, ...SCALES.map((_, k) => {
        const ratios = all.map((ms) => ms[k] / ms[BASE]);
        return `${fixed(Math.min(...ratios), 2)}〜${fixed(Math.max(...ratios), 2)}`;
      })])), '');
    const sumsAt = perSession.map((s) => s.sum[BASE]);
    const materialsAt = perSession.map((s) => s.material[BASE]);
    lines.push(`1/4 の和 [ms] (セッションごと): ${sumsAt.map((v) => fixed(v, 3)).join(' / ')}、マテリアル: ${materialsAt.map((v) => fixed(v, 3)).join(' / ')}`);
    const slow = sumsAt.map((v, i) => (v > 1.1 * Math.min(...sumsAt) ? i + 1 : null)).filter((v) => v !== null);
    lines.push(slow.length > 0 ? `和が最速のセッションの 1.1 倍を超えて遅いセッション: ${slow.join(', ')}` : '和が最速のセッションの 1.1 倍を超えて遅いセッションは無い。', '');
  }
  writeFileSync(path.join(dir, 'report.md'), lines.join('\n'));
  writeFileSync(path.join(dir, 'report.json'), JSON.stringify(json, null, 1));
  console.log(lines.join('\n'));
}

const [command, argument] = process.argv.slice(2);
if (command === 'session') await session(Number(argument));
else if (command === 'report') report();
else throw new Error('usage: session <N> | report');
