// 雲の細部の計測ループの正解として、海の上の場面の真色スナップショットを NASA Worldview から
// .cloud-detail/reference/ へ取り込み、場面と各段の manifest.json を書く。場面の目録は
// tools/cloud-detail/scenes.json。各場面を km/px の段(既定 0.25・1・4)ごとに正方形で取る。
// 既にある画像は取り直さない。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(root, '.cloud-detail', 'reference');
const scenes = JSON.parse(readFileSync(path.join(import.meta.dirname, 'cloud-detail', 'scenes.json'), 'utf8'));

// 緯度経度 1° の長さ [km]。km/px の指定は公称値なので、BBOX の換算も近似値で足りる。
const KM_PER_DEGREE = 111.32;
// スナップショットの 1 辺の画素数の既定。段ごとの size で小さくできる — 4 km/px で 1024² だと
// 一辺 4096 km になり、観測幅(約 2330 km)を超えて端が欠けたり陸が入ったりする場面で縮める。
const SNAPSHOT_SIZE = 1024;

// Worldview Snapshots API の URL。BBOX の並びは south,west,north,east。
// 段ごとに center・size・date を上書きできる — 観測幅の欠けや陸を避けるためにその段だけ
// 箱をずらしたり縮めたりする。
function snapshotUrl(scene, tier) {
  const center = tier.center ?? scene.center;
  const size = tier.size ?? SNAPSHOT_SIZE;
  const date = tier.date ?? scene.date;
  const halfKm = (tier.kmPerPx * size) / 2;
  const halfLatitude = halfKm / KM_PER_DEGREE;
  const halfLongitude = halfKm / (KM_PER_DEGREE * Math.cos((center.latitude * Math.PI) / 180));
  const bbox = {
    south: center.latitude - halfLatitude,
    west: center.longitude - halfLongitude,
    north: center.latitude + halfLatitude,
    east: center.longitude + halfLongitude,
  };
  return 'https://wvs.earthdata.nasa.gov/api/v1/snapshot?REQUEST=GetSnapshot'
    + `&TIME=${date}T00:00:00Z&BBOX=${bbox.south},${bbox.west},${bbox.north},${bbox.east}`
    + `&CRS=EPSG:4326&LAYERS=${scene.layer}&WRAP=day&FORMAT=image/png`
    + `&WIDTH=${size}&HEIGHT=${size}`;
}

// 1 枚の取得。回線の瞬断では失敗しないよう、失敗したら 3 回まで取り直す。
async function fetchSnapshot(url, file) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) {
        throw new Error(`PNG でない応答(先頭: ${Buffer.from(bytes.subarray(0, 120)).toString('utf8')})`);
      }
      return bytes;
    } catch (e) {
      lastError = e;
      console.log(`${file}: 取得に失敗(${e.message}) — ${attempt}/3 回目、取り直す`);
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
  throw new Error(`${file}: 3 回取り直しても取得できない(${url}): ${lastError.message}`);
}

// 以前の manifest に残る段の取得日時を引き継ぐ。取り直していない画像の取得日時を毎回の実行時刻で
// 上書きしないため。
function previousFetchedAt() {
  const manifestFile = path.join(outDir, 'manifest.json');
  if (!existsSync(manifestFile)) return new Map();
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  const fetchedAt = new Map();
  for (const scene of manifest.scenes ?? []) {
    for (const tier of scene.tiers ?? []) {
      fetchedAt.set(tier.file, tier.fetchedAt);
    }
  }
  return fetchedAt;
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const previous = previousFetchedAt();
  const entries = [];
  for (const scene of scenes) {
    const tiers = [];
    for (const tier of scene.tiers) {
      const size = tier.size ?? SNAPSHOT_SIZE;
      // file はリポジトリ相対。
      const file = path.posix.join('.cloud-detail', 'reference', `${scene.name}-${tier.kmPerPx}.png`);
      const target = path.join(root, file);
      let bytes;
      let fetchedAt;
      if (existsSync(target)) {
        bytes = new Uint8Array(readFileSync(target));
        fetchedAt = previous.get(file) ?? new Date().toISOString();
        console.log(`skip ${file}(既にある)`);
      } else {
        bytes = await fetchSnapshot(snapshotUrl(scene, tier), file);
        fetchedAt = new Date().toISOString();
        writeFileSync(target, bytes);
        console.log(`fetched ${file}`);
      }
      tiers.push({
        kmPerPx: tier.kmPerPx,
        size,
        date: tier.date ?? scene.date,
        center: tier.center ?? scene.center,
        file,
        fetchedAt,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    }
    entries.push({
      name: scene.name,
      kind: scene.kind,
      surface: scene.surface ?? 'sea',
      category: scene.category,
      date: scene.date,
      layer: scene.layer,
      center: scene.center,
      tiers,
    });
  }
  const manifest = { tool: 'cloud-detail-reference', scenes: entries };
  writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote ${path.posix.join('.cloud-detail', 'reference', 'manifest.json')}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
