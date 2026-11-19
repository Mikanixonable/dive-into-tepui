// 撮影と実写を 1 枚に並べたモンタージュを書く。撮影名ごとに、A の撮影、(B があれば)B の撮影、
// 実写の参照を中心から 512×512 で切り出して横に並べ、<out>/<撮影名>.png へ書く。
// 参照は A の manifest が持つ scene・tierKmPerPx から .cloud-detail/reference/<scene>-<km/px>.png を引く。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, encodeRgbPng } from './png.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const detailDir = path.join(root, '.cloud-detail');
const TILE = 512;

// <dir>/manifest.json の shots を、撮影名で引ける map へ。
function loadManifest(dir) {
  const file = path.join(dir, 'manifest.json');
  if (!existsSync(file)) return null;
  const shots = JSON.parse(readFileSync(file, 'utf8')).shots;
  return new Map(shots.map((shot) => [shot.name, shot]));
}

// PNG の decode 結果から中心の size×size を切り出し、先頭 3 byte を RGB として取り出す。
// 並べる元は同じ km/px どうしなので拡縮しない。
function centerTileRgb(png, size) {
  const x0 = Math.floor((png.width - size) / 2);
  const y0 = Math.floor((png.height - size) / 2);
  if (x0 < 0 || y0 < 0) throw new Error(`${png.width}×${png.height} は ${size}×${size} より小さい`);
  const out = new Uint8Array(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const src = ((y + y0) * png.width + (x + x0)) * png.channels;
      const dst = (y * size + x) * 3;
      out[dst] = png.data[src];
      out[dst + 1] = png.data[Math.min(src + 1, src + png.channels - 1)];
      out[dst + 2] = png.data[Math.min(src + 2, src + png.channels - 1)];
    }
  }
  return out;
}

// 512×512 の RGB タイルの列を、横に並べた 1 枚の RGB へ。
function joinTilesRgb(tiles, size) {
  const out = new Uint8Array(tiles.length * size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let i = 0; i < tiles.length; i++) {
      const src = tiles[i].subarray(y * size * 3, (y + 1) * size * 3);
      out.set(src, (y * tiles.length * size + i * size) * 3);
    }
  }
  return { width: tiles.length * size, height: size, data: out };
}

function main() {
  const args = process.argv.slice(2);
  const options = { aDir: path.join(detailDir, 'shots'), outDir: path.join(detailDir, 'montage'), bDir: null };
  const names = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--a') options.aDir = path.resolve(args[++i]);
    else if (args[i] === '--b') options.bDir = path.resolve(args[++i]);
    else if (args[i] === '--out') options.outDir = path.resolve(args[++i]);
    else names.push(args[i]);
  }
  if (names.length === 0) {
    console.error('使い方: node tools/cloud-detail-montage.mjs [--a <dir>] [--b <dir>] [--out <dir>] <撮影名>...');
    process.exit(1);
  }
  const manifestA = loadManifest(options.aDir);
  if (manifestA === null) console.error(`${path.join(options.aDir, 'manifest.json')} が無い`);

  mkdirSync(options.outDir, { recursive: true });
  let written = 0;
  for (const name of names) {
    const info = manifestA?.get(name);
    const shotAFile = path.join(options.aDir, `${name}.png`);
    const shotBFile = options.bDir === null ? null : path.join(options.bDir, `${name}.png`);
    const referenceFile = info === undefined || info === null ? null
      : path.join(detailDir, 'reference', `${info.scene}-${info.tierKmPerPx}.png`);
    const missing = [
      info === undefined || info === null ? `${name} が ${options.aDir} の manifest に無い` : null,
      !existsSync(shotAFile) ? `${shotAFile} が無い` : null,
      shotBFile !== null && !existsSync(shotBFile) ? `${shotBFile} が無い` : null,
      referenceFile !== null && !existsSync(referenceFile) ? `${referenceFile} が無い` : null,
    ].filter((message) => message !== null);
    if (missing.length > 0) {
      console.error(`${name}: ${missing.join(' / ')} — 飛ばす`);
      continue;
    }
    const tiles = [shotAFile, shotBFile, referenceFile]
      .filter((file) => file !== null)
      .map((file) => centerTileRgb(decodePng(readFileSync(file)), TILE));
    const montage = joinTilesRgb(tiles, TILE);
    writeFileSync(path.join(options.outDir, `${name}.png`), encodeRgbPng(montage.width, montage.height, montage.data));
    written++;
  }
  console.log(`モンタージュ ${written} 枚を ${options.outDir} へ書いた`);
}

main();
