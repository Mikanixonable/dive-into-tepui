// 近傍拡散補正のちらつきを撮る道具(render-lab-motion.mjs・render-lab-jitter-sweep.mjs)が共有するもの — 撮る場面と描画設定、
// 位相の列の名前、描画テスト環境を開いて初期化を待つ手順、フレームごとの差の要約を列ごとに均す集計。
import path from 'node:path';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';

const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, '.render-lab');

// 撮る描画設定。映り込みの追跡は GPU によってはフレームごとに決定的でないので切る。レンズ効果は明るい面の光を、
// アンチエイリアス(値 0 はなし)は縁を広げて補正の揺れに混ぜるので切る。補正は照り返しまで描く方式で撮る。
export const MOTION_GRAPHICS = {
  screenSpaceSpecular: false, lens: false, antialias: 0, screenSpaceOcclusion: true, screenSpaceIndirect: true,
};

// 場面。light は光源を動かす列で回す観察の向きのつまみ(光源が自己発光の物だけの場面では null)。
export const SCENES = [
  { name: 'bay-earth-open', caseName: 'bay', shot: 'bay-earth-open', light: 'earthAzimuthDeg' },
  { name: 'cornell-box', caseName: 'cornell-box', shot: 'cornell-box', light: 'sunAzimuthDeg' },
  { name: 'bay-dark', caseName: 'bay', shot: 'bay-dark', light: null },
];

// 動きの参照(render-lab-motion-vectors.mjs)の場面。casingCount はケースへ置く薬莢の数、hasEntities はケースが実体の口
// (motionEntities)と値の口を持つか、orders は撮る積み順(積み順を持たないケースは 1 つ)。
export const MOTION_VECTOR_SCENES = [
  { name: 'casing-room', caseName: 'casing-room', shot: 'casing-room', casingCount: 20, hasEntities: true, orders: ['stable', 'shuffle', 'churn'] },
  { name: 'casing-pool', caseName: 'casing-pool', shot: 'casing-pool', casingCount: 260, hasEntities: true, orders: ['stable', 'shuffle', 'churn'] },
  { name: 'cornell-box', caseName: 'cornell-box', shot: 'cornell-box', casingCount: 0, hasEntities: false, orders: ['stable'] },
];

// 位相の列の名前ごとの、動かす源(tools/render-lab/phase-sequence.ts の PhaseSource)。
export const PHASE_SOURCES = {
  seed: ['seed'],
  representative: ['scanRepresentative'],
  'seed+representative': ['seed', 'scanRepresentative'],
  raster: ['raster'],
  all: ['seed', 'scanRepresentative', 'raster'],
};

// 場面の表 all から、名前を , で並べた names(undefined なら全部)に当たるもの。知らない名前は投げる。
export function selectedByName(names, all, label) {
  const selected = names?.split(',') ?? all.map(({ name }) => name);
  for (const name of selected) if (!all.some((item) => item.name === name)) throw new Error(`unknown ${label} ${name}`);
  return all.filter(({ name }) => selected.includes(name));
}

// 撮影の記録 records({ scene, sequence, summaries } — summaries[k] は補正の列の名前ごとの差の要約)の、場面と列と補正の列
// columns ごとの、差のあるフレームを均した揺れ。RMS は二乗の平均の平方根、分位はフレームの平均、最大はフレームの最大。差の
// あるフレームが無い組は含めない。
export function aggregatesOf(records, columns) {
  return records.flatMap(({ scene, sequence, summaries }) => columns.flatMap((column) => {
    const pairs = summaries.map((s) => s[column]).filter((s) => s !== null && s !== undefined);
    if (pairs.length === 0) return [];
    const mean = (values) => values.reduce((sum, v) => sum + v, 0) / pairs.length;
    const differenceRms = Math.sqrt(mean(pairs.map((s) => s.differenceRms ** 2)));
    const valueRms = Math.sqrt(mean(pairs.map((s) => s.valueRms ** 2)));
    return [{
      scene, sequence, column, pairs: pairs.length,
      reprojectedFraction: mean(pairs.map((s) => s.reprojectedFraction)),
      differenceRms, valueRms, ratio: differenceRms / valueRms,
      differencePercentile: mean(pairs.map((s) => s.differencePercentile)),
      differenceMax: Math.max(...pairs.map((s) => s.differenceMax)),
    }];
  }));
}

// ページの中で約束 expression(window.renderLab の呼び出し)を始め、終わるまで待って値を返す。1 つの要求の待ち時間の上限を
// 超える長い撮影のためのもので、timeoutMs で諦める。
export async function evaluateLong(devTools, expression, label, timeoutMs = 30 * 60_000) {
  // **式の最後の値を約束にしない** — 評価は約束の完了まで待つので、長い撮影ではそこで待ち時間の上限に掛かる。
  await devTools.evaluate(`window.__long = { done: false, value: null, error: null };
    Promise.resolve().then(() => ${expression}).then(
      (value) => { window.__long = { done: true, value, error: null }; },
      (error) => { window.__long = { done: true, value: null, error: String(error?.stack ?? error) }; });
    true`);
  await waitFor(devTools, 'window.__long.done', label, timeoutMs);
  const error = await devTools.evaluate('window.__long.error');
  if (error !== null) throw new Error(`${label} failed: ${error}`);
  return devTools.evaluate('window.__long.value');
}

// 組んだ描画テスト環境をヘッドレス Chrome で開く。ページが溜めた致命的なイベントの器も返す。ページは openLabPage で開く。
export async function openMotionLab({ port, debugPort, profilePrefix }) {
  const { fatalEvents, onEvent } = collectFatalEvents();
  const session = await openChromeSession({ serveDir: buildDir, port, debugPort, profilePrefix, onEvent });
  return { session, devTools: session.devTools, fatalEvents };
}

// セッション session の描画テスト環境のページを開き(開いていれば開き直し)、初期化を待つ。
export async function openLabPage(session) {
  const { devTools } = session;
  await devTools.send('Page.navigate', { url: `${session.baseUrl}/` });
  await waitFor(devTools,
    "(document.getElementById('error')?.textContent || typeof window.renderLab?.motionFrame === 'function')",
    'the render lab to initialise');
  const failure = await devTools.evaluate("document.getElementById('error')?.textContent ?? ''");
  if (failure) throw new Error(`Render lab failed to initialise: ${failure}`);
}
