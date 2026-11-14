// 分布比較の実写の教師を、区分ごとのランダムな点で抽出する。固定の乱数の種で候補を立て、
// 緯度帯・季節制限・窓の陸海条件を満たした点へ、NASA Worldview の MODIS Terra 真色スナップショットを
// 1・4 km/px で 512×512 取る。欠測(黒の画素が 5% 以上)や取得失敗は候補ごと捨てて次へ進み、
// 採用・棄却を manifest.json へ残す。既にある画像は取り直さない。
// 動作確認は少数の点だけを取る軽い版 — npm script cloud-detail:random-teacher-smoke
// (npm_lifecycle_event に 'smoke' が入る)で、SMOKE_CATEGORIES の区分を SMOKE_COUNT 点だけ取る。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { decodePng } from './png.mjs';

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(root, '.cloud-detail', 'random-teacher');
const manifestFile = path.join(outDir, 'manifest.json');

// 乱数の種。同じ種なら候補の系列が同じになり、同じ範囲の抽出を再現できる。
const SEED = 20241117;
// 区分ごとの点数と、撮る段 [km/px] と 1 辺の画素数。
const POINTS_PER_CATEGORY = 40;
const TIERS_KM_PER_PX = [1, 4];
const SIZE = 512;
// Worldview へのリクエスト間隔 [ms]。1 秒に 2 回程度までに抑える。
const REQUEST_INTERVAL = 500;
// 採用に要る有効率(黒い画素が 5% 未満)。GIBS の欠測・観測幅の外は (0,0,0) で返る。
const MIN_COVERED = 0.95;
// 1 点に試す候補の上限。回線が落ちているなどで連続して失敗するとき、永久に取り直さないため。
// 欠測の棄却率が高い(熱帯で約 3/4)ので、ほぼ埋まる程度には深く掘る。
const MAX_TRIES_PER_SLOT = 20;
// 日付の取り方。2023-01-01〜2024-12-31 の 731 日から一様に。
const DATE_RANGE = { start: '2023-01-01', days: 731 };
// 緯度経度 1° の長さ [km]。km/px の指定は公称値なので、BBOX の換算も近似値で足りる。
const KM_PER_DEGREE = 111.32;
const LAYER = 'MODIS_Terra_CorrectedReflectance_TrueColor';
// 窓の陸海条件を判定する窓の一辺 [km]。1・4 km/px の画像が張る地表の範囲で、両方の段の
// 画像が同じ種類の地表を映すことを要求する。
const WINDOW_KM = TIERS_KM_PER_PX.map((kmPerPx) => kmPerPx * SIZE);
// 窓内の陸海の内訳を推す格子の 1 辺の点数。
const WINDOW_GRID = 16;
// 窓の陸海条件。海区分は海がこの割合以上、陸区分は陸がこの割合以上を、WINDOW_KM の両方の窓で要求する。
const SEA_MIN_SHARE = 0.9;
const LAND_MIN_SHARE = 0.7;

// 区分の定義。緯度帯は |緯度| の範囲 [deg]、陸海の条件は窓の内訳。months は高緯度区分の
// 季節制限(海氷・雪を避ける)で、北半球・南半球それぞれ許す月(1-12)。
const CATEGORIES = [
  { name: 'tropical-sea', surface: 'sea', latitudeBand: [0, 25] },
  { name: 'temperate-sea', surface: 'sea', latitudeBand: [25, 55] },
  { name: 'highlat-sea', surface: 'sea', latitudeBand: [55, 65], months: { north: [6, 7, 8, 9, 10], south: [11, 12, 1, 2, 3] } },
  { name: 'tropical-land', surface: 'land', latitudeBand: [0, 25] },
  { name: 'temperate-land', surface: 'land', latitudeBand: [25, 55] },
  { name: 'highlat-land', surface: 'land', latitudeBand: [55, 65], months: { north: [6, 7, 8, 9], south: [12, 1, 2] } },
];

// 種から組む一様乱数(selftest と同じ mulberry32)。
function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// src/assets/earth-climate.png(正距円筒 RGB8: R 平均気温 / G 雲量 / B 標高 0..8000m)の
// B チャンネルから組む陸海マスク。climate-map.ts の landFraction = smoothstep(0, 100m, 標高) を
// そのまま真似、0.5 以上を陸とする。
const climate = decodePng(readFileSync(path.join(root, 'src', 'assets', 'earth-climate.png')));
const smoothstep = (edge0, edge1, x) => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

// 緯度 latitudeDeg・経度 longitudeDeg [deg] の陸らしさ 0..1。正距円筒の取り決め
// (u=0.5 が経度 0、v=0 が北極)で最近傍のテクセルを読む。
function landFractionAt(latitudeDeg, longitudeDeg) {
  const u = (longitudeDeg / 360 + 0.5 + 1) % 1;
  const v = Math.min(1, Math.max(0, 0.5 - latitudeDeg / 180));
  const x = Math.min(climate.width - 1, Math.floor(u * climate.width));
  const y = Math.min(climate.height - 1, Math.floor(v * climate.height));
  const elevation = (climate.data[(y * climate.width + x) * climate.channels + 2] / 255) * 8000;
  return smoothstep(0, 100, elevation);
}

// 中心 (latitudeDeg, longitudeDeg) の一辺 windowKm の窓(BBOX)のうち陸が占める割合。
// BBOX の領域を格子で走り、面積に近いよう cos(緯度) で重み付けする。
function landShareInWindow(latitudeDeg, longitudeDeg, windowKm) {
  const halfLatitude = (windowKm / 2) / KM_PER_DEGREE;
  const halfLongitude = (windowKm / 2) / (KM_PER_DEGREE * Math.cos((latitudeDeg * Math.PI) / 180));
  let land = 0;
  let total = 0;
  for (let j = 0; j < WINDOW_GRID; j++) {
    const latitude = latitudeDeg - halfLatitude + (j / (WINDOW_GRID - 1)) * 2 * halfLatitude;
    const weight = Math.max(0, Math.cos((latitude * Math.PI) / 180));
    for (let i = 0; i < WINDOW_GRID; i++) {
      const longitude = longitudeDeg - halfLongitude + (i / (WINDOW_GRID - 1)) * 2 * halfLongitude;
      land += weight * landFractionAt(latitude, longitude);
      total += weight;
    }
  }
  return land / total;
}

// 点が区分の条件を満たすか。緯度帯は抽出の段で既に絞るので、ここでは窓の陸海条件と
// BBOX が日付変更線・極を跨がないかを見る。
function candidateValid(category, latitudeDeg, longitudeDeg) {
  const halfLatitudeMax = (Math.max(...WINDOW_KM) / 2) / KM_PER_DEGREE;
  if (Math.abs(latitudeDeg) + halfLatitudeMax > 89.5) return false;
  for (const windowKm of WINDOW_KM) {
    const halfLongitude = (windowKm / 2) / (KM_PER_DEGREE * Math.cos((latitudeDeg * Math.PI) / 180));
    if (longitudeDeg - halfLongitude < -180 || longitudeDeg + halfLongitude > 180) return false;
    const landShare = landShareInWindow(latitudeDeg, longitudeDeg, windowKm);
    if (category.surface === 'sea' && landShare > 1 - SEA_MIN_SHARE) return false;
    if (category.surface === 'land' && landShare < LAND_MIN_SHARE) return false;
  }
  return true;
}

// 日付が区分の季節制限を満たすか。制限の無い区分は常に可。
function dateAllowed(category, latitudeDeg, month) {
  if (category.months === undefined) return true;
  const allowed = latitudeDeg >= 0 ? category.months.north : category.months.south;
  return allowed.includes(month);
}

// 区分の候補を決定的に列挙する生成器。緯度は緯度帯の中で球面上の面積一様(sin 緯度を一様に)、
// 経度は一様、日付は DATE_RANGE から一様に立て、オフラインの条件(季節・窓の陸海・BBOX)を
// 通ったものだけを返す。得られる列は SEED だけで決まる。
function* candidateStream(category, categoryIndex) {
  const rng = mulberry32(SEED + categoryIndex * 0x9e3779b9);
  const [latMin, latMax] = category.latitudeBand;
  const sinMin = Math.sin((latMin * Math.PI) / 180);
  const sinMax = Math.sin((latMax * Math.PI) / 180);
  const epoch = Date.parse(`${DATE_RANGE.start}T00:00:00Z`);
  let index = 0;
  while (true) {
    const south = rng() < 0.5;
    const latitude = (south ? -1 : 1) * Math.asin(sinMin + rng() * (sinMax - sinMin)) * 180 / Math.PI;
    const longitude = rng() * 360 - 180;
    const dayOffset = Math.floor(rng() * DATE_RANGE.days);
    const date = new Date(epoch + dayOffset * 86400e3).toISOString().slice(0, 10);
    const month = Number(date.slice(5, 7));
    if (dateAllowed(category, latitude, month) && candidateValid(category, latitude, longitude)) {
      yield { index: index++, latitude, longitude, date };
    }
  }
}

// Worldview Snapshots API の URL。BBOX の並びは south,west,north,east。
function snapshotUrl(latitude, longitude, date, kmPerPx) {
  const halfKm = (kmPerPx * SIZE) / 2;
  const halfLatitude = halfKm / KM_PER_DEGREE;
  const halfLongitude = halfKm / (KM_PER_DEGREE * Math.cos((latitude * Math.PI) / 180));
  const bbox = {
    south: latitude - halfLatitude,
    west: longitude - halfLongitude,
    north: latitude + halfLatitude,
    east: longitude + halfLongitude,
  };
  return 'https://wvs.earthdata.nasa.gov/api/v1/snapshot?REQUEST=GetSnapshot'
    + `&TIME=${date}T00:00:00Z&BBOX=${bbox.south},${bbox.west},${bbox.north},${bbox.east}`
    + `&CRS=EPSG:4326&LAYERS=${LAYER}&WRAP=day&FORMAT=image/png`
    + `&WIDTH=${SIZE}&HEIGHT=${SIZE}`;
}

// 前のリクエストから REQUEST_INTERVAL 以上あくまで待つ。
let lastRequestAt = 0;
async function throttle() {
  const wait = REQUEST_INTERVAL - (Date.now() - lastRequestAt);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt = Date.now();
}

// 1 枚の取得。回線の瞬断や HTTP エラーでは、再試行を 2 回まで行う。
async function fetchSnapshot(url, id) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await throttle();
      const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes[0] !== 0x89 || bytes[1] !== 0x50) {
        throw new Error(`PNG でない応答(先頭: ${Buffer.from(bytes.subarray(0, 120)).toString('utf8')})`);
      }
      return bytes;
    } catch (e) {
      lastError = e;
      console.log(`${id}: 取得に失敗(${e.message}) — ${attempt}/3 回目`);
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
  throw lastError;
}

// 画素のうち値のある画素(RGB の最大が黒レベルを超える)の割合。
function coveredFraction(png) {
  let covered = 0;
  const total = png.width * png.height;
  for (let i = 0; i < total; i++) {
    const o = i * png.channels;
    if (Math.max(png.data[o], png.data[o + 1] ?? 0, png.data[o + 2] ?? 0) >= 16) covered++;
  }
  return covered / total;
}

// 撮影名に使う番号と、画像の置き名。
const pointName = (category, slot) => `${category}-${String(slot).padStart(3, '0')}`;
const pointFile = (category, slot, kmPerPx) => `${pointName(category, slot)}-${kmPerPx}km.png`;

// 既存の manifest を読む。無い・壊れているときは空で始める。
function loadManifest() {
  if (!existsSync(manifestFile)) return { points: [], rejected: [] };
  try {
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    return { points: manifest.points ?? [], rejected: manifest.rejected ?? [] };
  } catch {
    return { points: [], rejected: [] };
  }
}

// manifest を組み直して書く。進行のたびに書き、長い取得が止まっても再開できる状態を保つ。
function saveManifest(points, rejected) {
  const manifest = {
    tool: 'cloud-detail-random-teacher',
    seed: SEED,
    layer: LAYER,
    size: SIZE,
    kmPerPx: TIERS_KM_PER_PX,
    minCovered: MIN_COVERED,
    generatedAt: new Date().toISOString(),
    points,
    rejected,
  };
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
}

// 動作確認で取る区分と点数。
const SMOKE_CATEGORIES = ['tropical-sea'];
const SMOKE_COUNT = 4;
const smoke = (process.env.npm_lifecycle_event ?? '').includes('smoke');

async function main() {
  mkdirSync(outDir, { recursive: true });
  const categoryNames = smoke ? SMOKE_CATEGORIES : CATEGORIES.map((category) => category.name);
  const count = smoke ? SMOKE_COUNT : POINTS_PER_CATEGORY;
  const categories = CATEGORIES
    .map((category, index) => ({ ...category, streamIndex: index }))
    .filter((category) => categoryNames.includes(category.name));

  const { points, rejected } = loadManifest();
  const pointByKey = new Map(points.map((point) => [`${point.category}|${point.slot}`, point]));
  const usedCandidates = new Map(CATEGORIES.map((category) => [category.name, new Set()]));
  for (const point of points) usedCandidates.get(point.category)?.add(point.candidateIndex);
  for (const entry of rejected) usedCandidates.get(entry.category)?.add(entry.candidateIndex);

  for (const category of categories) {
    const stream = candidateStream(category, category.streamIndex);
    const used = usedCandidates.get(category.name);
    // 系列からまだ使っていない候補を 1 つ引く。過去の実行で記録した候補は使い回さない。
    const nextCandidate = () => {
      for (;;) {
        const candidate = stream.next().value;
        if (!used.has(candidate.index)) {
          used.add(candidate.index);
          return candidate;
        }
      }
    };

    for (let slot = 1; slot <= count; slot++) {
      const key = `${category.name}|${slot}`;
      const existing = pointByKey.get(key);
      const files = TIERS_KM_PER_PX.map((kmPerPx) => path.join(outDir, pointFile(category.name, slot, kmPerPx)));
      if (existing?.status === 'ok' && files.every((file) => existsSync(file))) {
        console.log(`skip ${pointName(category.name, slot)}(既にある)`);
        continue;
      }
      // manifest の点が残って画像だけ欠けた(書き込み途中の中断)ものは、同じ点を取り直して
      // manifest の記録と揃える。
      if (existing?.status === 'ok' && !files.every((file) => existsSync(file))) {
        try {
          for (const [i, kmPerPx] of TIERS_KM_PER_PX.entries()) {
            const bytes = await fetchSnapshot(
              snapshotUrl(existing.latitude, existing.longitude, existing.date, kmPerPx),
              `${pointName(category.name, slot)}-${kmPerPx}km`);
            writeFileSync(files[i], bytes);
          }
          console.log(`refetched ${pointName(category.name, slot)}(manifest の点を取り直した)`);
        } catch (e) {
          console.log(`failed ${pointName(category.name, slot)}: 再取得できない(${e.message})`);
        }
        continue;
      }
      // 画像だけが残っている(manifest の無い既存)場合は取り直さず manifest へ採用する。
      if (existing === undefined && files.every((file) => existsSync(file))) {
        const covered = Object.fromEntries(TIERS_KM_PER_PX.map((kmPerPx, i) => [
          kmPerPx, coveredFraction(decodePng(readFileSync(files[i]))),
        ]));
        const point = {
          category: category.name, slot, candidateIndex: -1,
          latitude: null, longitude: null, date: null,
          status: 'ok', covered, fetchedAt: null,
          files: files.map((file) => path.posix.join('.cloud-detail', 'random-teacher', path.basename(file))),
        };
        points.push(point);
        pointByKey.set(key, point);
        saveManifest(points, rejected);
        console.log(`adopted ${pointName(category.name, slot)}(既存の画像を採用)`);
        continue;
      }

      let filled = false;
      for (let attempt = 0; attempt < MAX_TRIES_PER_SLOT && !filled; attempt++) {
        const candidate = nextCandidate();
        const name = pointName(category.name, slot);
        const bytes = [];
        const coveredMap = {};
        let rejectReason = null;
        for (const [i, kmPerPx] of TIERS_KM_PER_PX.entries()) {
          try {
            bytes[i] = await fetchSnapshot(
              snapshotUrl(candidate.latitude, candidate.longitude, candidate.date, kmPerPx), `${name}-${kmPerPx}km`);
          } catch (e) {
            rejectReason = `取得失敗: ${e.message}`;
            break;
          }
          const covered = coveredFraction(decodePng(Buffer.from(bytes[i])));
          coveredMap[kmPerPx] = covered;
          if (covered < MIN_COVERED) {
            rejectReason = `欠測(${kmPerPx} km/px の有効率 ${covered.toFixed(3)})`;
            break;
          }
        }
        if (rejectReason !== null) {
          rejected.push({
            category: category.name, slot, candidateIndex: candidate.index,
            latitude: candidate.latitude, longitude: candidate.longitude, date: candidate.date,
            reason: rejectReason,
          });
          console.log(`${rejectReason.startsWith('欠測') ? 'missing' : 'failed'} ${name}: ${rejectReason} — 次の候補へ`);
          continue;
        }
        files.forEach((file, i) => writeFileSync(file, bytes[i]));
        const point = {
          category: category.name, slot, candidateIndex: candidate.index,
          latitude: candidate.latitude, longitude: candidate.longitude, date: candidate.date,
          status: 'ok', covered: coveredMap, fetchedAt: new Date().toISOString(),
          files: files.map((file) => path.posix.join('.cloud-detail', 'random-teacher', path.basename(file))),
        };
        points.push(point);
        pointByKey.set(key, point);
        filled = true;
        console.log(`fetched ${name}(${candidate.latitude.toFixed(2)}°, ${candidate.longitude.toFixed(2)}°, ${candidate.date})`);
      }
      if (!filled) {
        console.log(`failed ${pointName(category.name, slot)}: ${MAX_TRIES_PER_SLOT} 候補すべて失敗`);
      }
      saveManifest(points, rejected);
    }
    const ok = points.filter((point) => point.category === category.name && point.status === 'ok').length;
    console.log(`${category.name}: ${ok}/${count} 点(棄却 ${rejected.filter((entry) => entry.category === category.name).length} 候補)`);
  }
  saveManifest(points, rejected);
  const ok = points.filter((point) => point.status === 'ok').length;
  console.log(`計 ${ok} 点・棄却 ${rejected.length} 候補 — manifest.json へ書いた`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
