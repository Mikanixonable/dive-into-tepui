// 巻雲基盤改訂の教師側の材料を揃える: 帯 13 カラーマップの取得と検証、既存の微細参照
// (reference-fine)の帯 13 フレーム全てについて輝度温度の分布を測って記録する。
// 閾値 -30 ℃ の根拠(フレームごとの分位点と閾値ごとの面積率)をマニフェストへ残すのが
// 目的で、特徴量そのものは比較(cloud-lab:compare)がカラーマップからその場で復元する。
//
// 実行: npm run cloud-lab:reference-cirrus

import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng } from './png.mjs';
import {
  COLORMAP_URL,
  HIGH_CLOUD_SATURATION_C,
  HIGH_CLOUD_THRESHOLD_C,
  invertBrightnessTemperature,
  parseBand13Colormap,
  validateBand13Colormap,
} from './cloud-brightness-temperature.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, '.cloud-lab', 'reference-cirrus');
const fineDir = path.join(root, '.cloud-lab', 'reference-fine');
const THRESHOLDS_C = [-20, -25, HIGH_CLOUD_THRESHOLD_C, -40, -50, HIGH_CLOUD_SATURATION_C];

function quantile(sorted, f) {
  return sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))];
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const response = await fetch(COLORMAP_URL);
  if (!response.ok) throw new Error(`カラーマップの取得に失敗: HTTP ${response.status}`);
  const xml = await response.text();
  const entries = parseBand13Colormap(xml);
  const colormap = validateBand13Colormap(entries);
  const colormapPath = path.join(outDir, 'colormap.xml');
  writeFileSync(colormapPath, xml);
  console.log(
    `カラーマップ: ${colormap.count} 色、${colormap.minC}..${colormap.maxC} ℃、sha256 ${colormap.sha256.slice(0, 12)}…`,
  );

  const fineManifestPath = path.join(fineDir, 'manifest.json');
  if (!existsSync(fineManifestPath)) {
    throw new Error('reference-fine のマニフェストが無い。先に cloud-lab:reference-fine を実行すること');
  }
  const fineManifest = JSON.parse(readFileSync(fineManifestPath, 'utf8'));
  const band13Frames = fineManifest.frames.filter((f) => f.suffix === 'band13');
  if (band13Frames.length === 0) throw new Error('reference-fine に帯 13 フレームが無い');

  const frames = [];
  for (const frame of band13Frames) {
    const image = decodePng(readFileSync(path.join(root, frame.file)));
    const inverted = invertBrightnessTemperature(image, entries);
    const values = [];
    for (const v of inverted.data) if (!Number.isNaN(v)) values.push(v);
    values.sort((a, b) => a - b);
    const fractionAtMost = (t) => {
      let n = 0;
      for (const v of values) if (v <= t) n++;
      return n / values.length;
    };
    const record = {
      region: frame.region,
      ladder: frame.ladder,
      file: path.basename(frame.file),
      box: frame.box,
      stats: inverted.stats,
      quantilesC: {
        q05: quantile(values, 0.05),
        q25: quantile(values, 0.25),
        q50: quantile(values, 0.5),
        q75: quantile(values, 0.75),
        q95: quantile(values, 0.95),
      },
      fractionAtMostC: Object.fromEntries(THRESHOLDS_C.map((t) => [String(t), fractionAtMost(t)])),
      highCloudFraction: fractionAtMost(HIGH_CLOUD_THRESHOLD_C),
    };
    frames.push(record);
    console.log(
      `${frame.region} ${frame.ladder}: 中央値 ${record.quantilesC.q50.toFixed(0)} ℃、` +
        `高層雲(≦${HIGH_CLOUD_THRESHOLD_C} ℃) ${(record.highCloudFraction * 100).toFixed(1)}%、` +
        `冷グレー ${(inverted.stats.coldGrayFraction * 100).toFixed(2)}%、完全一致 ${(inverted.stats.exactFraction * 100).toFixed(0)}%`,
    );
  }

  const manifest = {
    tool: 'cloud-lab-reference-cirrus',
    generatedAt: new Date().toISOString(),
    gitHead: process.env.GIT_HEAD ?? null,
    colormap: { url: COLORMAP_URL, file: 'colormap.xml', ...colormap },
    threshold: {
      highCloudC: HIGH_CLOUD_THRESHOLD_C,
      saturationC: HIGH_CLOUD_SATURATION_C,
      basis:
        '帯 13 フレーム実測分布で暖かい峰(海面と下層・中層雲)と冷たい尾(対流圏上部の雲頂)の境目にあたり、' +
        '生成側の半透明殻(巻雲層)が表す対流圏上部の層に対応する固定閾値。冷たさは飽和温度まで線形に正規化する。',
    },
    frames,
  };
  writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`記録: ${frames.length} フレーム → .cloud-lab/reference-cirrus/manifest.json`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
