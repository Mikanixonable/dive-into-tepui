// 半透明教師のプローブ。GIBS の層とカラーマップの解決を確かめ、scenes.json の
// 手付き窓 3 つ(anvil / scaly / veil)で真色・COT・CTH・位相を取って復号し、
// 分位と半透明の割合を出す。anvil の窓では静止衛星の帯 13 を通過時刻と 1 時間前に
// 取り、冷たさの場の最良シフトで移流(風)の推定を確かめる。
// 使い方: node tools/cloud-translucent-probe.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { encodeGrayPng } from './png.mjs';
import { quantize } from './gray-image.mjs';
import { coldnessField } from './cloud-brightness-temperature.mjs';
import {
  OUT_DIR, LAYERS, fetchWmsPng, resolveColormapName, fetchColormapXml,
  parseColormap, colormapSummary, decodeLayer, boxAround, geosatFor,
  overpassUtcMillis, downsampleField, bestShift, loadLoopConfig, fetchGeoFrame,
} from './cloud-translucent-gibs.mjs';

const probeDir = path.join(OUT_DIR, 'probe');
const SIZE = 512;

// 手付き窓(scenes.json と同じ中心・日付・衛星)。
const PROBE_WINDOWS = [
  { name: 'anvil', lat: 0, lon: 115, date: '2024-01-18', sensor: 'Terra' },
  { name: 'scaly', lat: -50, lon: 80, date: '2023-07-18', sensor: 'Terra' },
  { name: 'veil', lat: -3, lon: 80, date: '2023-12-12', sensor: 'Terra' },
];

// 帯 13 の移流推定に使う箱の km/px と縮率。4 km/px の 512² = 2048 km を 4 倍縮めて
// 16 km/px でシフトを探す(上限 8 px = 128 km/h で 30 m/s を超える)。
const IR_KM_PER_PX = 4;
const IR_DOWNSAMPLE = 4;
const IR_MAX_SHIFT_PX = 8;

let failures = 0;
const judge = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(40)}  ${detail}`);
};

// NaN を除いた値の {p10,p50,p90,min,max,valid}。
function stats(data) {
  const values = [];
  for (const v of data) if (Number.isFinite(v)) values.push(v);
  const sorted = values.sort((a, b) => a - b);
  const at = (f) => (sorted.length === 0 ? null : sorted[Math.floor(sorted.length * f)]);
  return {
    n: sorted.length,
    valid: sorted.length / data.length,
    min: sorted[0] ?? null,
    p10: at(0.1),
    p50: at(0.5),
    p90: at(0.9),
    max: sorted.at(-1) ?? null,
  };
}

// 値の場を範囲で 0..1 へ写してグレー PNG へ。
function writeFieldPng(file, field, lo, hi) {
  const gray = new Uint8Array(field.data.length);
  for (let i = 0; i < field.data.length; i++) {
    gray[i] = Number.isFinite(field.data[i])
      ? quantize((field.data[i] - lo) / (hi - lo))
      : 0;
  }
  writeFileSync(file, encodeGrayPng(field.width, field.height, gray));
}

async function main() {
  mkdirSync(probeDir, { recursive: true });
  const config = loadLoopConfig();
  const windows = PROBE_WINDOWS.slice(0, config.probeWindows ?? PROBE_WINDOWS.length);
  const report = { tool: 'cloud-translucent-probe', generatedAt: new Date().toISOString(), layers: {}, windows: [], drift: null };

  console.log('=== カラーマップの解決 ===');
  const scalarLayers = Object.keys(LAYERS).filter((name) => ['scalar', 'category', 'ir'].includes(LAYERS[name].kind));
  for (const name of scalarLayers) {
    try {
      if (LAYERS[name].kind === 'ir') {
        report.layers[name] = { colormap: 'Clean_Longwave_Infrared_Window_Band', source: 'shared', available: true };
        console.log(`${name}: 帯 13 のカラーマップ(既存モジュールで解読)`);
        continue;
      }
      // spec のカラーマップを先に試し、取れなければ LegendURL/推測へ退く。
      let colormap = LAYERS[name].colormap ?? null;
      let source = colormap === null ? null : 'spec';
      let xml = null;
      if (colormap !== null) {
        try {
          xml = await fetchColormapXml(colormap);
        } catch {
          colormap = null;
        }
      }
      if (colormap === null) {
        const resolution = await resolveColormapName(name);
        colormap = resolution.name;
        source = resolution.source;
        if (colormap === null) {
          if (LAYERS[name].optional) {
            console.log(`SKIP  colormap ${name} — 解決できない(任意の層)`);
            report.layers[name] = { colormap: null, available: false, optional: true, tried: resolution.tried };
            continue;
          }
          judge(false, `colormap ${name}`, '解決できない');
          report.layers[name] = { colormap: null, available: false };
          continue;
        }
      }
      const entries = parseColormap(xml ?? await fetchColormapXml(colormap));
      const summary = colormapSummary(entries);
      report.layers[name] = { colormap, source, available: true, ...summary };
      console.log(`${name}: ${colormap}(${source})— ${summary.bins} bins ${summary.lo}〜${summary.hi}・nodata ${JSON.stringify(summary.nodata)}`);
      judge(summary.bins > 0, `colormap ${name}`, `${summary.bins} bins`);
    } catch (e) {
      judge(false, `colormap ${name}`, e.message);
      report.layers[name] = { available: false, error: e.message };
    }
  }

  console.log('\n=== 窓の取得と復号 ===');
  for (const win of windows) {
    const box = boxAround(win.lat, win.lon, SIZE * 1);
    const box4 = boxAround(win.lat, win.lon, SIZE * 4);
    const entry = { ...win, layers: {}, coverage: geosatFor(win.lat, win.lon) };
    const targets = [
      { key: 'truecolor', layer: `MODIS_${win.sensor}_CorrectedReflectance_TrueColor`, box, size: SIZE, time: win.date },
      { key: 'cot', layer: `MODIS_${win.sensor}_Cloud_Optical_Thickness`, box, size: SIZE, time: win.date },
      { key: 'cth', layer: `MODIS_${win.sensor}_Cloud_Top_Height_Day`, box, size: SIZE, time: win.date },
      { key: 'phase', layer: `MODIS_${win.sensor}_Cloud_Phase_Optical_Properties`, box: box4, size: SIZE, time: win.date },
    ];
    for (const target of targets) {
      try {
        const { file, bytes } = await fetchWmsPng(target.layer, target.box, target.time, target.size, target.size);
        const decoded = await decodeLayer(target.layer, bytes);
        if (decoded.kind === 'rgb') {
          const { image } = decoded;
          let dark = 0;
          for (let i = 0; i < image.width * image.height; i++) {
            const o = i * image.channels;
            if (Math.max(image.data[o], image.data[o + 1], image.data[o + 2]) < 16) dark++;
          }
          const covered = 1 - dark / (image.width * image.height);
          entry.layers[target.key] = { file, covered };
          console.log(`${win.name}/${target.key}: 有効率 ${covered.toFixed(3)}`);
          writeFileSync(path.join(probeDir, `${win.name}-truecolor.png`), bytes);
        } else {
          const s = stats(decoded.field.data);
          entry.layers[target.key] = { file, stats: s, colormap: decoded.colormap, categories: decoded.categories };
          console.log(`${win.name}/${target.key}: p10 ${s.p10?.toFixed(1)} p50 ${s.p50?.toFixed(1)} p90 ${s.p90?.toFixed(1)}`
            + ` 有効率 ${s.valid.toFixed(3)}`);
          if (target.key === 'cot') writeFieldPng(path.join(probeDir, `${win.name}-cot.png`), decoded.field, 0, 50);
          if (target.key === 'cth') writeFieldPng(path.join(probeDir, `${win.name}-cth.png`), decoded.field, 0, 15000);
          if (target.key === 'phase') {
            const hist = {};
            for (const v of decoded.field.data) {
              if (Number.isFinite(v)) hist[v] = (hist[v] ?? 0) + 1;
            }
            const total = Object.values(hist).reduce((a, b) => a + b, 0);
            entry.layers.phase.histogram = Object.fromEntries(
              Object.entries(hist).map(([k, v]) => [k, v / total]));
            console.log(`${win.name}/phase: ${JSON.stringify(entry.layers.phase.histogram)}`);
          }
        }
      } catch (e) {
        judge(false, `${win.name}/${target.key}`, e.message);
        entry.layers[target.key] = { error: e.message };
      }
    }
    // 半透明・高層雲の割合(CTH > 6500 m かつ 0.3 <= COT < 23)。取り直しはキャッシュが効く。
    try {
      const cotField = (await decodeLayer(targets[1].layer, (await fetchWmsPng(targets[1].layer, box, win.date, SIZE, SIZE)).bytes)).field;
      const cthField = (await decodeLayer(targets[2].layer, (await fetchWmsPng(targets[2].layer, box, win.date, SIZE, SIZE)).bytes)).field;
      let translucent = 0;
      let valid = 0;
      for (let i = 0; i < cotField.data.length; i++) {
        if (!Number.isFinite(cotField.data[i]) || !Number.isFinite(cthField.data[i])) continue;
        valid++;
        if (cthField.data[i] > 6500 && cotField.data[i] >= 0.3 && cotField.data[i] < 23) translucent++;
      }
      entry.translucentShare = valid > 0 ? translucent / valid : 0;
      console.log(`${win.name}: 半透明高層雲 ${(entry.translucentShare * 100).toFixed(1)}%`);
    } catch (e) {
      entry.translucentShare = null;
      console.log(`${win.name}: 半透明の割合を出せない(${e.message})`);
    }
    report.windows.push(entry);
  }

  console.log('\n=== 帯 13 の移流の推定(anvil の位置・直近の日付) ===');
  // 静止衛星は直近しか残らないので、anvil の位置で採取期間の真ん中の日付を使う。
  const anvil = windows.find((w) => w.name === 'anvil') ?? windows[0];
  const driftDate = new Date(
    Date.parse(`${config.dateStart}T00:00:00Z`) + Math.floor(config.dateDays / 2) * 86400e3,
  ).toISOString().slice(0, 10);
  try {
    const { satellite, covered, distanceDeg } = geosatFor(anvil.lat, anvil.lon);
    judge(covered, `円盤内(${anvil.name})`, `${satellite.name} 直下点距離 ${distanceDeg.toFixed(1)}°`);
    const t0 = overpassUtcMillis(driftDate, anvil.lon, 'Aqua');
    const box = boxAround(anvil.lat, anvil.lon, SIZE * IR_KM_PER_PX);
    const frames = [];
    for (const offsetH of [0, -1]) {
      const fetched = await fetchGeoFrame(satellite.ir, box, t0 + offsetH * 3600e3, SIZE, SIZE);
      if (fetched.blank) throw new Error(`${fetched.time} 付近の帯 13 が全部真っ黒`);
      const decoded = await decodeLayer(satellite.ir, fetched.bytes);
      frames.push({ time: fetched.time, cold: downsampleField(coldnessField(decoded.field), IR_DOWNSAMPLE) });
      const s = stats(decoded.field.data);
      console.log(`${satellite.name} ${fetched.time}: BT p10 ${s.p10?.toFixed(1)}℃ p50 ${s.p50?.toFixed(1)}℃ p90 ${s.p90?.toFixed(1)}℃ 有効率 ${s.valid.toFixed(3)}`);
    }
    const shift = bestShift(frames[0].cold, frames[1].cold, IR_MAX_SHIFT_PX);
    const dtH = (Date.parse(frames[0].time) - Date.parse(frames[1].time)) / 3600e3;
    const kmPerHour = (IR_KM_PER_PX * IR_DOWNSAMPLE) / dtH;
    const drift = {
      dxKm: shift.dx * kmPerHour, dyKm: shift.dy * kmPerHour, score: shift.score,
      eastMs: (shift.dx * kmPerHour * 1000) / 3600, southMs: (shift.dy * kmPerHour * 1000) / 3600,
    };
    report.drift = { window: anvil.name, satellite: satellite.name, date: driftDate, ...drift };
    console.log(`ドリフト: 東 ${drift.eastMs.toFixed(1)} m/s・南 ${drift.southMs.toFixed(1)} m/s(相関 ${shift.score.toFixed(2)})`);
    judge(shift.score > 0.3, '移流の推定', `相関 ${shift.score.toFixed(2)}`);
  } catch (e) {
    judge(false, '移流の推定', e.message);
  }

  writeFileSync(path.join(probeDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  const layerOk = Object.values(report.layers).filter((l) => l.available !== false).length;
  console.log(`\n層の復号: ${layerOk}/${Object.keys(LAYERS).length} 種`);
  console.log(failures === 0 ? 'PASS — すべて通った' : `${failures} 件の失敗`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
