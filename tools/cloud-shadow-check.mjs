// 雲の影の評価。自己完結で、webpack の本番ビルド(.render-lab)から始め、headless Chrome で
// 同じ視点・時刻の「雲+影」「雲のみ・影なし」「雲なし」の 3 枚と、影パスの透過率マップ
// (デバッグ表示)を撮り、雲が視線を遮らない画素だけで影を測る。
//   (a) 暗化の強さ — 影オン画素の輝度比(線形)の分布
//   (b) ずれ      — 雲の影の地図と雲の覆いの相関が、太陽と反対向きへずらした位置で最大になるか
//   (c) 鋭さ      — 雲の影の縁の勾配が、雲の覆いの縁の勾配に対してどのくらいあるか
// 使い方: node tools/cloud-shadow-check.mjs  — 引数は無し。動作の切り替えは
// 作業ツリー直下の .loop-shadow-config.json(任意)で行う:
//   { "tag": "base",          // 出力先 .cloud-detail/shadow/<tag>/ の名前
//     "build": true,          // false なら webpack を飛ばして既存の .render-lab/ を使う
//     "measure": false,       // true なら代表視点で renderLab.measure も呼び「雲影」ms を出す
//     "views": ["sea-1km-z30"] } // 測る視点の絞り込み(名前の部分一致。既定は全部)
// 出力は標準出力の一覧表と .cloud-detail/shadow/<tag>/ 以下の撮影・地図・metrics.json・summary.json。
import path from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { openChromeSession, sleep, waitFor, collectFatalEvents } from './chrome-session.mjs';
import { decodePng, encodeRgbPng } from './png.mjs';

const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, '.render-lab');
// 他の計測(render-lab-shot 8767/9444、render-lab-measure 8769/9446)と衝突しない固定ポート。
const PORT = 8775;
const DEBUG_PORT = 9454;

// 設定ファイル(任意)。無ければ全部を既定で測る。
const configPath = path.join(root, '.loop-shadow-config.json');
const config = existsSync(configPath)
  ? JSON.parse(readFileSync(configPath, 'utf8'))
  : {};
const tag = config.tag ?? 'base';
const outRoot = path.join(root, '.cloud-detail', 'shadow', tag);

// 画面の大きさと画角(tools/render-lab/lab-case.ts の VIEW_*・FOV_DEG)。
const H = 540;
const FOV_TAN = Math.tan((50 / 2) * Math.PI / 180);
// 直下点での 1 px の実寸 [m]。カメラ(描画原点)から地表までの距離 = 高度。
const mppOf = (altitudeM) => (2 * altitudeM * FOV_TAN) / H;
// 1 px の実寸 [m] から直下の高度 [m] を逆算する。
const altitudeForMpp = (mpp) => (mpp * H) / (2 * FOV_TAN);

// 直下の撮影。lat・lon は描画原点の真下に来る地点(海はギニア湾、陸はコンゴ盆地)。
// zenithDeg は恒星の天頂角。方位 0 に置くと恒星は直下点の描画座標 +Y 側へ傾き、
// 影は画面の下へ落ちる。
const nadir = (name, lat, lon, mpp, zenithDeg) => ({
  name, lat, lon, altitude: altitudeForMpp(mpp), zenithDeg,
  view: {
    earthAzimuthDeg: 180, earthElevationDeg: 0,
    earthAltitudeLog: Math.log10(altitudeForMpp(mpp)),
    earthLatitudeDeg: lat, earthLongitudeDeg: lon,
    // sunElevationDeg は地平線からの仰角 — 天頂角はその余角。
    sunAzimuthDeg: 0, sunElevationDeg: 90 - zenithDeg,
  },
  // 相関を探すずれの窓(画面 px)。+dy は下向き(影の落ちる向き)。
  scan: { dx: [-40, 40], dy: [-40, 40] },
  downsample: mpp >= 1000 ? 1 : 2,
});

const VIEWS = [
  nadir('sea-1km-z10', 0, 0, 1000, 10),
  nadir('sea-1km-z30', 0, 0, 1000, 30),
  nadir('sea-1km-z60', 0, 0, 1000, 60),
  nadir('sea-1km-z75', 0, 0, 1000, 75),
  nadir('sea-1km-z85', 0, 0, 1000, 85),
  nadir('sea-025-z30', 0, 0, 250, 30),
  nadir('sea-025-z60', 0, 0, 250, 60),
  nadir('land-1km-z30', 0, 20, 1000, 30),
  nadir('land-025-z30', 0, 20, 250, 30),
  {
    name: 'oblique', lat: 41.68, lon: 0, altitude: 420e3, zenithDeg: 30,
    // 斜視: render-lab の earth-oblique の置き方(地平線を視線より上げる)。
    view: {
      earthAzimuthDeg: 180, earthElevationDeg: -41.68,
      earthAltitudeLog: Math.log10(420e3),
      earthLatitudeDeg: 41.68, earthLongitudeDeg: 0,
      sunAzimuthDeg: 0, sunElevationDeg: 60,
    },
    scan: { dx: [-30, 30], dy: [-30, 30] },
    downsample: 2,
  },
];

// 評価で固定する描画品質設定(高プリセットの雲まわり)。config.graphics で上書きできる —
// 特に atmosphere: 0 は、雲の覆いの判定から大気の散乱の差を除く切り分けに使う。
const GRAPHICS = [
  ['clouds', true], ['cloudFieldSource', 'generated'], ['cirrus', true],
  ['cumulusDetail', 2], ['cirrusDetail', 1], ['cloudShadow', true],
  ['atmosphere', 3], ['sunLightModel', 1],
  ...Object.entries(config.graphics ?? {}),
];
// GRAPHICS に書いた大気の段。覆いの判定で大気を 0 へ切ったあと、本番の値へ戻すために使う。
const configuredAtmosphere = GRAPHICS.filter(([key]) => key === 'atmosphere').at(-1)[1];

// webpack の本番ビルド。npm run render-lab:shot などと同じ入口を子プロセスで直に起動する。
function buildRenderLab() {
  const cli = path.join(root, 'node_modules', 'webpack-cli', 'bin', 'cli.js');
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [cli, '--config', 'webpack.render-lab.config.js', '--mode', 'production'],
      { cwd: root, stdio: 'inherit' },
    );
    child.on('exit', (code) => (
      code === 0 ? resolve() : reject(new Error(`webpack exited with code ${code}`))
    ));
    child.on('error', reject);
  });
}

// 絵が落ち着くまで撮り直す(連続 2 回の一致で判定)。雲場の焼き込みやパイプラインの
// 組み直しが間に合うまでの過渡を読まないため。
async function captureSettled(evaluate, label) {
  let previous = await evaluate('window.renderLab.capture()');
  for (let count = 0; count < 6; count++) {
    await sleep(150);
    const next = await evaluate('window.renderLab.capture()');
    if (next === previous) return next;
    previous = next;
  }
  throw new Error(`${label}: capture did not settle`);
}

const dataUrlToPng = (url) => Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');

// sRGB 8bit → 線形輝度。比(率)を測るときだけ使う。
const lin = (v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

// RGBA/RGB 画素列から線形輝度の Float32Array。
function luminanceMap(png) {
  const { width, height, channels, data } = png;
  const map = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const o = i * channels;
    map[i] = lin(data[o]) * 0.2126 + lin(data[o + 1]) * 0.7152 + lin(data[o + 2]) * 0.0722;
  }
  return map;
}

// 2 枚の絵が RGB 各チャンネルで thresholdLsb 以内の画素のマスク(1 = 一致 = 雲の遮蔽なし)。
function equalMask(aPng, bPng, thresholdLsb) {
  const { width, height, channels, data: a } = aPng;
  const { data: b } = bPng;
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const o = i * channels;
    const diff = Math.max(
      Math.abs(a[o] - b[o]), Math.abs(a[o + 1] - b[o + 1]), Math.abs(a[o + 2] - b[o + 2]),
    );
    mask[i] = diff <= thresholdLsb ? 1 : 0;
  }
  return mask;
}

// グレースケール Float32Array(0..1)を色付きの RGB 画素列へ。
function mapToRgb(map, w, h, color) {
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const v = Math.max(0, Math.min(1, map[i]));
    rgb[i * 3] = Math.round(v * 255 * color[0]);
    rgb[i * 3 + 1] = Math.round(v * 255 * color[1]);
    rgb[i * 3 + 2] = Math.round(v * 255 * color[2]);
  }
  return rgb;
}

// 地図を factor 倍間引く(箱平均)。マスクは過半数が有効な升目だけ有効。
function downsampleMap(map, w, h, factor, isMask) {
  const dw = Math.floor(w / factor);
  const dh = Math.floor(h / factor);
  const out = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      let sum = 0;
      for (let j = 0; j < factor; j++) {
        for (let i = 0; i < factor; i++) sum += map[(y * factor + j) * w + x * factor + i];
      }
      out[y * dw + x] = isMask ? (sum >= factor * factor / 2 ? 1 : 0) : sum / (factor * factor);
    }
  }
  return { map: out, w: dw, h: dh };
}

// 受け手側の地図 a(mask=1 の画素だけを使う)と、ずらす側の地図 b の、ずれ (dx,dy) での
// ピアソン相関。
function nccAt(a, mask, b, w, h, dx, dy) {
  let n = 0, sa = 0, saa = 0, sb = 0, sbb = 0, sab = 0;
  const x0 = Math.max(0, -dx), x1 = Math.min(w, w - dx);
  const y0 = Math.max(0, -dy), y1 = Math.min(h, h - dy);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * w + x;
      if (mask[i] === 0) continue;
      const av = a[i];
      const bv = b[(y + dy) * w + x + dx];
      n++; sa += av; saa += av * av; sb += bv; sbb += bv * bv; sab += av * bv;
    }
  }
  if (n < 32) return { r: 0, n };
  const va = n * saa - sa * sa;
  const vb = n * sbb - sb * sb;
  if (va <= 1e-9 || vb <= 1e-9) return { r: 0, n };
  return { r: (n * sab - sa * sb) / Math.sqrt(va * vb), n };
}

// scan 窓の全ずれで相関を走り、最大とずれ無しの値を返す。
function scanOffsets(a, mask, b, w, h, scan) {
  let best = { r: -1 };
  for (let dy = scan.dy[0]; dy <= scan.dy[1]; dy++) {
    for (let dx = scan.dx[0]; dx <= scan.dx[1]; dx++) {
      const { r, n } = nccAt(a, mask, b, w, h, dx, dy);
      if (r > best.r) best = { r, dx, dy, n };
    }
  }
  const zero = nccAt(a, mask, b, w, h, 0, 0);
  return { best, zero: zero.r };
}

// 地図の縁の鋭さ。各地図を自身の 98 点で正規化し、信号のある画素(自身の 98 点の 1 割以上)
// の勾配の 90 点の比を返す。信号の無い画素のノイズを混ぜないための下限を掛ける。
function edgeSharpness(a, b, w, h, mask) {
  const grads = (map) => {
    const sorted = [...map].sort((x, y) => x - y);
    const scale = Math.max(sorted[Math.floor(sorted.length * 0.98)], 1e-6);
    const floor = scale * 0.1;
    const list = [];
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (mask[i] === 0 || map[i] <= floor) continue;
        const g = Math.hypot((map[i + 1] - map[i - 1]) / (2 * scale), (map[i + w] - map[i - w]) / (2 * scale));
        if (g > 1e-4) list.push(g);
      }
    }
    list.sort((x, y) => x - y);
    return list[Math.floor(list.length * 0.9)] ?? 0;
  };
  const ga = grads(a), gb = grads(b);
  return { shadow: ga, cloud: gb, ratio: gb > 0 ? ga / gb : 0 };
}

// 各画素からいちばん近い「雲あり」画素までの向きを、距離変換(多始点 BFS)で求める。
// 開いた画素で影の強い所だけ集計し、雲が影のどちら側にあるかの分布を返す。
// bin は向きを 8 分割(bin0 = -x、bin2 = 画面上 = -y、bin4 = +x、bin6 = 画面下 = +y)。
function directionToCover(cover, mask, shadow, w, h, shadowThresh, coverThresh) {
  const src = new Int32Array(w * h).fill(-1);
  const q = [];
  for (let i = 0; i < w * h; i++) if (cover[i] >= coverThresh) { src[i] = i; q.push(i); }
  for (let qi = 0; qi < q.length; qi++) {
    const i = q[qi], x = i % w, y = (i / w) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (src[ni] !== -1) continue;
      src[ni] = src[i]; q.push(ni);
    }
  }
  const hist = new Array(8).fill(0);
  let n = 0, distSum = 0;
  for (let i = 0; i < w * h; i++) {
    if (mask[i] === 0 || shadow[i] < shadowThresh || src[i] < 0 || src[i] === i) continue;
    const dx = (src[i] % w) - (i % w), dy = ((src[i] / w) | 0) - ((i / w) | 0);
    const d = Math.hypot(dx, dy);
    const bin = Math.round(((Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI)) * 8) % 8;
    hist[bin] += shadow[i]; distSum += d; n++;
  }
  return { hist, n, meanDist: n ? distSum / n : 0 };
}

// 地図どうしの差分 a − b。
function subMap(a, b) {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] - b[i];
  return out;
}

// 分離フィルタの箱ぼかし(半径 r、端は切り詰め)。
function boxBlur(a, w, h, r) {
  if (r <= 0) return Float32Array.from(a);
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += a[y * w + Math.min(Math.max(x, 0), w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = acc / (2 * r + 1);
      const drop = Math.max(x - r, 0), add = Math.min(x + r + 1, w - 1);
      acc += a[y * w + add] - a[y * w + drop];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(Math.max(y, 0), h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / (2 * r + 1);
      const drop = Math.max(y - r, 0), add = Math.min(y + r + 1, h - 1);
      acc += tmp[add * w + x] - tmp[drop * w + x];
    }
  }
  return out;
}

// 勾配の大きさの地図。ずれの相関は、なだらかな強さの地図どうしより縁どうしのほうが鋭く立つ。
function gradientMap(a, w, h) {
  const g = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      g[i] = Math.hypot(a[i + 1] - a[i - 1], a[i + w] - a[i - w]) / 2;
    }
  }
  return g;
}

async function main() {
  if (config.build !== false || !existsSync(path.join(buildDir, 'index.html'))) {
    console.log('=== webpack --config webpack.render-lab.config.js --mode production ===');
    await buildRenderLab();
  }
  const { onEvent, fatalEvents } = collectFatalEvents();
  const session = await openChromeSession({
    serveDir: buildDir, port: PORT, debugPort: DEBUG_PORT,
    profilePrefix: 'tepui-cloud-shadow-', onEvent,
    requestTimeoutMs: 120_000,
  });
  const views = VIEWS.filter((v) => !config.views || config.views.some((o) => v.name.includes(o)));
  const summary = [];
  try {
    const { devTools } = session;
    await devTools.send('Page.navigate', { url: `${session.baseUrl}/` });
    await waitFor(devTools, 'typeof window.renderLab?.capture === "function"', 'renderLab API');
    for (const [key, value] of GRAPHICS) {
      await devTools.evaluate(
        `window.renderLab.setGraphicsOption(${JSON.stringify(key)}, ${JSON.stringify(value)})`);
    }
    console.log(`graphics: ${JSON.stringify(await devTools.evaluate('window.renderLab.graphicsSettings()'))}\n`);

    for (const view of views) {
      const dir = path.join(outRoot, view.name);
      mkdirSync(dir, { recursive: true });
      await devTools.evaluate(`window.renderLab.show('earth')`);
      await devTools.evaluate(`window.renderLab.setView(${JSON.stringify(view.view)})`);
      await devTools.evaluate('window.renderLab.setDisplayTime(0)');

      const setG = (key, value) => devTools.evaluate(
        `window.renderLab.setGraphicsOption(${JSON.stringify(key)}, ${JSON.stringify(value)})`);
      const evaluate = devTools.evaluate.bind(devTools);
      const shoot = (name) => captureSettled(evaluate, `${view.name} ${name}`);
      const shots = {};
      // 覆いの判定は大気を消した状態で撮る — 大気が雲のまわりへ散らす霞も「雲の覆い」と
      // 誤認するので、絵で切り分けると覆いが実際より大きくなる。ここでは影の本体の効き
      // (on-atmo0 vs off-atmo0)も一緒に測れる。
      await setG('atmosphere', 0);
      await setG('cloudShadow', false);
      shots['off-atmo0'] = await shoot('off-atmo0');
      await setG('cloudShadow', true);
      shots['on-atmo0'] = await shoot('on-atmo0');
      await setG('clouds', false);
      shots['clear-atmo0'] = await shoot('clear-atmo0');
      // 本番の大気設定で同じ 3 枚を撮る(見た目の暗化はこちらで測る)。
      await setG('atmosphere', configuredAtmosphere);
      await setG('clouds', true);
      shots['a-on'] = await shoot('a-on');
      await setG('cloudShadow', false);
      shots['b-off'] = await shoot('b-off');
      await setG('clouds', false);
      shots['c-clear'] = await shoot('c-clear');
      // 設定を戻し、影パスの透過率マップをオン/オフ両方で撮る(大気の設定は写らない)。
      await setG('clouds', true);
      await setG('cloudShadow', true);
      await shoot('restore');
      await devTools.evaluate(`window.renderLab.setTarget('shadow')`);
      shots['map-shadow'] = await shoot('map-shadow');
      await setG('cloudShadow', false);
      shots['map-shadow-base'] = await shoot('map-shadow-base');
      await devTools.evaluate(`window.renderLab.setTarget('off')`);
      await setG('cloudShadow', true);

      const pngs = {};
      for (const [name, url] of Object.entries(shots)) {
        const buf = dataUrlToPng(url);
        writeFileSync(path.join(dir, `${name}.png`), buf);
        pngs[name] = decodePng(buf);
      }

      const w = pngs['a-on'].width, h = pngs['a-on'].height;
      const lumA = luminanceMap(pngs['a-on']);
      const lumB = luminanceMap(pngs['b-off']);
      const lumOn0 = luminanceMap(pngs['on-atmo0']);
      const lumOff0 = luminanceMap(pngs['off-atmo0']);
      const lumClear0 = luminanceMap(pngs['clear-atmo0']);
      // 雲が視線を遮らない画素 = 大気を消した絵で、雲ありの絵が雲なしの絵と一致する所。
      const mask = equalMask(pngs['off-atmo0'], pngs['clear-atmo0'], 5);
      const shadowMap = luminanceMap(pngs['map-shadow']);
      const shadowBase = luminanceMap(pngs['map-shadow-base']);
      // 雲の影の成分: 影の全源と雲以外の源の差。乗算合成なので差が雲の減衰ぶんになる。
      const cloudShadowMap = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) cloudShadowMap[i] = Math.max(0, shadowBase[i] - shadowMap[i]);
      // 雲の覆い(大気を消した絵での不透明な雲の明るさ)。大気ありの差分は雲のまわりの霞を
      // 含んで縁が滲むので、影のずれを測る基準はこちらを使う。
      const cloudCover = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) {
        cloudCover[i] = Math.max(0, lumOff0[i] - lumClear0[i]);
      }

      // (a) 暗化の強さ。雲が遮らない画素で、影オン/オフの線形輝度比。本番の絵(on/off)と
      // 大気を消した絵(on-atmo0/off-atmo0 = 影パスだけの効き)の 2 組で測る。
      const darkeningOf = (onLum, offLum) => {
        const ratios = [];
        for (let i = 0; i < w * h; i++) {
          if (mask[i] === 0 || offLum[i] <= 0.02) continue;
          ratios.push(onLum[i] / offLum[i]);
        }
        ratios.sort((x, y) => x - y);
        const shadowed = ratios.filter((r) => r < 0.9);
        const dark = ratios.filter((r) => r < 0.6);
        return {
          shadowFrac: shadowed.length / Math.max(1, ratios.length),
          strongFrac: dark.length / Math.max(1, ratios.length),
          meanRatioShadowed: shadowed.length
            ? shadowed.reduce((s, r) => s + r, 0) / shadowed.length : 1,
          p10Ratio: ratios[Math.floor(ratios.length * 0.1)] ?? 1,
        };
      };
      const darkeningFinal = darkeningOf(lumA, lumB);
      const darkeningPure = darkeningOf(lumOn0, lumOff0);
      const diffsLsb = [];
      let openPx = 0;
      for (let i = 0; i < w * h; i++) {
        if (mask[i] === 0) continue;
        openPx++;
        diffsLsb.push(Math.abs(
          pngs['a-on'].data[i * 4] - pngs['b-off'].data[i * 4]
          + pngs['a-on'].data[i * 4 + 1] - pngs['b-off'].data[i * 4 + 1]
          + pngs['a-on'].data[i * 4 + 2] - pngs['b-off'].data[i * 4 + 2],
        ));
      }
      // 雲の影の地図の統計を、開いた画素・雲に遮られた画素・全体で分けて出す。開いた画素に
      // しか影が無い = 雲の下へしか影が落ちていない、という切り分けが要る。
      const region = (pred) => {
        const vals = [];
        for (let i = 0; i < w * h; i++) if (pred(mask[i])) vals.push(cloudShadowMap[i]);
        vals.sort((x, y) => x - y);
        return {
          n: vals.length,
          mean: vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0,
          p90: vals[Math.floor(vals.length * 0.9)] ?? 0,
          p99: vals[Math.floor(vals.length * 0.99)] ?? 0,
          max: vals[vals.length - 1] ?? 0,
          frac03: vals.filter((v) => v > 0.3).length / Math.max(1, vals.length),
          frac07: vals.filter((v) => v > 0.7).length / Math.max(1, vals.length),
        };
      };
      const mapOpen = region((m) => m !== 0);
      const mapOccluded = region((m) => m === 0);
      const mapAll = region(() => true);
      const strength = {
        openPx,
        meanAbsDiffLsb: diffsLsb.reduce((s, v) => s + v, 0) / Math.max(1, diffsLsb.length),
        final: darkeningFinal,
        pure: darkeningPure,
        mapMean: mapOpen.mean,
        mapStrongFrac: mapOpen.frac07,
        mapOpen, mapOccluded, mapAll,
      };

      // (b) ずれ。雲の影の地図と雲の覆いの相関が最大になるずらし位置。
      const ds = view.downsample;
      const dShadow = downsampleMap(cloudShadowMap, w, h, ds, false);
      const dMask = downsampleMap(mask, w, h, ds, true);
      const dCover = downsampleMap(cloudCover, w, h, ds, false);
      const scan = {
        dx: [Math.round(view.scan.dx[0] / ds), Math.round(view.scan.dx[1] / ds)],
        dy: [Math.round(view.scan.dy[0] / ds), Math.round(view.scan.dy[1] / ds)],
      };
      // 縁どうしの相関でずれを探す(強さの地図は広く重なって峰が立たない)。
      const dShadowG = gradientMap(dShadow.map, dShadow.w, dShadow.h);
      const dCoverG = gradientMap(dCover.map, dShadow.w, dShadow.h);
      const offset = scanOffsets(dShadowG, dMask.map, dCoverG, dShadow.w, dShadow.h, scan);
      const mppKm = mppOf(view.altitude) / 1000;
      const offsetKm = Math.hypot(offset.best.dx ?? 0, offset.best.dy ?? 0) * ds * mppKm;
      // 影が落ちるはずの向き(直下では雲は影より画面上 = -dy 側)へずらしたときの相関の推移。
      // ピークが h·tan(z) の範囲にあるかで、ずれの向きと大きさをあわせて判定する。
      const axis = [];
      for (let t = 0; t <= 40; t += 2) {
        axis.push({ px: t, r: nccAt(dShadowG, dMask.map, dCoverG, dShadow.w, dShadow.h, 0, -t).r });
      }
      const axisBest = axis.reduce((a, c) => (c.r > a.r ? c : a), { px: 0, r: -1 });
      const axisKm = axisBest.px * ds * mppKm;
      // 影の強い画素から見ていちばん近い雲の向き — ずれが正しければ恒星側(bin2=画面の上)へ集中する。
      const dirH = directionToCover(
        dCover.map, dMask.map, dShadow.map, dShadow.w, dShadow.h, 0.2, 0.1);

      // (b2) 細かい対応 corrFine。高域(1〜8·mpp の帯 = 画素から大きなぼかしを引いた残り)どうしの
      // 相関を、雲が影の恒星側へずれる向き(直下では雲は影より画面上 = -dy)へ掃引する。
      // 描画の細部で形づくられた雲の塊に影が対応しているほど高い。
      const hpRadius = Math.max(1, Math.round(4 / ds));
      const dShadowHP = subMap(dShadow.map, boxBlur(dShadow.map, dShadow.w, dShadow.h, hpRadius));
      const dCoverHP = subMap(dCover.map, boxBlur(dCover.map, dShadow.w, dShadow.h, hpRadius));
      // 影へ写るのは柱の遮るかどうかで、雲頂の照らされ方ではない — 輝度の覆いではなく、
      // 開いた画素のマスクの裏(雲のシルエット)を対応の相手にする。
      const dSil = new Float32Array(dMask.map.length);
      for (let i = 0; i < dSil.length; i++) dSil[i] = 1 - dMask.map[i];
      const dSilHP = subMap(dSil, boxBlur(dSil, dShadow.w, dShadow.h, hpRadius));
      const tMax = Math.min(Math.round(17 * Math.tan(view.zenithDeg * Math.PI / 180) / mppKm) + 3, 40);
      const fine = { r: -1, t: 0, dx: 0 };
      const fineSil = { r: -1, t: 0, dx: 0 };
      for (let t = 0; t <= tMax; t++) {
        for (const dx of [-1, 0, 1]) {
          const { r } = nccAt(dShadowHP, dMask.map, dCoverHP, dShadow.w, dShadow.h, dx, -t);
          if (r > fine.r) { fine.r = r; fine.t = t; fine.dx = dx; }
          const rs = nccAt(dShadowHP, dMask.map, dSilHP, dShadow.w, dShadow.h, dx, -t).r;
          if (rs > fineSil.r) { fineSil.r = rs; fineSil.t = t; fineSil.dx = dx; }
        }
      }
      const fineZero = nccAt(dShadowHP, dMask.map, dCoverHP, dShadow.w, dShadow.h, 0, 0).r;
      const fineSilZero = nccAt(dShadowHP, dMask.map, dSilHP, dShadow.w, dShadow.h, 0, 0).r;

      // (c) 鋭さ。雲の影の縁の勾配 / 雲の覆いの縁の勾配(間引いた地図で)。
      const sharp = edgeSharpness(dShadow.map, dCover.map, dShadow.w, dShadow.h, dMask.map);

      // 可視化: 暗化の地図・雲の覆い・雲の影の地図・開いた画素のマスク。
      const darkening = new Float32Array(w * h);
      const darkeningPureMap = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) {
        darkening[i] = mask[i] ? Math.max(0, lumB[i] - lumA[i]) * 4 : 0;
        darkeningPureMap[i] = mask[i] ? Math.max(0, lumOff0[i] - lumOn0[i]) * 4 : 0;
      }
      writeFileSync(path.join(dir, 'darkening.png'),
        encodeRgbPng(w, h, mapToRgb(darkening, w, h, [1, 0.2, 0.2])));
      writeFileSync(path.join(dir, 'darkening-pure.png'),
        encodeRgbPng(w, h, mapToRgb(darkeningPureMap, w, h, [1, 0.6, 0.2])));
      writeFileSync(path.join(dir, 'cloud-cover.png'),
        encodeRgbPng(w, h, mapToRgb(cloudCover, w, h, [1, 1, 1])));
      writeFileSync(path.join(dir, 'cloud-shadow.png'),
        encodeRgbPng(w, h, mapToRgb(cloudShadowMap, w, h, [0.2, 0.4, 1])));
      const maskRgb = new Uint8Array(w * h * 3);
      for (let i = 0; i < w * h; i++) {
        const v = mask[i] ? 40 : 255;
        maskRgb[i * 3] = v; maskRgb[i * 3 + 1] = v; maskRgb[i * 3 + 2] = v;
      }
      writeFileSync(path.join(dir, 'open-mask.png'), encodeRgbPng(w, h, maskRgb));
      // 目視用の横並び: 影あり | 影なし | 雲の影の地図 | 雲の覆い | 暗化。
      const strip = new Uint8Array(w * 5 * h * 3);
      const place = (rgb, slot) => {
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            strip.set(rgb.subarray((y * w + x) * 3, (y * w + x) * 3 + 3), (y * w * 5 + slot * w + x) * 3);
          }
        }
      };
      const asRgb = (png) => {
        const rgb = new Uint8Array(w * h * 3);
        for (let i = 0; i < w * h; i++) {
          rgb[i * 3] = png.data[i * png.channels];
          rgb[i * 3 + 1] = png.data[i * png.channels + 1];
          rgb[i * 3 + 2] = png.data[i * png.channels + 2];
        }
        return rgb;
      };
      place(asRgb(pngs['a-on']), 0);
      place(asRgb(pngs['b-off']), 1);
      place(mapToRgb(cloudShadowMap, w, h, [0.2, 0.4, 1]), 2);
      place(mapToRgb(cloudCover, w, h, [1, 1, 1]), 3);
      place(mapToRgb(darkening, w, h, [1, 0.2, 0.2]), 4);
      writeFileSync(path.join(dir, 'side.png'), encodeRgbPng(w * 5, h, strip));

      const metrics = {
        view: view.name, lat: view.lat, lon: view.lon,
        altitudeKm: view.altitude / 1000, mppKm, zenithDeg: view.zenithDeg,
        strength,
        offset: {
          bestPx: offset.best.dx === undefined ? null
            : { dx: offset.best.dx * ds, dy: offset.best.dy * ds },
          bestKm: offsetKm, ncc: offset.best.r, nccAtZero: offset.zero,
          axisPx: axisBest.px * ds, axisKm, axisNcc: axisBest.r, axisNccAtZero: axis[0].r,
          dirToCloud: dirH.hist, dirPx: dirH.n, dirMeanDistKm: +(dirH.meanDist * ds * mppKm).toFixed(1),
          corrFine: +fine.r.toFixed(3), corrFineAtZero: +fineZero.toFixed(3),
          corrFinePx: { dx: fine.dx, dy: fine.t }, corrFineKm: +(fine.t * ds * mppKm).toFixed(1),
          corrFineSil: +fineSil.r.toFixed(3), corrFineSilAtZero: +fineSilZero.toFixed(3),
          corrFineSilPx: { dx: fineSil.dx, dy: fineSil.t },
          corrFineSilKm: +(fineSil.t * ds * mppKm).toFixed(1),
          expectedKmForH: [3, 9, 15].map((hc) => +(hc * Math.tan(view.zenithDeg * Math.PI / 180)).toFixed(1)),
        },
        sharpness: sharp,
      };
      writeFileSync(path.join(dir, 'metrics.json'), JSON.stringify(metrics, null, 2));
      summary.push(metrics);
      console.log(
        `${view.name.padEnd(14)} occl=${((w * h - openPx) / (w * h) * 100).toFixed(0)}%`
        + ` | diff=${strength.meanAbsDiffLsb.toFixed(1)}lsb`
        + ` | final ratio=${darkeningFinal.meanRatioShadowed.toFixed(2)}`
        + ` shadow=${(darkeningFinal.shadowFrac * 100).toFixed(1)}%`
        + ` strong=${(darkeningFinal.strongFrac * 100).toFixed(1)}%`
        + ` | pure ratio=${darkeningPure.meanRatioShadowed.toFixed(2)}`
        + ` shadow=${(darkeningPure.shadowFrac * 100).toFixed(1)}%`
        + ` strong=${(darkeningPure.strongFrac * 100).toFixed(1)}%`
        + `\n${' '.repeat(16)}| map open mean=${mapOpen.mean.toFixed(3)} p99=${mapOpen.p99.toFixed(2)}`
        + ` >0.3=${(mapOpen.frac03 * 100).toFixed(1)}% >0.7=${(mapOpen.frac07 * 100).toFixed(1)}%`
        + ` | occluded mean=${mapOccluded.mean.toFixed(3)} p99=${mapOccluded.p99.toFixed(2)}`
        + ` >0.3=${(mapOccluded.frac03 * 100).toFixed(1)}% >0.7=${(mapOccluded.frac07 * 100).toFixed(1)}%`
        + ` | all mean=${mapAll.mean.toFixed(3)} >0.3=${(mapAll.frac03 * 100).toFixed(1)}%`
        + `\n${' '.repeat(16)}| offset=${offsetKm.toFixed(1)}km(px ${JSON.stringify(metrics.offset.bestPx)})`
        + ` ncc=${offset.best.r.toFixed(3)}(zero ${offset.zero.toFixed(3)})`
        + ` | axis=${axisKm.toFixed(1)}km(px ${axisBest.px * ds}) ncc=${axisBest.r.toFixed(3)}(zero ${axis[0].r.toFixed(3)})`
        + ` expected≈${metrics.offset.expectedKmForH.join('/')}km`
        + `\n${' '.repeat(16)}| dir→cloud=[${dirH.hist.map((v) => (v / Math.max(1e-9, dirH.hist.reduce((s, x) => s + x, 0))).toFixed(2)).join(',')}]`
        + ` dist=${(dirH.meanDist * ds * mppKm).toFixed(1)}km n=${dirH.n}`
        + ` | corrFine=${fine.r.toFixed(3)}@${(fine.t * ds * mppKm).toFixed(1)}km(zero ${fineZero.toFixed(3)})`
        + ` sil=${fineSil.r.toFixed(3)}@${(fineSil.t * ds * mppKm).toFixed(1)}km`
        + ` | sharp=${sharp.ratio.toFixed(2)}`,
      );
      if (config.measure) {
        const m = await devTools.evaluate(
          `window.renderLab.measure('earth', ${JSON.stringify(view.view)})`);
        console.log(`  雲影 ${m.gpuPassMs['雲影'].avg.toFixed(3)}ms`);
      }
    }
  } finally {
    await session.close();
  }
  mkdirSync(outRoot, { recursive: true });
  writeFileSync(path.join(outRoot, 'summary.json'), JSON.stringify(summary, null, 2));
  if (fatalEvents.length > 0) console.log('fatal events:', fatalEvents);
  console.log(`\nwrote ${outRoot}/`);
}

main().catch((e) => { console.error(e); process.exit(1); });
