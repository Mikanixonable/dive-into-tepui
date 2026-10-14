// 近傍拡散補正の、走査の解像度と帯の数ごとの GPU の費用。手順 9・10。
//
//   node tools/render-lab-screen-space-scan-scale-load.mjs session <N> [オプション]   ページを開いて 1 セッションを測り <out>/session-<N>.json へ
//   node tools/render-lab-screen-space-scan-scale-load.mjs report [オプション]        残したセッションから <out>/report.md と report.json を書く
//
//   --scales 0.125,0.25,0.5,1   走査の解像度
//   --band-counts 4             帯の数 L
//   --range all                 描く段の範囲(all,chain をコンマで並べてよい。chain は走査の描画先に残った帯から鎖だけを描く)
//   --shots bay,cornell-box     撮影
//   --out ssd-9/load            置き場(.render-lab-shots 以下)
//   --warmup-rounds 0           測る前に捨てる巡の数(範囲ごと)
//   --rounds 3                  測る巡の数
//   --rotate-order              シェーダを組む順(測る前に全部の形を描く順)をセッション番号で回す。セッション s は段の並びを s - 1 だけ回して組む。測る巡の順は変えない
//   --base-scale 0.25 --base-count 4                                  倍率の分母。帯の数を 2 つ以上並べたときは、同じ解像度の base-count が分母になる
//
// 1 セッション = ページを開き直した 1 回。撮影と範囲ごとに、解像度 × 帯の数の全部の段を同じページで --rounds 巡(巡ごとに順を逆に)
// 交互に測り、GPU の行ごとの p50 を残す。ms を比べてよいのは同じセッションの中だけ。
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tierOf } from './screen-space-chain-setup.mjs';
import { fixed, headHash, selectedEntries, shotsDir, table, withLab } from './screen-space-lab.mjs';

const SCALE_LABELS = { 0.125: '1/8', 0.25: '1/4', 0.5: '1/2', 1: '1' };
// GPU_PASS(src/render/gpu-timings.ts)の値の並びで GPU の行の名前を引く。近傍拡散の行は 7〜14(拡大は 13)、マテリアルは 18。
const MATERIAL_INDEX = 18;
const ROWS = [
  { name: '写しと源', index: 7 }, { name: '走査', index: 8 }, { name: '代表縮小', index: 9 }, { name: '帯縮小', index: 10 },
  { name: '合流', index: 11 }, { name: '最後の拡大', index: 13 },
];
const CHAIN_NAMES = ['代表縮小', '帯縮小', '合流', '最後の拡大'];
const NEARBY_INDICES = [7, 8, 9, 10, 11, 12, 13, 14];

const options = (() => {
  const [, , command, ...rest] = process.argv;
  const flags = {};
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--rotate-order') flags['rotate-order'] = true;
    else if (rest[i].startsWith('--')) flags[rest[i].slice(2)] = rest[++i];
    else positional.push(rest[i]);
  }
  const list = (key, fallback) => (flags[key] ?? fallback).split(',');
  return {
    command, argument: positional[0],
    scales: list('scales', '0.125,0.25,0.5,1').map(Number), bandCounts: list('band-counts', '4').map(Number),
    ranges: list('range', 'all'), shots: list('shots', 'bay,cornell-box'), out: flags.out ?? 'ssd-9/load',
    baseScale: Number(flags['base-scale'] ?? 0.25), baseCount: Number(flags['base-count'] ?? 4), warmupRounds: Number(flags['warmup-rounds'] ?? 0),
    rotateOrder: 'rotate-order' in flags, rounds: Number(flags.rounds ?? 3),
  };
})();
const dir = path.join(shotsDir, ...options.out.split('/'));

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const scaleLabel = (scale) => SCALE_LABELS[scale] ?? String(scale);
// 段は解像度ごとに帯の数を並べる。
const TIERS = options.scales.flatMap((scale) => options.bandCounts.map((bandCount) => ({ scale, bandCount })));
const tierLabel = ({ scale, bandCount }) => [options.scales.length > 1 || options.bandCounts.length === 1 ? scaleLabel(scale) : null,
  options.bandCounts.length > 1 ? `L${bandCount}` : null].filter((v) => v !== null).join(' ');
// 倍率の分母は、帯の数を振るなら同じ解像度の base-count、解像度を振るなら base-scale。
const baseIndexOf = ({ scale, bandCount }) => TIERS.findIndex((t) => t.bandCount === (options.bandCounts.length > 1 ? options.baseCount : bandCount)
  && t.scale === (options.bandCounts.length > 1 ? scale : options.baseScale));

async function session(number) {
  mkdirSync(dir, { recursive: true });
  const tiers = TIERS.map(({ scale, bandCount }) => ({ ...tierOf(0.38), scale, bandCount }));
  // シェーダを組む順: 段の添字を (number - 1) だけ回した並び。
  const shift = options.rotateOrder ? (number - 1) % tiers.length : 0;
  const assemblyOrder = tiers.map((_, k) => (k + shift) % tiers.length);
  const record = await withLab(async (lab) => {
    const out = {};
    const assemblyMs = {};
    for (const shot of options.shots) {
      await lab.show(selectedEntries({ entries: shot })[0]);
      // 測る前に全部の形を全段で描いて、シェーダを組み終え、走査の描画先を埋める。
      await lab.setStageRange('all');
      for (const k of assemblyOrder) {
        const started = Date.now();
        await lab.setTier(tiers[k]);
        await lab.readSettled(['correction']);
        assemblyMs[shot] ??= [];
        assemblyMs[shot][k] = Date.now() - started;
      }
      out[shot] = {};
      for (const range of options.ranges) {
        await lab.setStageRange(range);
        for (let w = 0; w < options.warmupRounds; w++) await lab.measureTierRounds(tiers, 1);
        const rounds = await lab.measureTierRounds(tiers, options.rounds);
        if (rounds === null) throw new Error('GPU timing is not supported in this session');
        out[shot][range] = rounds;
      }
      await lab.setStageRange('all');
    }
    out.assemblyMs = assemblyMs;
    return out;
  });
  writeFileSync(path.join(dir, `session-${number}.json`), JSON.stringify({ head: headHash(), rounds: options.rounds, tiers: TIERS, warmupRounds: options.warmupRounds, assemblyOrder, shots: record }));
  console.log(`session ${number} done`);
}

// 1 セッション・1 撮影・1 範囲の、段ごとの行の ms(巡の中央値)。{ rows: [{ name, ms: [段ごと] }], label 付き }。
function rowsOf(rounds) {
  const labels = Object.keys(rounds[0][0]);
  const cell = (tier, label) => median(rounds[tier].map((round) => round[label]));
  const perTier = (label) => TIERS.map((_, tier) => cell(tier, label));
  const rows = ROWS.map(({ name, index }) => ({ name, label: labels[index], ms: perTier(labels[index]) }));
  const sumOf = (parts) => TIERS.map((_, tier) => parts.reduce((total, ms) => total + ms[tier], 0));
  return [
    ...rows,
    { name: '鎖の和', ms: sumOf(rows.filter((r) => CHAIN_NAMES.includes(r.name)).map((r) => r.ms)) },
    { name: '近傍拡散の和', ms: sumOf(NEARBY_INDICES.map((index) => perTier(labels[index]))) },
    { name: 'マテリアル', ms: perTier(labels[MATERIAL_INDEX]) },
  ];
}

const ratioRange = (all, k) => {
  const ratios = all.map((ms) => ms[k] / ms[baseIndexOf(TIERS[k])]);
  return `${fixed(Math.min(...ratios), 2)}〜${fixed(Math.max(...ratios), 2)}`;
};

// 同じ解像度の隣り合う帯の数のあいだの、行ごとの増分 [ms] の表(L が 1 増えるごとの差)。
function incrementTable(rows) {
  const pairs = TIERS.map((t, k) => [k - 1, k]).filter(([a, k]) => a >= 0 && TIERS[a].scale === TIERS[k].scale);
  if (pairs.length === 0) return [];
  return ['', '増分 [ms](L → L + 1)', '', ...table(['行', ...pairs.map(([a, k]) => `${tierLabel(TIERS[a])} → L${TIERS[k].bandCount}`)],
    rows.map((r) => [r.name, ...pairs.map(([a, k]) => fixed(r.ms[k] - r.ms[a], 3))])), ''];
}

function report() {
  const files = readdirSync(dir).filter((f) => /^session-\d+\.json$/.test(f)).sort();
  const sessions = files.map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf8')));
  const header = sessions[0].tiers.map((t) => tierLabel(t));
  const ranges = Object.keys(sessions[0].shots[options.shots[0]]);
  const lines = [`# 走査の GPU 費用(commit ${sessions[0].head}、${sessions.length} セッション × ${sessions[0].rounds} 巡の中央値)`, '',
    'ms を比べてよいのは同じセッションの中だけ。行の名前: '
    + ROWS.map((r) => `${r.name} = 「${Object.keys(sessions[0].shots[options.shots[0]][ranges[0]][0][0])[r.index]}」`).join('、')
    + '、鎖の和 = 代表縮小 + 帯縮小 + 合流 + 最後の拡大、近傍拡散の和 = 近傍拡散の全行(写しと源・走査・代表縮小・帯縮小・合流・均し・拡大・パス平均)、マテリアル = 「マテリアル」。', ''];
  const json = {};
  for (const shot of options.shots) {
    json[shot] = {};
    for (const range of ranges) {
      lines.push(`## ${shot} / 範囲 ${range}`, '');
      const perSession = sessions.map((s) => rowsOf(s.shots[shot][range]));
      json[shot][range] = perSession;
      for (const [i, rows] of perSession.entries()) {
        lines.push(`### セッション ${i + 1}(ms と、基準の段に対する倍率)`, '',
          ...table(['行', ...header, ...header.map((h) => `${h} /基準`)], rows.map((r) => [r.name,
            ...r.ms.map((v) => fixed(v, 3)), ...r.ms.map((v, k) => (r.ms[baseIndexOf(TIERS[k])] > 0 ? fixed(v / r.ms[baseIndexOf(TIERS[k])], 2) : '—'))])),
          ...incrementTable(rows), '');
      }
      lines.push('### 基準に対する倍率の セッションの min〜max', '',
        ...table(['行', ...header], perSession[0].map((r, row) => [r.name, ...TIERS.map((_, k) => ratioRange(perSession.map((s) => s[row].ms), k))])), '');
      lines.push('### 走査の行の巡ごとの ms(セッション × 段。巡の順は巡ごとに逆)', '',
        ...table(['セッション', ...header], sessions.map((s, i) => {
          const rounds = s.shots[shot][range];
          const label = Object.keys(rounds[0][0])[ROWS.find((r) => r.name === '走査').index];
          return [i + 1, ...rounds.map((tierRounds) => tierRounds.map((round) => fixed(round[label], 1)).join(' / '))];
        })), '');
      const keyRow = range === 'chain' ? '鎖の和' : '近傍拡散の和';
      const keyAt = perSession.map((rows) => rows.find((r) => r.name === keyRow).ms);
      lines.push(`${keyRow} [ms] (セッションごと、全段の和): ${keyAt.map((ms) => fixed(ms.reduce((a, b) => a + b, 0), 3)).join(' / ')}`);
      const totals = keyAt.map((ms) => ms.reduce((a, b) => a + b, 0));
      const slowSessions = totals.map((v, i) => (v > 1.1 * Math.min(...totals) ? i + 1 : null)).filter((v) => v !== null);
      lines.push(slowSessions.length > 0 ? `最速のセッションの 1.1 倍を超えて遅いセッション: ${slowSessions.join(', ')}` : '最速のセッションの 1.1 倍を超えて遅いセッションは無い。', '');
    }
  }
  if (sessions.every((s) => s.shots.assemblyMs !== undefined)) {
    lines.push('## シェーダの組み立て(撮影の最初の段の切り替え + 最初の描画の壁時計 [ms]。セッションごと)', '',
      ...table(['セッション', ...header], sessions.map((s, i) => [i + 1, ...s.shots.assemblyMs[options.shots[0]].map(String)])), '',
      '組んだ順(段の添字。左から先に組む。--rotate-order が無ければ並びのまま):', '',
      ...sessions.map((s, i) => `- セッション ${i + 1}: ${(s.assemblyOrder ?? s.tiers.map((_, k) => k)).map((k) => header[k]).join(' → ')}`), '');
  }
  writeFileSync(path.join(dir, 'report.md'), lines.join('\n'));
  writeFileSync(path.join(dir, 'report.json'), JSON.stringify(json, null, 1));
  console.log(lines.join('\n'));
}

if (options.command === 'session') await session(Number(options.argument));
else if (options.command === 'report') report();
else throw new Error('usage: session <N> | report [--scales ..] [--band-counts ..] [--range ..] [--shots ..] [--out ..]');
