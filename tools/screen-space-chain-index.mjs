// 手順8-15の帯鎖の撮影の閲覧ページ: run ごとの index.html と、run の一覧 index.html。
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASELINE_RUN, escapeHtml, OUTPUT, RUNS, SCAN_HEIGHT, SCAN_WIDTH } from './screen-space-chain-runs.mjs';
import { shotsDir } from './screen-space-lab.mjs';

export const ONE_PASS_CORRECTION_SEEDS = [1, 2, 3];

const STYLE = ':root{--page:#17191d;--panel:#222;--text:#eee;--line:#555;--space:24px;--gap:18px}body{margin:var(--space);background:var(--page);color:var(--text);font:14px system-ui}h1{font-size:24px}nav{position:sticky;top:0;padding:12px;background:var(--page);z-index:1}section{scroll-margin-top:64px;margin:28px 0}section h2{border-bottom:1px solid var(--line);padding-bottom:8px}.gallery{display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));gap:var(--gap)}figure{margin:0}img{display:block;width:100%;background:var(--panel);image-rendering:auto}figcaption{padding:7px}a{color:inherit}';

// run のフォルダの index.html。runRecord は record.json の中身、passes は収束のパス数。
export function writeRunIndex(runDir, runRecord, passes, baselineLabel) {
  const scenes = Object.values(runRecord.scenes);
  const navigation = scenes.map((scene) => `<a href="#${escapeHtml(scene.scene)}">${escapeHtml(scene.scene)}</a>`).join(' | ');
  const sections = scenes.map((scene) => {
    const dir = path.join(runDir, scene.scene);
    const { scan, structure, noise, maxDeviation } = scene.displayScales;
    const entries = [
      ...scene.scanImages.map((item) => [item.png, `${item.label}(${item.id.startsWith('one-pass') ? 1 : passes}パス、線形 signed RGB、中央灰色がゼロ、表示幅 ±${scan.scale}、q=${scan.quantile})`]),
      ['rois.png', `${passes}パス平均・ROI位置`],
      [`structure-${passes}.png`, `構造差分、表示幅 ±${structure.scale}`],
      [`structure-half-difference-${passes}.png`, `構造差分の半差分、同じ表示幅 ±${structure.scale}`],
      [`noise-rms-${passes}.png`, `1パスのノイズ RMS、表示幅 ${noise.scale}`],
      [`max-deviation-${passes}.png`, `1パスの最大偏差(32パスのうち画素ごとの最大)、表示幅 ${maxDeviation?.scale}`],
      ['one-pass-correction.png', '1パスのフル解像度補正'],
      ...ONE_PASS_CORRECTION_SEEDS.map((seed) => [`one-pass-correction-seed${seed}.png`, `1パスのフル解像度補正(blue-noise seed ${seed})`]),
      [`mean-${passes}-correction.png`, `${passes}パス平均のフル解像度補正`],
      [`bypass-mean-${passes}-correction.png`, `${passes}パス平均・帯合計迂回の補正`],
      ['one-pass-diffuse-clay.png', '1パスの拡散光クレイ表示'],
      [`mean-${passes}-diffuse-clay.png`, `${passes}パス平均の拡散光クレイ表示`],
      [`bypass-mean-${passes}-diffuse-clay.png`, `${passes}パス平均・帯合計迂回のクレイ表示`],
    ];
    if (existsSync(path.join(dir, 'rois-on-render.png'))) entries.unshift(['rois-on-render.png', 'フル解像度 ROI オーバーレイ']);
    const cards = entries.filter(([file]) => scene.outputs.includes(file) || (file === 'rois-on-render.png' && existsSync(path.join(dir, file))))
      .map(([file, label]) => `<figure><a href="${scene.scene}/${file}"><img src="${scene.scene}/${file}" alt=""></a><figcaption>${escapeHtml(label)}</figcaption></figure>`).join('\n');
    return `<section id="${escapeHtml(scene.scene)}"><h2>${escapeHtml(scene.scene)}</h2><p>${passes} パス収束画像、走査画像の表示幅 ±${scan.scale} (q=${scan.quantile})、構造差分の表示幅 ±${structure.scale} (q=${structure.quantile})。</p><div class="gallery">${cards}</div></section>`;
  });
  const label = escapeHtml(runRecord.run);
  writeFileSync(path.join(runDir, 'index.html'), `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>8-15 画面空間拡散 - ${label}</title>
<style>${STYLE}</style>
<h1>8-15 画面空間拡散 - ${label}</h1><p>${passes} パス。走査解像度 ${SCAN_WIDTH}&times;${SCAN_HEIGHT}。signed RGB は線形値を灰色中心で表示し、各場面で ${escapeHtml(baselineLabel)} の固定スケールを使います。撮影条件と全スケールは record.json に記録します。</p><nav>${navigation}</nav><main>${sections.join('\n')}</main></html>`);
}

export function writeLandingIndex() {
  const labels = readdirSync(RUNS, { withFileTypes: true })
    .filter((item) => item.isDirectory() && existsSync(path.join(RUNS, item.name, 'record.json'))
      && existsSync(path.join(RUNS, item.name, 'index.html')))
    .map((item) => item.name).sort((a, b) => a === BASELINE_RUN ? -1 : b === BASELINE_RUN ? 1 : a.localeCompare(b));
  const links = labels.map((label) => `<li><a href="runs/${escapeHtml(label)}/index.html">${escapeHtml(label)}</a></li>`).join('\n');
  const legacy = existsSync(path.join(OUTPUT, 'archive', 'legacy-single-scene', 'index.html'))
    ? '<p><a href="archive/legacy-single-scene/index.html">整理前の単独撮影</a></p>' : '';
  const olderReference = existsSync(path.join(shotsDir, 'ssd-8-15-reference', 'index.html'))
    ? '<p><a href="../ssd-8-15-reference/index.html">初期の品質参照</a></p>' : '';
  const angledCase = existsSync(path.join(shotsDir, 'ssd-8-15-angled-v2', 'angled-bounce.png'))
    ? '<p><a href="../ssd-8-15-angled-v2/angled-bounce.png">角度付きケースの通常像</a></p>' : '';
  writeFileSync(path.join(OUTPUT, 'index.html'), `<!doctype html><html lang="ja"><meta charset="utf-8">
<title>8-15 帯鎖の撮影記録</title><h1>8-15 帯鎖の撮影記録</h1><p>候補aの実施前は before-a。以後の候補は別の記録に保存する。</p><ul>${links}</ul><h2>過去の診断</h2>${legacy}${olderReference}${angledCase}</html>`);
}
