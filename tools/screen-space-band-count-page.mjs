import { escapeHtml } from './screen-space-chain-runs.mjs';

const SCALES = [0, 1, 2, 4, 8, 16, 32];
const MEASUREMENTS = [
  { key: 'structure', label: 'structure' },
  { key: 'noise', label: 'noise' },
  { key: 'noiseSeed', label: 'noiseSeed' },
  { key: 'noiseRaster', label: 'noiseRaster' },
];
const IMAGE_KINDS = [
  'one-pass', 'one-pass-phase1', 'one-pass-phase2', 'one-pass-phase3', 'one-pass-clay', 'mean',
  'deviation', 'structure', 'noise', 'noise-seed', 'noise-raster', 'top-share',
];
const DELTA_KINDS = ['delta-merged', 'delta-structure', 'delta-noise', 'delta-noise-seed'];
const ZOOMS = [0.5, 1, 2, 4];

const STYLE = `
body { margin: 20px; background: #17191d; color: #eee; font: 14px system-ui, sans-serif; }
button { border: 1px solid #555; background: #25282d; color: inherit; padding: 6px 10px; cursor: pointer; }
button[aria-pressed="true"] { background: #315d94; }
button:disabled { opacity: .35; cursor: default; }
.toolbar { position: sticky; top: 0; z-index: 2; padding: 8px 0; background: #17191d; }
.group { display: flex; flex-wrap: wrap; gap: 5px; margin: 5px 0; }
.stage { width: 960px; max-width: 100%; overflow: auto; background: #090909; }
#view { display: block; width: 960px; max-width: 100%; height: auto; image-rendering: pixelated; }
table { border-collapse: collapse; margin: 8px 0 20px; }
th, td { border: 1px solid #555; padding: 5px 8px; text-align: right; }
th:first-child, td:first-child { text-align: left; }
.condition-panel { display: flex; align-items: start; gap: 24px; flex-wrap: wrap; }
.chart { max-width: 100%; height: auto; }
.legend { display: flex; flex-wrap: wrap; gap: 12px; }
`;

const SCRIPT = `
const data = JSON.parse(document.getElementById('data').textContent);
const imageKinds = ${JSON.stringify(IMAGE_KINDS)};
const deltaKinds = ${JSON.stringify(DELTA_KINDS)};
const scales = ${JSON.stringify(SCALES)};
const zooms = ${JSON.stringify(ZOOMS)};
let sceneIndex = 0;
let runIndex = 0;
let kind = 'one-pass';
let scaleChoice = 'all';
let pairName = '';
let zoom = 1;

const image = document.querySelector('#view');
const controls = document.querySelector('#controls');
const description = document.querySelector('#description');
const scene = () => data[sceneIndex];
const run = () => scene().runs[runIndex];
const isDelta = () => deltaKinds.includes(kind);
const imageId = () => scaleChoice === 'all' ? kind : kind + '-s' + scaleChoice;

function addButton(group, label, selected, action, disabled = false) {
  const button = document.createElement('button');
  button.textContent = label;
  button.disabled = disabled;
  button.setAttribute('aria-pressed', String(selected));
  button.addEventListener('click', action);
  group.append(button);
}

function makeGroup(label) {
  const section = document.createElement('section');
  const heading = document.createElement('strong');
  heading.textContent = label + ': ';
  const group = document.createElement('div');
  group.className = 'group';
  section.append(heading, group);
  controls.append(section);
  return group;
}

function currentFile() {
  const id = imageId();
  if (isDelta()) return scene().pairFiles[pairName]?.[id] ?? null;
  return scene().files[run()]?.[id] ?? null;
}

function fullResolution() {
  return !isDelta() && ['one-pass', 'one-pass-phase1', 'one-pass-phase2', 'one-pass-phase3', 'one-pass-clay', 'mean'].includes(kind);
}

function displayZoom() {
  return fullResolution() ? 1 : zoom;
}

function renderScenes() {
  const group = makeGroup('撮影');
  data.forEach((item, index) => addButton(group, (index + 1) + ' ' + item.name,
    index === sceneIndex, () => { sceneIndex = index; runIndex = 0; render(); }));
}

function renderBandCounts() {
  const group = makeGroup('帯の数');
  scene().runs.forEach((label, index) => {
    addButton(group, 'N=' + scene().counts[label], index === runIndex,
      () => { runIndex = index; render(); });
  });
}

function selectKind(candidate) {
  kind = candidate;
  if (!currentFile()) scaleChoice = 'all';
}

function renderKinds() {
  const group = makeGroup('種類');
  for (const candidate of imageKinds) {
    const available = Boolean(scene().files[run()]?.[candidate]);
    addButton(group, candidate, candidate === kind, () => { selectKind(candidate); render(); }, !available);
  }
}

function renderPairs() {
  if (!isDelta()) return;
  const group = makeGroup('帯の組');
  for (const name of Object.keys(scene().pairs)) {
    const [a, b] = name.split('-');
    const available = Boolean(scene().pairFiles[name]?.[imageId()]);
    addButton(group, a + ' → ' + b, name === pairName,
      () => { pairName = name; render(); }, !available);
  }
}

function renderScales() {
  const group = makeGroup('スケール');
  for (const value of ['all', ...scales]) {
    const key = value === 'all' ? kind : kind + '-s' + value;
    const available = isDelta()
      ? Boolean(scene().pairFiles[pairName]?.[key])
      : Boolean(scene().files[run()]?.[key]);
    addButton(group, value === 'all' ? '全体' : String(value), String(value) === String(scaleChoice),
      () => { scaleChoice = value; render(); }, !available);
  }
}

function renderZooms() {
  const group = makeGroup('CSS 倍率');
  for (const value of zooms) {
    addButton(group, '×' + value, zoom === value, () => { zoom = value; render(); },
      fullResolution() && value !== 1);
  }
}

function descriptionOf() {
  const descriptions = {
    'one-pass': '本番位相 0 の 1 パス補正項。符号付きで、正は正方向、負は負方向の補正です。',
    'one-pass-phase1': '本番位相 1 の 1 パス補正項。符号付きで、正は正方向、負は負方向の補正です。',
    'one-pass-phase2': '本番位相 2 の 1 パス補正項。符号付きで、正は正方向、負は負方向の補正です。',
    'one-pass-phase3': '本番位相 3 の 1 パス補正項。符号付きで、正は正方向、負は負方向の補正です。',
    'one-pass-clay': '本番位相 0 の 1 パス拡散クレイ画像です。',
    mean: '収束平均から求めた補正項です。符号付きで、正は正方向、負は負方向の補正です。',
    deviation: '1 パスの合流結果 − 収束した合流結果。正は 1 パスの値が大きいことを表します。',
    structure: '帯の和 − 収束した合流結果。正は合流結果より帯の和が大きいことを表します。',
    noise: '1 パスの合流結果 − 収束した合流結果の RMS。0 以上です。',
    'noise-seed': '異なる seed の 1 パス差から求めた RMS。0 以上です。',
    'noise-raster': 'noise の二乗 − noise-seed の二乗の平方根。0 以上です。',
    'top-share': '最も粗い帯の絶対値の輝度 ÷ 全帯の絶対値の輝度の和。黒が 0、白が 1 です。',
    'delta-merged': '収束した合流結果(B) − 収束した合流結果(A)。正は B の値が大きいことを表します。',
    'delta-structure': '|structure(B)| − |structure(A)| の輝度差。赤が悪化、青が改善、灰色が 0 です。',
    'delta-noise': 'noise(B) − noise(A) の輝度差。赤が悪化、青が改善、灰色が 0 です。',
    'delta-noise-seed': 'noise-seed(B) − noise-seed(A) の輝度差。赤が悪化、青が改善、灰色が 0 です。',
  };
  const prefix = isDelta() ? '差 ' + pairName + ' / ' : '';
  const scaleLabel = scaleChoice === 'all' ? '全体' : 'scale ' + scaleChoice;
  const actualScale = scene().scales[isDelta() ? 'delta-kind:' + imageId() : 'kind:' + imageId()];
  const actual = actualScale ? '表示値の範囲 ±' + (actualScale / zoom).toPrecision(3) : '表示値の範囲 —';
  const css = fullResolution() ? '全解像度画像は CSS 倍率 ×1' : 'CSS 倍率 ×' + zoom;
  return prefix + descriptions[kind] + ' / ' + scaleLabel + ' / ' + actual + ' / ' + css;
}

function renderImage() {
  const file = currentFile();
  image.hidden = !file;
  if (file) image.src = file;
  const appliedZoom = displayZoom();
  image.style.filter = appliedZoom === 1 ? 'none' : (isDelta() || kind === 'structure' || kind === 'deviation' ? 'contrast(' + appliedZoom + ')' : 'brightness(' + appliedZoom + ')');
  description.textContent = descriptionOf();
  const scale = scene().scales[isDelta() ? 'delta-kind:' + imageId() : 'kind:' + imageId()];
  const displayScale = document.querySelector('#display-scale-value');
  displayScale.textContent = fullResolution() ? '全解像度' : (scale ? (scale / appliedZoom).toPrecision(3) : '—');
  document.querySelector('#css-zoom-value').textContent = '×' + appliedZoom;
  renderCurrentConditions();
}

function renderCurrentConditions() {
  const conditions = scene().records[run()]?.conditions ?? {};
  const values = [
    ['κ', conditions.tier?.bandScale],
    ['走査の解像度', conditions.scanResolution?.join(' × ')],
    ['スライス', conditions.tier?.sliceCount],
    ['片側の歩', conditions.tier?.stepCount],
    ['パス数', conditions.passes],
    ['ジッター条件', conditions.noiseSampling ?? conditions.sampling],
  ];
  const body = document.querySelector('#current-conditions tbody');
  body.replaceChildren();
  for (const [label, value] of values) {
    const row = document.createElement('tr');
    const heading = document.createElement('th');
    const cell = document.createElement('td');
    heading.textContent = label;
    cell.textContent = value === undefined ? '—' : String(value);
    row.append(heading, cell);
    body.append(row);
  }
}

function buttonTables() {
  controls.replaceChildren();
  renderScenes();
  renderBandCounts();
  const deltaGroup = makeGroup('差');
  for (const candidate of deltaKinds) {
    const available = Boolean(scene().pairFiles[pairName]?.[candidate]);
    addButton(deltaGroup, candidate, candidate === kind, () => { selectKind(candidate); render(); }, !available);
  }
  renderKinds();
  renderPairs();
  renderScales();
  renderZooms();
}

function render() {
  if (!data.length) return;
  if (!scene().runs[runIndex]) runIndex = 0;
  if (!scene().pairs[pairName]) pairName = Object.keys(scene().pairs)[0] ?? '';
  buttonTables();
  renderImage();
}

document.addEventListener('keydown', (event) => {
  if (event.code === 'Space') {
    runIndex = runIndex === scene().runs.length - 1 ? 0 : scene().runs.length - 1;
    event.preventDefault();
  } else if (event.key === 'ArrowRight') {
    runIndex = (runIndex + 1) % scene().runs.length;
  } else if (event.key === 'ArrowLeft') {
    runIndex = (runIndex + scene().runs.length - 1) % scene().runs.length;
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    const kinds = isDelta() ? deltaKinds : imageKinds;
    const index = kinds.indexOf(kind);
    const step = event.key === 'ArrowDown' ? 1 : kinds.length - 1;
    selectKind(kinds[(index + step) % kinds.length]);
  } else if (/^[1-4]$/.test(event.key) && data[Number(event.key) - 1]) {
    sceneIndex = Number(event.key) - 1;
    runIndex = 0;
  } else {
    return;
  }
  render();
});

render();
`;

function numberText(value) {
  return Number.isFinite(value) ? Number(value).toPrecision(3) : '—';
}

function rgbRms(values) {
  if (!Array.isArray(values) || values.length !== 3) return null;
  return Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / 3);
}

function totalRms(metrics, key) {
  const scaleValues = SCALES.map((scale) => rgbRms(metrics?.scaleRms?.[key]?.[String(scale)])).filter(Number.isFinite);
  return scaleValues.length ? Math.sqrt(scaleValues.reduce((sum, value) => sum + value * value, 0)) : null;
}

function ratioText(value, baseline) {
  if (!Number.isFinite(value)) return '—';
  const valueText = numberText(value);
  if (!Number.isFinite(baseline) || baseline === 0) return valueText;
  return valueText + ' (' + (value / baseline).toPrecision(3) + ')';
}

function metricTable(scene, key, title, runs = scene.runs, metricsByRun = scene.metrics, counts = scene.counts) {
  const reference = runs.reduce((best, run) => best === null || counts[run] < counts[best] ? run : best, null);
  const rows = SCALES.map((scale) => {
    const baseline = rgbRms(metricsByRun[reference]?.scaleRms?.[key]?.[String(scale)]);
    const cells = runs.map((run) => {
      const value = rgbRms(metricsByRun[run]?.scaleRms?.[key]?.[String(scale)]);
      return '<td>' + ratioText(value, baseline) + '</td>';
    }).join('');
    return '<tr><th>' + scale + '</th>' + cells + '</tr>';
  }).join('');
  const baselineTotal = totalRms(metricsByRun[reference], key);
  const totalCells = runs.map((run) => '<td>' + ratioText(totalRms(metricsByRun[run], key), baselineTotal) + '</td>').join('');
  return '<h4>' + title + '</h4><table><thead><tr><th>scale</th>' + runs.map((run) => '<th>' + escapeHtml(run) + '</th>').join('')
    + '</tr></thead><tbody>' + rows + '<tr><th>全体 RMS</th>' + totalCells + '</tr></tbody></table>';
}

function inspectionTable(scene) {
  const referenceRun = scene.runs.at(-1);
  const referencePasses = scene.records[referenceRun]?.conditions?.passes;
  const referencePath = scene.records[referenceRun] ? `${referenceRun}/${scene.name}/band-sum-${referencePasses}.rgba.f32` : null;
  const rows = scene.runs.map((run) => {
    const passes = scene.records[run]?.conditions?.passes;
    const available = scene.bandSumInspection?.[run];
    const mean = available?.meanAbsoluteDifference;
    const maximum = available?.maximumDifference;
    return '<tr><th>' + escapeHtml(run) + ' (N=' + scene.counts[run] + ')</th><td>' + numberText(mean) + '</td><td>' + numberText(maximum)
      + '</td><td>' + escapeHtml(String(passes ?? '—')) + '</td></tr>';
  }).join('');
  return '<h3>帯和の検査</h3><p>各 run の band-sum と基準 run ' + escapeHtml(referencePath ?? '—') + ' の差。</p>'
    + '<table><thead><tr><th>run</th><th>差の平均絶対値</th><th>最大</th><th>パス数</th></tr></thead><tbody>' + rows + '</tbody></table>';
}

function bandTable(scene) {
  const maxBands = Math.max(0, ...scene.runs.map((run) => scene.bands[run]?.length ?? 0));
  const totalByRun = Object.fromEntries(scene.runs.map((run) => [run, (scene.bands[run] ?? []).reduce((sum, value) => sum + value, 0)]));
  const rows = Array.from({ length: maxBands }, (_, band) => '<tr><th>' + band + '</th>' + scene.runs.map((run) =>
    '<td>' + numberText(scene.bands[run]?.[band]) + '</td>').join('') + '</tr>').join('');
  const coarsest = scene.runs.map((run) => {
    const last = scene.bands[run]?.at(-1);
    return '<td>' + (Number.isFinite(last) && totalByRun[run] > 0 ? (100 * last / totalByRun[run]).toPrecision(3) + '%' : '—') + '</td>';
  }).join('');
  return '<h3>帯ごとの |収束先| 輝度和</h3><table><thead><tr><th>帯</th>' + scene.runs.map((run) => '<th>' + escapeHtml(run) + '</th>').join('')
    + '</tr></thead><tbody>' + rows + '<tr><th>最も粗い帯の割合</th>' + coarsest + '</tr></tbody></table>';
}

function conditionsTable(scene) {
  const fields = [
    ['κ', (conditions) => conditions.tier?.bandScale],
    ['走査の解像度', (conditions) => conditions.scanResolution?.join(' × ')],
    ['スライス', (conditions) => conditions.tier?.sliceCount],
    ['片側の歩', (conditions) => conditions.tier?.stepCount],
    ['パス数', (conditions) => conditions.passes],
    ['ジッター条件', (conditions) => conditions.noiseSampling ?? conditions.sampling],
  ];
  const rows = fields.map(([label, read]) => '<tr><th>' + label + '</th>' + scene.runs.map((run) => {
    const value = read(scene.records[run]?.conditions ?? {});
    return '<td>' + escapeHtml(value === undefined ? '—' : String(value)) + '</td>';
  }).join('') + '</tr>').join('');
  return '<h3>固定条件</h3><table><thead><tr><th>条件</th>' + scene.runs.map((run) => '<th>' + escapeHtml(run) + '</th>').join('')
    + '</tr></thead><tbody>' + rows + '</tbody></table>';
}

function chartSvg(scene, key) {
  const colors = ['#6fa8ff', '#ff9b63', '#b58cff', '#66d6bc', '#ff6f91', '#e1ce63', '#aaa'];
  const values = SCALES.map((scale) => scene.runs.map((run) => {
    const channels = scene.metrics[run]?.scaleRms?.[key]?.[String(scale)];
    return rgbRms(channels);
  }));
  const finite = values.flat().filter((value) => Number.isFinite(value) && value > 0);
  if (finite.length === 0) return '<p>グラフの値がありません。</p>';
  const low = 10 ** Math.floor(Math.log10(Math.min(...finite)));
  const high = 10 ** Math.ceil(Math.log10(Math.max(...finite)));
  const x = (index) => 60 + index * (500 / Math.max(1, scene.runs.length - 1));
  const y = (value) => 250 - (Math.log10(value) - Math.log10(low)) / Math.max(1, Math.log10(high) - Math.log10(low)) * 200;
  const ticks = [];
  for (let tick = low; tick <= high * (1 + 1e-9); tick *= 10) {
    ticks.push('<line x1="54" x2="570" y1="' + y(tick) + '" y2="' + y(tick) + '" stroke="#555"/>');
    ticks.push('<text x="4" y="' + (y(tick) + 4) + '" fill="#ddd">' + Number(tick).toExponential(0) + '</text>');
  }
  const lines = values.map((series, index) => {
    const points = series.map((value, i) => Number.isFinite(value) && value > 0 ? x(i) + ',' + y(value) : null).filter(Boolean).join(' ');
    return '<polyline fill="none" stroke="' + colors[index] + '" stroke-width="2" points="' + points + '"/>';
  }).join('');
  const xLabels = scene.runs.map((run, index) => '<text x="' + (x(index) - 10) + '" y="270" fill="#ddd">' + scene.counts[run] + '</text>').join('');
  const legend = SCALES.map((scale, index) => '<span style="color:' + colors[index] + '">■ scale ' + scale + '</span>').join('');
  return '<svg class="chart" width="590" height="285" viewBox="0 0 590 285" role="img" aria-label="' + key + ' RMS">'
    + '<text x="5" y="15" fill="#ddd">RMS (対数)</text>' + ticks.join('')
    + '<line x1="54" x2="570" y1="250" y2="250" stroke="#ddd"/><line x1="54" x2="54" y1="45" y2="250" stroke="#ddd"/>'
    + lines + xLabels + '<text x="280" y="282" fill="#ddd">帯の数 N</text></svg><div class="legend">' + legend + '</div>';
}

function summarySection(scene) {
  const checks = inspectionTable(scene);
  const regularTables = MEASUREMENTS.map(({ key, label }) => metricTable(scene, key, label)).join('');
  const controls = Object.keys(scene.controls ?? {});
  const controlNote = '<h3>control run (手順22 より前の式・ジッター無し)</h3>';
  const controlMetrics = Object.fromEntries(controls.map((run) => [run, scene.controls[run].metrics]));
  const controlTables = controls.length
    ? ['structure', 'noise'].map((key) => metricTable(scene, key, key, controls, controlMetrics, scene.controlCounts)).join('')
    : '<p>control run の数値がありません。</p>';
  return '<section><h2>' + escapeHtml(scene.name) + '</h2>' + checks + conditionsTable(scene) + '<div class="condition-panel">'
    + '<div>' + regularTables + controlNote + controlTables + bandTable(scene) + '</div>'
    + '<div><h3>structure</h3>' + chartSvg(scene, 'structure') + '<h3>noise</h3>' + chartSvg(scene, 'noise') + '</div></div></section>';
}

export function pageHtml(data) {
  const sections = data.map(summarySection).join('');
  const serialized = JSON.stringify(data).replaceAll('<', '\\u003c');
  return '<!doctype html>\n<html lang="ja">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n'
    + '<title>帯数比較</title>\n<style>\n' + STYLE + '\n</style>\n</head>\n<body>\n<h1>帯数比較</h1>\n'
    + '<p>←→ 帯の数、↑↓ 種類、Space で選択 run と最後の run を切替、1〜4 で撮影。画像は最大 960×540 表示です。</p>\n'
    + '<div id="controls" class="toolbar"></div>\n<div class="condition-panel"><div><h2>撮影条件</h2><table id="current-conditions"><tbody></tbody></table></div>'
    + '<div><h2>表示画像</h2><p id="description"></p><table><thead><tr><th>倍率</th><th>CSS</th><th>実際の表示スケール</th></tr></thead>'
    + '<tbody><tr><td>元の倍率</td><td id="css-zoom-value"></td><td id="display-scale-value"></td></tr></tbody></table>'
    + '<div class="stage"><img id="view" alt="帯数比較の地図"></div></div></div>\n'
    + sections + '\n<script type="application/json" id="data">' + serialized + '</script>\n<script>\n' + SCRIPT + '\n</script>\n</body>\n</html>\n';
}
