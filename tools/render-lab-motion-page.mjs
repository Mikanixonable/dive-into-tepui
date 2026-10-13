// 動く絵の撮影(render-lab-motion.mjs・render-lab-jitter-sweep.mjs)を見るページ(外部依存なしの単一 HTML)。場面・列・
// 画像の種類を選び、フレームを同じ位置で動画のように回す。フレームごとの補正の揺れの要約と、場面の列ごとの表、
// 列ごとの静止画(平均・分散など)も出す。

const STYLE = `
:root{--page:#17191d;--panel:#222;--text:#eee;--muted:#aaa;--line:#555;--accent:#4a7fd4}
body{margin:24px;background:var(--page);color:var(--text);font:14px system-ui}
h1{font-size:22px}h2{font-size:16px;margin:20px 0 6px}
table{border-collapse:collapse;margin:6px 0}th,td{border:1px solid var(--line);padding:3px 8px;text-align:right;font-variant-numeric:tabular-nums}
th:first-child,td:first-child{text-align:left}
tr[aria-current=true] td{background:#2b3550}
.controls{position:sticky;top:0;z-index:1;background:var(--page);padding:8px 0;display:grid;gap:6px}
.controls>div{display:flex;gap:8px;align-items:center}
.controls span{min-width:7em;color:var(--muted)}
.buttons{display:flex;flex-wrap:wrap;gap:6px}
button{background:var(--panel);color:var(--text);border:1px solid var(--line);padding:3px 10px;cursor:pointer}
button[aria-pressed=true]{background:var(--accent)}button:disabled{opacity:.35;cursor:default}
input[type=range]{width:480px}
.stage{width:960px;height:540px;background:#000}
.stage img{display:block;width:960px;height:540px}
.caption{color:var(--muted);min-height:1.4em}
[hidden]{display:none!important}
`;

const SCRIPT = `
const data = JSON.parse(document.getElementById('data').textContent);
const scenes = [...new Set(data.records.map((r) => r.scene))];
const state = { scene: scenes[0], sequence: data.records[0].sequence, kind: data.kinds[0].id, static: null, frame: 0, playing: false, fps: 8 };
const image = document.getElementById('image');
const caption = document.getElementById('caption');
const slider = document.getElementById('frame');
const recordOf = () => data.records.find((r) => r.scene === state.scene && r.sequence === state.sequence);
const kindOf = () => data.kinds.find((k) => k.id === state.kind);
const fileOf = (k) => state.scene + '/' + state.sequence + '/' + state.kind + '-' + String(k).padStart(3, '0') + '.png';
const staticsOf = () => data.statics.filter((s) => s.scene === state.scene && s.sequence === state.sequence);
const format = (v) => v === undefined || v === null ? '—' : v.toExponential(2);
function hasImage(kind, k) { return k >= kind.fromFrame; }
function buttons(containerId, items, isOn, onClick) {
  document.getElementById(containerId).replaceChildren(...items.map(([key, label]) => {
    const button = document.createElement('button');
    button.textContent = label;
    button.setAttribute('aria-pressed', String(isOn(key)));
    button.onclick = () => onClick(key);
    return button;
  }));
}
function summaryText(k) {
  const column = kindOf().column;
  const s = column === null ? null : recordOf().summaries[k][column];
  return s ? '差 RMS ' + format(s.differenceRms) + ' / 値 RMS ' + format(s.valueRms) + ' / |差| 最大 ' + format(s.differenceMax)
    + ' / 再投影 ' + (100 * s.reprojectedFraction).toFixed(1) + '%' : '(このフレームの差は無い)';
}
function render() {
  const sequences = data.records.filter((r) => r.scene === state.scene).map((r) => r.sequence);
  if (!sequences.includes(state.sequence)) state.sequence = sequences[0];
  const frames = recordOf().frames;
  state.frame = Math.min(state.frame, frames - 1);
  buttons('scenes', scenes.map((s, i) => [s, (i + 1) + ' ' + s]), (k) => k === state.scene, (k) => { state.scene = k; render(); });
  buttons('sequences', sequences.map((s) => [s, s]), (k) => k === state.sequence, (k) => { state.sequence = k; render(); });
  buttons('kinds', data.kinds.map((k) => [k.id, k.label]), (k) => k === state.kind && state.static === null,
    (k) => { state.kind = k; state.static = null; render(); });
  buttons('statics', staticsOf().map((s) => [s.file, s.label]), (k) => k === state.static, (k) => { state.static = k; render(); });
  buttons('rates', [2, 4, 8, 15, 30].map((v) => [v, v + ' fps']), (k) => k === state.fps, (k) => { state.fps = k; schedule(); render(); });
  document.getElementById('play').textContent = state.playing ? '止める' : '回す';
  slider.max = String(frames - 1);
  slider.value = String(state.frame);
  if (state.static !== null) {
    image.hidden = false;
    image.src = state.static;
    caption.textContent = state.scene + ' / ' + state.sequence + ' / ' + staticsOf().find((s) => s.file === state.static).label;
  } else {
    image.hidden = !hasImage(kindOf(), state.frame);
    if (!image.hidden) image.src = fileOf(state.frame);
    caption.textContent = state.scene + ' / ' + state.sequence + ' / フレーム ' + state.frame + ' / ' + summaryText(state.frame);
  }
  const column = kindOf().column;
  for (const row of document.querySelectorAll('tr[data-key]')) {
    row.hidden = row.dataset.scene !== state.scene;
    row.setAttribute('aria-current', String(row.dataset.key === state.scene + '/' + state.sequence + '/' + column));
  }
  preload();
}
// いまの列と種類の全フレームを先に読んでおく — 回すときに読み込みで止まらないように。
function preload() {
  for (let k = 0; k < recordOf().frames; k++) if (hasImage(kindOf(), k)) new Image().src = fileOf(k);
}
let timer = null;
function schedule() {
  clearInterval(timer);
  timer = state.playing ? setInterval(() => { state.frame = (state.frame + 1) % recordOf().frames; render(); }, 1000 / state.fps) : null;
}
document.getElementById('play').onclick = () => { state.playing = !state.playing; state.static = null; schedule(); render(); };
slider.oninput = () => { state.frame = Number(slider.value); state.static = null; render(); };
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const frames = recordOf().frames;
  if (e.key === 'ArrowRight') state.frame = (state.frame + 1) % frames;
  else if (e.key === 'ArrowLeft') state.frame = (state.frame + frames - 1) % frames;
  else if (e.key === ' ') { state.playing = !state.playing; schedule(); }
  else if (/^[1-9]$/.test(e.key) && scenes[Number(e.key) - 1]) state.scene = scenes[Number(e.key) - 1];
  else return;
  state.static = null;
  e.preventDefault();
  render();
});
render();
`;

// HTML の文字列として安全な value。
const escapeHtml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

// 揺れの表の行。aggregates は場面と列と補正の列ごとに均した揺れの並び。
function tableRowsHtml(aggregates) {
  return aggregates.map((a) => {
    const cells = [a.sequence, a.column, a.differenceRms.toExponential(2), a.valueRms.toExponential(2), a.ratio.toFixed(3),
      a.differenceMax.toExponential(2)];
    const key = `${a.scene}/${a.sequence}/${a.column}`;
    return `<tr data-scene="${escapeHtml(a.scene)}" data-key="${escapeHtml(key)}">${cells.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`;
  }).join('');
}

// records は撮影の記録({ scene, sequence, frames, summaries })の並び(summaries[k] は補正の列の名前ごとの差の要約)、
// aggregates はそれを場面と列と補正の列ごとに均した揺れ({ scene, sequence, column, differenceRms, valueRms, ratio,
// differenceMax })の並び、kinds は撮った画像の種類({ id, label, column, fromFrame } — column は要約を引く補正の列の名前
// (無ければ null)、fromFrame は画像のある最初のフレーム)の並び、statics は列ごとの静止画({ scene, sequence, label, file })の並び、
// title はページの題。画像はページからの相対で <場面>/<列>/<種類>-<フレーム>.png、静止画は file。
export function motionPageHtml(records, aggregates, kinds, statics = [], title = '補正の揺れ') {
  const data = {
    records, statics,
    kinds: kinds.map(({ id, label, column, fromFrame }) => ({ id, label, column: column ?? null, fromFrame: fromFrame ?? 0 })),
  };
  const header = ['列', '補正', '差 RMS', '値 RMS', '差 / 値', '|差| 最大'].map((c) => `<th>${c}</th>`).join('');
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>${STYLE}</style>
<h1>${escapeHtml(title)}</h1>
<p>キー: ←/→ フレーム、空白で回す/止める、1〜9 場面。補正と差は中間灰が 0 の符号付きの表示(差は 4 倍)。黒は差の無い画素
(面の無い画素・画面の外・遮蔽の変化と物の縁)。数値は q = 露出係数·ΔE/π。</p>
<div class="controls">
<div><span>場面</span><div class="buttons" id="scenes"></div></div>
<div><span>列</span><div class="buttons" id="sequences"></div></div>
<div><span>画像の種類</span><div class="buttons" id="kinds"></div></div>
<div><span>静止画</span><div class="buttons" id="statics"></div></div>
<div><span>フレーム</span><button id="play"></button><input type="range" id="frame" min="0" step="1">
<div class="buttons" id="rates"></div></div></div>
<div class="stage"><img id="image" alt=""></div>
<div class="caption" id="caption"></div>
<h2>列ごとの揺れ</h2><table><tr>${header}</tr>${tableRowsHtml(aggregates)}</table>
<script type="application/json" id="data">${JSON.stringify(data).replaceAll('<', '\\u003c')}</script>
<script>${SCRIPT}</script></html>`;
}

// 動きの参照(render-lab-motion-vectors.mjs)のページのスクリプト。場面・列・座標・積み順の組とフレームを選んで PNG を
// 出し、全フレームの要約を 1 表に並べる。表の見出しは columns から組む。
const MOTION_VECTOR_SCRIPT = `
const records = JSON.parse(document.getElementById('data').textContent);
const select = document.getElementById('record');
const kind = document.getElementById('kind');
const slider = document.getElementById('frame');
const image = document.getElementById('image');
const caption = document.getElementById('caption');
const table = document.getElementById('metrics');
const columns = [
  ['場面', (r) => r.scene], ['列', (r) => r.sequence], ['座標', (r) => r.coordinates], ['積み順', (r) => r.order],
  ['frame', (_, m) => m.frame], ['面', (_, m) => m.surfaceCount],
  ['実体輪郭率', (_, m) => m.entityOutlineFraction], ['深度輪郭率', (_, m) => m.depthOutlineFraction],
  ['ρ 最大', (_, m) => m.depthRatioMax], ['ρ/ρmax p99.9', (_, m) => m.rasterToleranceRatioP999],
  ['ρ/ρmax 最大', (_, m) => m.rasterToleranceRatioMax], ['ρ/ρmax >1', (_, m) => m.rasterToleranceAboveLimitCount],
  ['ρ >1e-4', (_, m) => m.depthRatioAboveLimitCount], ['前なし', (_, m) => m.noHistoryCount],
  ['A RMS', (_, m) => m.selfCheckRms], ['A p99.9', (_, m) => m.selfCheckP999], ['A 最大', (_, m) => m.selfCheckMax],
  ['A >1e-6', (_, m) => m.selfCheckAboveLimitCount], ['C 最大', (_, m) => m.gpuDifferenceMax],
  ['C/(動き·ρ) 最大', (_, m) => m.gpuDifferenceNormalizedMax], ['番号 RMS', (_, m) => m.slotErrorRms],
  ['番号 最大', (_, m) => m.slotErrorMax],
];
const format = (value) => typeof value === 'number' && !Number.isInteger(value) ? value.toExponential(2) : String(value);

function imagePath(record, frame) {
  return record.scene + '/' + record.sequence + '/' + record.coordinates + '/' + record.order
    + '/' + kind.value + '-' + String(frame).padStart(3, '0') + '.png';
}

function render() {
  const record = records[Number(select.value)];
  slider.max = String(record.frames - 1);
  const frame = Number(slider.value);
  const metrics = record.metrics[frame];
  image.src = imagePath(record, frame);
  caption.textContent = 'frame ' + frame + ' / 面 ' + metrics.surfaceCount
    + ' / A 最大 ' + metrics.selfCheckMax.toExponential(2) + ' px / ρ 最大 ' + metrics.depthRatioMax.toExponential(2);
}

select.replaceChildren(...records.map((record, index) => {
  const option = document.createElement('option');
  option.value = String(index);
  option.textContent = record.scene + ' / ' + record.sequence + ' / ' + record.coordinates + ' / ' + record.order;
  return option;
}));
const head = document.createElement('tr');
for (const [label] of columns) {
  const cell = document.createElement('th');
  cell.textContent = label;
  head.appendChild(cell);
}
table.appendChild(head);
for (const record of records) {
  for (const metrics of record.metrics) {
    const row = document.createElement('tr');
    for (const [, read] of columns) {
      const cell = document.createElement('td');
      cell.textContent = format(read(record, metrics));
      row.appendChild(cell);
    }
    table.appendChild(row);
  }
}
select.onchange = () => { slider.value = '0'; render(); };
kind.onchange = render;
slider.oninput = render;
render();
`;

// 動きの参照の撮影の記録 records(場面・列・座標・積み順ごとのフレームの要約)を見る、外部依存なしの単一 HTML。
export function motionVectorPageHtml(records) {
  const data = JSON.stringify(records).replaceAll('<', '\\u003c');
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>動きの参照</title><style>${STYLE}.controls select{background:var(--panel);color:var(--text);padding:4px}#image{image-rendering:pixelated}</style>
<h1>動きの参照</h1><p>色相は動きの向き、明るさは大きさ [px]、紫は前フレームが無い画素。差は CPU 自己検算の差 ×10。</p>
<div class="controls">
<div><span>場面・列・座標・順</span><select id="record"></select></div>
<div><span>画像</span><select id="kind"><option value="motion">期待する動き</option><option value="difference">CPU 自己検算の差 ×10</option></select></div>
<div><span>フレーム</span><input type="range" id="frame" min="0" step="1"><span id="caption"></span></div>
</div>
<div class="stage"><img id="image" alt=""></div>
<h2>数値の一覧</h2><table id="metrics"></table>
<script type="application/json" id="data">${data}</script><script>${MOTION_VECTOR_SCRIPT}</script></html>`;
}
