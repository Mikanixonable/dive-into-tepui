// assets-src/moon-features.json(海・クレーターの中心緯度経度と直径、出典 Wikipedia の月の海/
// クレーター一覧)を、src/render/moon-surface-markings.ts が読む円ループの配列(単位球面上の
// xyz 頂点列)へ落とす。海・クレーターとも円で近似する(元データが直径1つしか持たないため)。
//
// 実行: node tools/export-moon-features.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSourceModules } from './compile-source.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = join(repoRoot, 'assets-src', 'moon-features.json');
const outPath = join(repoRoot, 'src', 'assets', 'moon-features.json');

// 1円ぶんの分割数。CIRCLE_SEGMENTS(body-graticule.ts)と同じ滑らかさに揃える。
const CIRCLE_SEGMENTS = 128;

const { constants, dispose } = loadSourceModules(['game/celestial/solar-system/constants']);
const R_MOON = constants.R_MOON;
dispose();

// 緯度・経度[deg]から単位球面上の点を返す(body-graticule.ts の latLonPoint(ratio=1) と同じ規約:
// +Y が自転軸、+Z が本初子午線)。
function latLonPoint(latDeg, lonDeg) {
  const latRad = (latDeg * Math.PI) / 180;
  const lonRad = (lonDeg * Math.PI) / 180;
  const c = Math.cos(latRad);
  return [c * Math.sin(lonRad), Math.sin(latRad), c * Math.cos(lonRad)];
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function normalize(v) {
  const len = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / len, v[1] / len, v[2] / len];
}

// 中心 center(単位ベクトル)から角半径 thetaRad の小円(球面上の真円)を、球面座標の歪みを
// 受けずに周方向へ等間隔な点列として返す。
function smallCircle(center, thetaRad) {
  // center に平行でない適当な軸との外積で接ベクトルを2本作る。
  const helper = Math.abs(center[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = normalize(cross(helper, center));
  const v = cross(center, u);
  const cosT = Math.cos(thetaRad);
  const sinT = Math.sin(thetaRad);
  const points = [];
  for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
    const t = (2 * Math.PI * i) / CIRCLE_SEGMENTS;
    const cosPhi = Math.cos(t);
    const sinPhi = Math.sin(t);
    points.push([
      cosT * center[0] + sinT * (cosPhi * u[0] + sinPhi * v[0]),
      cosT * center[1] + sinT * (cosPhi * u[1] + sinPhi * v[1]),
      cosT * center[2] + sinT * (cosPhi * u[2] + sinPhi * v[2]),
    ]);
  }
  return points;
}

const source = JSON.parse(readFileSync(sourcePath, 'utf8'));
const loops = [];
for (const feature of [...source.maria, ...source.craters]) {
  const center = latLonPoint(feature.latDeg, feature.lonDeg);
  const thetaRad = (feature.diameterKm * 1000) / 2 / R_MOON;
  loops.push(smallCircle(center, thetaRad));
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(loops));
console.log(`wrote ${outPath} (${loops.length} loops, ${loops.reduce((n, l) => n + l.length, 0)} points)`);
