// 生成器・描画器の半透明雲を、教師と同じ物差しで測る道具。
// cloud-lab の translucent ページがゲームと同じ生成雲場から積雲・巻雲それぞれの
// 光学的厚み(COT 相当)と雲頂高度(雲頂相当)の画像を読み出し、render-lab が同じ点の
// 可視の絵を撮る。どちらにも教師と同じ判定(cloud-translucent-features)と特徴量を
// そのまま当て、型ごとの窓の割合・特徴量ごとの正規化ワッサースタイン距離・
// 芯との関係・鱗雲の中規模構造・筋雲の筋の揃いを出し、型ごとのコンタクトシートを
// 教師の窓と並べる。結果は .cloud-detail/translucent-compare/ へ。
// 窓は教師 manifest の採用点の緯度経度(別時刻の姿)と、全球ランダムの両方から取る。
// 動作の差し替えは作業ツリー直下の .loop-imitation-config.json。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';
import { measureTranslucentWindow } from './cloud-translucent-features.mjs';
import { FEATURE_DIMS } from './cloud-translucent-report.mjs';
import { buildContactSheet } from './cloud-translucent-contact-sheet.mjs';
import { CLASSES, boxAround, dilateMask, mulberry32 } from './cloud-translucent-gibs.mjs';
import { linearLuminanceField, centerCrop } from './cloud-detail-field.mjs';
import { cropField } from './gray-image.mjs';
import { decodePng } from './png.mjs';
import { normalizedDistance, quantiles } from './cloud-detail-metrics.mjs';
import {
  ANVIL_RADIUS_KM, advectedCoreMask, classifyGeneratedWindow, combinedOptics, cotP50Of,
  deepCoreMask, decodePhysPixels, decodeWindPixels, overlapShare, translucentMask, windDegOf,
} from './cloud-translucent-generated.mjs';

const root = path.resolve(import.meta.dirname, '..');
const cloudLabDir = path.join(root, '.cloud-lab');
const renderLabDir = path.join(root, '.render-lab');
const outDir = path.join(root, '.cloud-detail', 'translucent-compare');
const shotsDir = path.join(outDir, 'shots');
const configFile = path.join(root, '.loop-imitation-config.json');
const port = Number(process.env.CLOUD_LAB_PORT ?? 8831);
const debugPort = Number(process.env.CLOUD_LAB_DEBUG_PORT ?? 9531);
// 切り出し面の一辺 [px](ページの BOX_PX と同じ)。
const BOX_PX = 512;
// 型の割合・距離を出す分位点(教師 report の p10/p50/p90 と同じ)。
const QUANTILE_FRACTIONS = [0.1, 0.5, 0.9];
// 1 枚の撮影から測る窓の一辺 [px]。512 px が教師の 512 km 窓、256・128 px がその中心の
// 細かい窓(512 km の中の構造を見るためだけに集計し、教師との距離は 512 px で比べる)。
const WINDOW_SCALES_PX = [512, 256, 128];
// 撮影の段 [km/px](教師と同じ 1・4)。
const TIERS_KM_PER_PX = [1, 4];
// 教師の窓の一辺 [km]。距離を比べるのはこの一辺の窓だけ。
const TEACHER_FRAME_KM = 512;
// コンタクトシートのセル(cloud-translucent-contact-sheet の並びと同じ)。
const SHEET_COLS = 6;
const SHEET_THUMB = 128;
const SHEET_PAD = 4;
const SHEET_TITLE_H = 12;
const SHEET_LABEL_H = 10;

// .loop-imitation-config.json。無い・壊れているときは既定値で動く。
function loadConfig() {
  const defaults = {
    teacherDir: '/Users/pandeaconica/lab/dive-into-tepui2-data/translucent-teacher-20261115',
    timesPerLocation: 2,
    randomWindows: 30,
    limit: null,
    seed: 20261115,
  };
  if (!existsSync(configFile)) return defaults;
  try {
    return { ...defaults, ...JSON.parse(readFileSync(configFile, 'utf8')) };
  } catch {
    return defaults;
  }
}

// webpack の両ビルド(cloud-lab の読み出しページと render-lab の撮影ページ)。
function build() {
  for (const config of ['webpack.cloud-lab.config.js', 'webpack.render-lab.config.js']) {
    const r = spawnSync(
      process.execPath,
      [path.join(root, 'node_modules', 'webpack-cli', 'bin', 'cli.js'), '--config', config, '--mode', 'production'],
      { cwd: root, stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`webpack --config ${config} が失敗した`);
  }
}

// 名前から決定的に引く雲場の進行時刻 [s](cloud-detail-distribution と同じ作り)。
function displayTimeOf(name, seed) {
  let hash = 2166136261 ^ seed;
  for (const char of name) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0) % 86400;
}

// PNG バイト列の中央 128² を RGB のサムネイルへ(教師 report と同じ切り方)。
function thumbOf(pngBytes) {
  const rgb = decodePng(pngBytes);
  const tx0 = Math.floor((rgb.width - SHEET_THUMB) / 2);
  const ty0 = Math.floor((rgb.height - SHEET_THUMB) / 2);
  const thumb = new Uint8Array(SHEET_THUMB * SHEET_THUMB * 3);
  for (let y = 0; y < SHEET_THUMB; y++) {
    for (let x = 0; x < SHEET_THUMB; x++) {
      const from = ((ty0 + y) * rgb.width + tx0 + x) * rgb.channels;
      const to = (y * SHEET_THUMB + x) * 3;
      thumb[to] = rgb.data[from];
      thumb[to + 1] = rgb.data[from + 1];
      thumb[to + 2] = rgb.data[from + 2];
    }
  }
  return thumb;
}

// 教師の接触シートからセルを切り出し、ラベル付きサムネイルへ戻す。
function teacherThumbs(teacherDir, className) {
  const file = path.join(teacherDir, `sheet-${className}.png`);
  if (!existsSync(file)) return [];
  const sheet = decodePng(readFileSync(file));
  const cols = SHEET_COLS;
  const rows = Math.floor((sheet.height - SHEET_TITLE_H - SHEET_PAD) / (SHEET_THUMB + SHEET_LABEL_H + SHEET_PAD));
  const thumbs = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cx = SHEET_PAD + c * (SHEET_THUMB + SHEET_PAD);
      const cy = SHEET_TITLE_H + r * (SHEET_THUMB + SHEET_LABEL_H + SHEET_PAD);
      if (cx + SHEET_THUMB > sheet.width || cy + SHEET_THUMB > sheet.height) continue;
      const thumb = new Uint8Array(SHEET_THUMB * SHEET_THUMB * 3);
      for (let y = 0; y < SHEET_THUMB; y++) {
        for (let x = 0; x < SHEET_THUMB; x++) {
          const from = ((cy + y) * sheet.width + cx + x) * sheet.channels;
          const to = (y * SHEET_THUMB + x) * 3;
          thumb[to] = sheet.data[from];
          thumb[to + 1] = sheet.data[from + 1];
          thumb[to + 2] = sheet.data[from + 2];
        }
      }
      thumbs.push({ label: `T${thumbs.length}`, rgb: thumb });
    }
  }
  return thumbs;
}

// 中央 s×s の切り出し(フラットな画素列。y0 = x0 = (512−s)/2)。
function cropCenter(array, n, s) {
  const out = new array.constructor(s * s);
  const o = (n - s) / 2;
  for (let y = 0; y < s; y++) out.set(array.subarray((o + y) * n + o, (o + y) * n + o + s), y * s);
  return out;
}

// 生成側の 1 窓。shot は render-lab の返り値、physB64・windB64 はページの読み出し。
// scales ぶんの計測レコードを返す。
function measureWindow({ png }, physB64, windB64, scales) {
  const luminance = centerCrop(linearLuminanceField(png));
  const phys = decodePhysPixels(physB64, BOX_PX);
  const wind = decodeWindPixels(windB64, BOX_PX);
  const { cot, cth } = combinedOptics(phys, BOX_PX);
  const { mask, share, cotValues } = translucentMask(cot, cth, BOX_PX);
  const windDeg = windDegOf(wind.upperEast, wind.upperNorth, BOX_PX);
  // 窓全体の上層風の平均成分(移流した芯の位置決めに使う)。
  let uE = 0;
  let uN = 0;
  for (let i = 0; i < BOX_PX * BOX_PX; i++) { uE += wind.upperEast[i]; uN += wind.upperNorth[i]; }
  uE /= BOX_PX * BOX_PX;
  uN /= BOX_PX * BOX_PX;

  const records = [];
  for (const s of scales) {
    const o = (BOX_PX - s) / 2;
    const field = s === BOX_PX ? luminance : cropField(luminance, o, o, s, s);
    const maskS = s === BOX_PX ? mask : cropCenter(mask, BOX_PX, s);
    const cotS = s === BOX_PX ? cot : cropCenter(cot, BOX_PX, s);
    const cthS = s === BOX_PX ? cth : cropCenter(cth, BOX_PX, s);
    const cotValsS = s === BOX_PX ? cotValues : [];
    if (s !== BOX_PX) {
      for (let i = 0; i < s * s; i++) {
        if (maskS[i] === 1) cotValsS.push(cotS[i]);
      }
    }
    const shareS = (() => { let c = 0; for (const v of maskS) c += v; return c / (s * s); })();
    records.push({ s, field, mask: maskS, cot: cotS, cth: cthS, cotValues: cotValsS, share: shareS });
  }
  return { luminance, phys, wind, cot, cth, mask, share, cotValues, windDeg, uE, uN, records };
}

async function main() {
  build();
  const config = loadConfig();
  const manifestFile = path.join(config.teacherDir, 'manifest.json');
  const reportFile = path.join(config.teacherDir, 'report.json');
  if (!existsSync(manifestFile)) throw new Error(`${manifestFile} が無い — teacherDir を .loop-imitation-config.json で指す`);
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  const teacherReport = existsSync(reportFile) ? JSON.parse(readFileSync(reportFile, 'utf8')) : null;
  const accepted = (manifest.candidates ?? []).filter((c) => c.status === 'ok');

  // 窓の計画: 採用点 × timesPerLocation(同じ場所の別時刻の姿)と全球ランダム。
  const targets = [];
  for (const point of accepted) {
    const lat = point.window?.lat ?? point.lat;
    const lon = point.window?.lon ?? point.lon;
    for (let k = 0; k < config.timesPerLocation; k++) {
      const name = `m-${point.className}-${String(point.slot).padStart(3, '0')}-k${k}`;
      targets.push({
        name, source: 'manifest', teacherClass: point.className,
        latitudeDeg: lat, longitudeDeg: lon,
        displayTime: displayTimeOf(`${name}@${config.seed}`, config.seed),
      });
    }
  }
  const rand = mulberry32(config.seed);
  for (let i = 0; i < config.randomWindows; i++) {
    // 面で一様な緯度(sin 一様)。生成器は全球を焼くので帯で絞らない。
    const lat = (Math.asin(rand() * 2 - 1) * 180) / Math.PI;
    const lon = rand() * 360 - 180;
    const name = `r-${String(i).padStart(3, '0')}`;
    targets.push({
      name, source: 'random', teacherClass: null,
      latitudeDeg: lat, longitudeDeg: lon,
      displayTime: displayTimeOf(`${name}@${config.seed}`, config.seed),
    });
  }
  const limited = config.limit === null ? targets : targets.slice(0, config.limit);
  console.log(`窓 ${limited.length} 件(採用点 ${accepted.length} 点 × ${config.timesPerLocation} + ランダム ${config.randomWindows})`);

  // --- セッション: cloud-lab(物理量の読み出し)と render-lab(可視の撮影) ---
  const labEvents = collectFatalEvents();
  const labSession = await openChromeSession({
    serveDir: cloudLabDir, port, debugPort, profilePrefix: 'cloud-translucent-',
    onEvent: labEvents.onEvent, requestTimeoutMs: 120_000,
  });
  const shotEvents = collectFatalEvents();
  const shotSession = await openChromeSession({
    serveDir: renderLabDir, port: port + 2, debugPort: debugPort + 2,
    profilePrefix: 'cloud-translucent-shot-', onEvent: shotEvents.onEvent, requestTimeoutMs: 120_000,
  });

  const windows = [];
  try {
    const lab = labSession.devTools;
    const shot = shotSession.devTools;
    await lab.send('Page.navigate', { url: `${labSession.baseUrl}/translucent.html` });
    await waitFor(lab, '!!window.cloudTranslucent', 'cloud translucent probe', 180_000);
    console.log('probe ready');
    await shot.send('Page.navigate', { url: `${shotSession.baseUrl}/` });
    await waitFor(
      shot,
      "(document.getElementById('error')?.textContent || typeof window.renderLab?.shootCloudDetailRandom === 'function')",
      'the render lab to initialise',
    );
    const labFailure = await shot.evaluate("document.getElementById('error')?.textContent ?? ''");
    if (labFailure) throw new Error(`Render lab failed to initialise: ${labFailure}`);

    mkdirSync(shotsDir, { recursive: true });
    let done = 0;
    for (const target of limited) {
      for (const tierKmPerPx of TIERS_KM_PER_PX) {
        const name = `${target.name}-${tierKmPerPx}km`;
        const shotFile = path.join(shotsDir, `${name}.png`);
        const point = {
          category: 'translucent',
          latitudeDeg: target.latitudeDeg,
          longitudeDeg: target.longitudeDeg,
          displayTime: target.displayTime,
          tierKmPerPx,
        };
        const shotResult = await shot.evaluate(
          `window.renderLab.shootCloudDetailRandom(${JSON.stringify(name)}, ${JSON.stringify(point)})`);
        writeFileSync(shotFile, Buffer.from(shotResult.png.slice(shotResult.png.indexOf(',') + 1), 'base64'));
        const pngBytes = readFileSync(shotFile);
        const kmPerPx = shotResult.centerKmPerPx;
        const sideKm = BOX_PX * kmPerPx;
        // cap は窓の対角の半分を覆う角半径へ置き直す(置き方は本番と同じ格子へ揃われる)。
        await lab.evaluate(
          `window.cloudTranslucent.aim(${target.latitudeDeg}, ${target.longitudeDeg}, ${(sideKm / 2) * Math.SQRT2})`);
        await lab.evaluate(`window.cloudTranslucent.prepare(${target.displayTime / 3600})`);
        const spec = boxAround(target.latitudeDeg, target.longitudeDeg, sideKm);
        const physB64 = await lab.evaluate(`window.cloudTranslucent.samplePhysBox(${JSON.stringify(spec)})`);
        const windB64 = await lab.evaluate(`window.cloudTranslucent.sampleWindBox(${JSON.stringify(spec)})`);

        const w = measureWindow(
          { png: pngBytes, centerKmPerPx: kmPerPx }, physB64, windB64, WINDOW_SCALES_PX);
        for (const rec of w.records) {
          const core = deepCoreMask(w.phys.cumTau, w.phys.cumTop, BOX_PX, target.latitudeDeg, kmPerPx);
          const coreS = rec.s === BOX_PX ? core.mask : cropCenter(core.mask, BOX_PX, rec.s);
          const coreCountS = (() => { let c = 0; for (const v of coreS) c += v; return c; })();
          // 芯の 60 km 内の膨張と重なり(anvil)、移流した芯との重なり(remnant)。
          const near = dilateMask(coreS, rec.s, rec.s, Math.max(1, Math.round(ANVIL_RADIUS_KM / kmPerPx)));
          const anvilNear = coreCountS > 0 && overlapShare(near, rec.mask, rec.s) > 0;
          const advected = coreCountS > 0
            ? advectedCoreMask(coreS, rec.s, kmPerPx, w.uE, w.uN)
            : null;
          const remnantOverlap = advected === null ? 0 : overlapShare(advected, rec.mask, rec.s);
          const measured = measureTranslucentWindow(rec.field, {
            kmPerPx,
            mask: rec.mask,
            cot: rec.cot,
            cth: rec.cth,
            coreMask: coreCountS > 0 ? coreS : undefined,
            windDeg: w.windDeg,
          });
          measured.cotP50 = cotP50Of(rec.cotValues);
          const cls = classifyGeneratedWindow({
            share: rec.share,
            anvilNear,
            coreInWindow: coreCountS > 0,
            remnantOverlap,
            measured,
          });
          windows.push({
            name, source: target.source, teacherClass: target.teacherClass,
            latitudeDeg: target.latitudeDeg, longitudeDeg: target.longitudeDeg,
            displayTime: target.displayTime, kmPerPx, scalePx: rec.s,
            frameKm: rec.s * kmPerPx,
            share: rec.share, className: cls.className, rule: cls.rule,
            windDeg: w.windDeg, corePixels: coreCountS,
            anvilNear, remnantOverlap, assoc: measured.assoc, measured,
          });
        }
        done++;
        if (done % 10 === 0 || done === limited.length * TIERS_KM_PER_PX.length) {
          console.log(`窓 ${done}/${limited.length * TIERS_KM_PER_PX.length} ${name}`);
        }
      }
    }
    if (labEvents.fatalEvents.length > 0 || shotEvents.fatalEvents.length > 0) {
      for (const e of [...labEvents.fatalEvents, ...shotEvents.fatalEvents]) console.error(`[page] ${e}`);
      throw new Error('ページが致命的なイベントを出した');
    }
  } finally {
    await labSession.close();
    await shotSession.close();
  }

  // --- 集計 ---
  // 距離を比べるのは教師と同じ 512 km の窓だけ(scalePx=512 かつ frameKm≈512)。
  const atTeacherScale = windows.filter((r) => r.scalePx === BOX_PX && Math.abs(r.frameKm - TEACHER_FRAME_KM) < TEACHER_FRAME_KM / 2);
  const shares = { teacher: {}, generated: {} };
  for (const className of [...CLASSES, 'unclassified', 'clear']) {
    shares.teacher[className] = accepted.filter((c) => c.className === className).length / Math.max(1, accepted.length);
    shares.generated[className] = atTeacherScale.filter((r) => r.className === className).length / Math.max(1, atTeacherScale.length);
  }

  // 型 × 特徴量の分位点と正規化ワッサースタイン距離(教師は report.features の p10/p50/p90)。
  const featureTable = {};
  const teacherDims = teacherReport?.features ?? {};
  for (const className of CLASSES) {
    const genRecords = atTeacherScale.filter((r) => r.className === className).map((r) => r.measured);
    const dims = {};
    for (const [dimName, get] of FEATURE_DIMS) {
      const tq = teacherDims[className]?.dims?.[dimName];
      const genValues = genRecords.map(get).filter((v) => v !== null && Number.isFinite(v));
      const genQ = genValues.length > 0 ? quantiles(genValues, QUANTILE_FRACTIONS) : null;
      const realQ = tq ? [tq.p10, tq.p50, tq.p90] : null;
      dims[dimName] = {
        teacherQ: realQ, genQ,
        nTeacher: tq?.n ?? 0, nGen: genValues.length,
        ...(realQ !== null && genQ !== null ? normalizedDistance(realQ, genQ) : { distance: null }),
      };
    }
    featureTable[className] = { n: genRecords.length, dims };
  }

  // 芯の統計: 深い対流の芯が窓の中へどれだけ出るか。anvil の拾い方(60 km 内に半透明)へ
  // 届く窓が無いときは、芯が無いのか半透明が芯に寄っていないのかをここで切り分ける。
  const coreStats = {
    windowsWithCore: atTeacherScale.filter((r) => r.corePixels > 0).length,
    windowsAnvilNear: atTeacherScale.filter((r) => r.anvilNear).length,
    windowsWithAssoc: atTeacherScale.filter((r) => r.assoc !== null).length,
    coreDistKm: (() => {
      const values = atTeacherScale.map((r) => r.assoc?.coreDistKm ?? null)
        .filter((v) => v !== null && Number.isFinite(v));
      return values.length > 0 ? quantiles(values, QUANTILE_FRACTIONS) : null;
    })(),
  };

  // 芯との関係(対流系の型)と孤立系の型の構造を、型ごとに分位点で出す。
  const assocTable = {};
  for (const className of ['anvil-active', 'convective-remnant']) {
    const list = atTeacherScale.filter((r) => r.className === className);
    const pick = (get) => {
      const values = list.map(get).filter((v) => v !== null && Number.isFinite(v));
      return values.length > 0 ? quantiles(values, QUANTILE_FRACTIONS) : null;
    };
    const teacherCoreDist = accepted.filter((c) => c.className === className)
      .map((c) => c.coreDistKm).filter((v) => v !== null && Number.isFinite(v));
    assocTable[className] = {
      n: list.length,
      asymmetry: pick((r) => r.measured.assoc?.asymmetry ?? null),
      spreadRatio: pick((r) => r.measured.assoc?.spreadRatio ?? null),
      coreDistKm: pick((r) => r.measured.assoc?.coreDistKm ?? null),
      bins: [0, 1, 2, 3, 4].map((b) => pick((r) => r.measured.assoc?.bins?.[b]?.maskShare ?? null)),
      teacherCoreDistKm: teacherCoreDist.length > 0 ? quantiles(teacherCoreDist, QUANTILE_FRACTIONS) : null,
    };
  }

  // 鱗雲の中規模の構造 — 教師 report の scalyStructure と同じ次元を型ごとに出す。
  const scalyTable = {};
  const teacherScaly = teacherReport?.scalyStructure ?? {};
  for (const className of [...CLASSES, 'unclassified']) {
    const list = atTeacherScale.filter((r) => r.className === className).map((r) => r.measured);
    if (list.length === 0 && teacherScaly[className] === undefined) continue;
    const pick = (get) => {
      const values = list.map(get).filter((v) => v !== null && Number.isFinite(v));
      return values.length > 0 ? quantiles(values, QUANTILE_FRACTIONS) : null;
    };
    scalyTable[className] = {
      n: list.length,
      midPowerRatio: pick((m) => m.scaly.midPowerRatio),
      boxDim: pick((m) => m.scaly.boxDim),
      gapShare: pick((m) => m.scaly.gapShare),
      clearBlockShare: pick((m) => m.scaly.clearBlockShare),
      clusterAniso20: pick((m) => m.scaly.clusterAniso.s20 ?? null),
      clusterAniso63: pick((m) => m.scaly.clusterAniso.s63 ?? null),
      gradientStrength: pick((m) => m.scaly.gradient?.strength ?? null),
      gapIntensity: pick((m) => m.scaly.gapIntensity),
      edgeSharpness: pick((m) => m.scaly.edgeSharpness),
      teacher: teacherScaly[className] ?? null,
    };
  }

  // 筋雲の筋の揃い: 向き・揃い度・相関長と、筋の向きと上層風の一致。
  const streakRecords = atTeacherScale.filter((r) => r.className === 'streak');
  const streakTable = {
    n: streakRecords.length,
    coherence20: streakRecords.length > 0
      ? quantiles(streakRecords.map((r) => r.measured.aniso.coherence20).filter((v) => v !== null), QUANTILE_FRACTIONS) : null,
    coherence63: streakRecords.length > 0
      ? quantiles(streakRecords.map((r) => r.measured.aniso.coherence63).filter((v) => v !== null), QUANTILE_FRACTIONS) : null,
    r63: streakRecords.length > 0
      ? quantiles(streakRecords.map((r) => r.measured.aniso.r63).filter((v) => v !== null), QUANTILE_FRACTIONS) : null,
    lThetaKm: streakRecords.length > 0
      ? quantiles(streakRecords.map((r) => r.measured.aniso.lThetaKm).filter((v) => v !== null), QUANTILE_FRACTIONS) : null,
    // 筋の向きと上層風の向きの差 [deg](90° 周期 — 筋に表裏は無い)。
    windAlignDeg: (() => {
      const diffs = streakRecords
        .filter((r) => r.measured.aniso.orientationDeg63 !== null && r.windDeg !== null)
        .map((r) => {
          let d = Math.abs(r.measured.aniso.orientationDeg63 - r.windDeg) % 180;
          return Math.min(d, 180 - d);
        });
      return diffs.length > 0 ? quantiles(diffs, QUANTILE_FRACTIONS) : null;
    })(),
    teacher: teacherDims.streak?.dims ?? null,
  };

  // --- コンタクトシート(型ごとに教師の窓と生成の窓を 1 枚へ) ---
  mkdirSync(outDir, { recursive: true });
  const sheets = [];
  for (const className of CLASSES) {
    const thumbs = [...teacherThumbs(config.teacherDir, className)];
    const gen = windows.filter((r) => r.className === className && r.scalePx === BOX_PX);
    for (let i = 0; i < gen.length; i++) {
      const pngBytes = readFileSync(path.join(shotsDir, `${gen[i].name}.png`));
      thumbs.push({ label: `G${i}`, rgb: thumbOf(pngBytes) });
    }
    if (thumbs.length === 0) continue;
    const file = path.join(outDir, `sheet-${className}.png`);
    writeFileSync(file, buildContactSheet(`${className}  T=teacher G=generated`, thumbs));
    sheets.push(file);
  }

  const report = {
    tool: 'cloud-translucent-compare',
    generatedAt: new Date().toISOString(),
    teacherDir: config.teacherDir,
    coreStats,
    counts: {
      teacher: Object.fromEntries(CLASSES.map((c) => [c, accepted.filter((p) => p.className === c).length])),
      generatedWindows: atTeacherScale.length,
      generatedByClass: Object.fromEntries(
        [...CLASSES, 'unclassified', 'clear'].map((c) => [c, atTeacherScale.filter((r) => r.className === c).length])),
      byScale: Object.fromEntries(WINDOW_SCALES_PX.map((s) => [s, windows.filter((r) => r.scalePx === s).length])),
    },
    shares,
    features: featureTable,
    assoc: assocTable,
    scaly: scalyTable,
    streak: streakTable,
    windows: windows.map((w) => {
      const copy = { ...w };
      delete copy.measured;
      return copy;
    }),
  };
  const reportFileOut = path.join(outDir, 'report.json');
  writeFileSync(reportFileOut, `${JSON.stringify(report, null, 2)}\n`);

  // --- 表を出す ---
  console.log(`芯の統計: 芯を含む窓 ${coreStats.windowsWithCore}/${atTeacherScale.length}、`
    + `anvil の拾い方に届く窓 ${coreStats.windowsAnvilNear}、assoc の測れた窓 ${coreStats.windowsWithAssoc}`);
  console.log('\n型ごとの窓の割合(教師 vs 生成):');
  for (const className of [...CLASSES, 'unclassified', 'clear']) {
    const t = (shares.teacher[className] * 100).toFixed(1).padStart(6);
    const g = (shares.generated[className] * 100).toFixed(1).padStart(6);
    console.log(`  ${className.padEnd(20)} ${t}%  vs ${g}%`);
  }
  console.log('\n型 × 特徴量の正規化距離(p10/p50/p90 の平均絶対差 / 教師の p10〜p90 幅):');
  for (const className of CLASSES) {
    const rows = Object.entries(featureTable[className].dims)
      .filter(([, d]) => d.distance !== null && Number.isFinite(d.distance))
      .sort((a, b) => b[1].distance - a[1].distance);
    console.log(`  ${className} (生成 n=${featureTable[className].n}):`);
    for (const [dimName, d] of rows) {
      console.log(`    ${dimName.padEnd(18)} ${d.distance.toFixed(2).padStart(6)}  T[${d.teacherQ.map((q) => q.toPrecision(3)).join(',')}] G[${d.genQ.map((q) => q.toPrecision(3)).join(',')}]`);
    }
  }
  console.log(`\nコンタクトシート: ${sheets.map((f) => path.basename(f)).join(', ')}`);
  console.log(`レポート: ${reportFileOut}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
