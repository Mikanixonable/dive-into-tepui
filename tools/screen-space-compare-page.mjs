// 候補比較のページ(外部依存なしの単一 HTML)。ケース・画像の種類・候補・倍率を切り替え、1枚の画像を同じ位置で入れ替える。
import { escapeHtml } from './screen-space-chain-runs.mjs';
import { FULL, KINDS } from './screen-space-compare-kinds.mjs';

const STYLE = `
:root{--page:#17191d;--panel:#222;--text:#eee;--line:#555;--accent:#4a7fd4;--gap:12px}
body{margin:24px;background:var(--page);color:var(--text);font:14px system-ui}
h1{font-size:22px}h2{font-size:16px;margin:20px 0 6px}
table{border-collapse:collapse;margin:6px 0}th,td{border:1px solid var(--line);padding:3px 8px;text-align:right;font-variant-numeric:tabular-nums}
th:first-child,td:first-child{text-align:left}
.controls{position:sticky;top:0;z-index:1;background:var(--page);padding:8px 0;display:grid;gap:6px}
.controls>div{display:flex;gap:8px;align-items:flex-start}
.controls span{min-width:7em;color:#aaa;padding-top:4px}
.buttons{display:flex;flex-wrap:wrap;gap:6px}
button{background:var(--panel);color:var(--text);border:1px solid var(--line);padding:3px 10px;cursor:pointer}
button[aria-pressed=true]{background:var(--accent)}button:disabled{opacity:.35;cursor:default}
.stage{width:960px;height:540px;background:#000;margin:8px 0}
.stage img{display:block;width:960px;height:540px}
.stage img[data-resolution=scan]{image-rendering:pixelated}
.stage img[hidden]{display:none}
.caption{color:#aaa;min-height:1.4em}
section[hidden]{display:none}
`;

const SCRIPT = `
const data = JSON.parse(document.getElementById('data').textContent);
const state = { scene: data.scenes[0].name, kind: data.kinds[0].id, run: null, zoom: 1 };
const image = document.getElementById('image');
const caption = document.getElementById('caption');
const sceneOf = () => data.scenes.find((s) => s.name === state.scene);
const kindOf = () => data.kinds.find((k) => k.id === state.kind);
const fileOf = (run) => sceneOf().files[state.kind]?.[run]?.[kindOf().zoomable ? state.zoom : 1];
const runs = () => sceneOf().runs;
function buttons(containerId, items, isOn, onClick, isEnabled = () => true) {
  const container = document.getElementById(containerId);
  container.replaceChildren(...items.map(([key, label]) => {
    const button = document.createElement('button');
    button.textContent = label;
    button.setAttribute('aria-pressed', String(isOn(key)));
    button.disabled = !isEnabled(key);
    button.onclick = () => onClick(key);
    return button;
  }));
}
function render() {
  if (!runs().includes(state.run)) state.run = runs()[0];
  buttons('scenes', data.scenes.map((s, i) => [s.name, (i + 1) + ' ' + s.name]), (k) => k === state.scene, (k) => { state.scene = k; render(); });
  buttons('kinds', data.kinds.map((k) => [k.id, k.group + ' / ' + k.label]), (k) => k === state.kind, (k) => { state.kind = k; render(); },
    (k) => runs().some((run) => sceneOf().files[k]?.[run]));
  buttons('runs', runs().map((r) => [r, r + ' [' + data.labels[r] + ']']), (k) => k === state.run, (k) => { state.run = k; render(); }, (k) => fileOf(k) !== undefined);
  buttons('zooms', [[1, '×1'], [4, '×4']], (k) => k === state.zoom, (k) => { state.zoom = k; render(); }, () => kindOf().zoomable);
  const file = fileOf(state.run);
  image.hidden = file === undefined;
  if (file !== undefined) image.src = file;
  image.dataset.resolution = kindOf().resolution;
  caption.textContent = file === undefined ? '(この候補にこの画像は無い)'
    : state.scene + ' / ' + kindOf().label + ' / ' + state.run + ' [' + data.labels[state.run] + ']' + (kindOf().zoomable ? ' / ×' + state.zoom : '') + ' / ' + file;
  for (const section of document.querySelectorAll('section[data-scene]')) section.hidden = section.dataset.scene !== state.scene;
}
function step(list, current, delta) { return list[(list.indexOf(current) + delta + list.length) % list.length]; }
function moveToAvailable(candidates, current, delta, isEnabled) {
  let next = current;
  for (let i = 0; i < candidates.length; i++) { next = step(candidates, next, delta); if (isEnabled(next)) return next; }
  return current;
}
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const delta = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 1, ArrowUp: -1 }[e.key];
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') state.run = moveToAvailable(runs(), state.run, delta, (r) => fileOf(r) !== undefined);
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    state.kind = moveToAvailable(data.kinds.map((k) => k.id), state.kind, delta, (k) => runs().some((r) => sceneOf().files[k]?.[r]));
  } else if (e.key === 'x') state.zoom = state.zoom === 1 ? 4 : 1;
  else if (/^[1-9]$/.test(e.key) && data.scenes[Number(e.key) - 1]) state.scene = data.scenes[Number(e.key) - 1].name;
  else return;
  e.preventDefault();
  render();
});
render();
`;

function tableHtml({ title, header, rows }) {
  const head = `<tr>${header.map((cell) => `<th>${escapeHtml(cell)}</th>`).join('')}</tr>`;
  const body = rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('');
  return `<h2>${escapeHtml(title)}</h2><table>${head}${body}</table>`;
}

function conditionsHtml(conditions) {
  const fixedRows = conditions.fixed.map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`).join('');
  return `<h2>動かさない条件</h2><table>${fixedRows}</table>${tableHtml(conditions.differing)}`;
}

// scenes は { name, runs, files(画像の種類 id → run → [x1 のパス, x4 のパス])、conditions, roiTables } の並び。
// パスはページからの相対。labels は run → 因子の組の表示。
export function pageHtml(scenes, labels) {
  const data = {
    labels,
    scenes: scenes.map(({ name, runs, files }) => ({ name, runs, files })),
    kinds: KINDS.map(({ id, group, label, resolution, zoomable }) => ({ id, group, label, resolution: resolution === FULL ? 'full' : 'scan', zoomable })),
  };
  const sceneSections = scenes.map(({ name, conditions }) => `<section data-scene="${escapeHtml(name)}" hidden>${conditionsHtml(conditions)}</section>`).join('\n');
  const roiSections = scenes.map(({ name, roiTables }) => `<section data-scene="${escapeHtml(name)}" hidden>${roiTables.map(tableHtml).join('')}</section>`).join('\n');
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>8-15 候補比較</title><style>${STYLE}</style>
<h1>8-15 候補比較</h1>
<p>キー: ←/→ 候補、↑/↓ 画像の種類、1〜4 ケース、x で ×1/×4(帯のみ)。符号付きの画像は中間灰が 0 の線形表示で、尺度はケースごとに before-a で固定。</p>
${sceneSections}
<div class="controls">
<div><span>ケース</span><div class="buttons" id="scenes"></div></div>
<div><span>画像の種類</span><div class="buttons" id="kinds"></div></div>
<div><span>候補</span><div class="buttons" id="runs"></div></div>
<div><span>倍率</span><div class="buttons" id="zooms"></div></div></div>
<div class="stage"><img id="image" alt=""></div>
<div class="caption" id="caption"></div>
${roiSections}
<script type="application/json" id="data">${JSON.stringify(data).replaceAll('<', '\u003c')}</script>
<script>${SCRIPT}</script></html>`;
}
