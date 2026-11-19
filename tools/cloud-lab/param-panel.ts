// 生成モデルの調整値のパネル。サブタブ(分野)→章→スライダーの順に並べ、スライダーには日本語名の下に
// コード上の名前を添え、ホバーで説明と既定値を出す。表の中身は generation-params.ts が持つ。
import { buildSlider } from '../lab-controls';
import { GENERATION_PARAM_TABS } from './generation-params';
import type { CloudTuningId } from '../../src/render/earth-weather/cloud/cloud-tuning';
import type { GenerationParamSpec, GenerationParamTab } from './generation-params';

// ホバー説明の、カーソルからの距離 [px]。
const TIP_OFFSET = 14;
// ホバー説明を画面の端から離す余白 [px]。
const TIP_MARGIN = 8;

// host の中へパネルを組み、id ごとにつまみを合わせる関数を返す。format は読み出しの文字、change は
// つまみを動かしたときの書き込み、defaults は説明の末尾に出す既定値。
export function buildParamPanel(
  host: HTMLElement,
  specs: Record<CloudTuningId, GenerationParamSpec>,
  defaults: Record<CloudTuningId, number>,
  format: (id: CloudTuningId) => string,
  change: (id: CloudTuningId, value: number) => void,
): Map<CloudTuningId, (value: number) => void> {
  const entries = Object.entries(specs) as [CloudTuningId, GenerationParamSpec][];
  const bar = document.createElement('div');
  bar.className = 'tabs';
  host.appendChild(bar);
  const panels = new Map<GenerationParamTab, HTMLElement>();
  const buttons = new Map<GenerationParamTab, HTMLButtonElement>();
  const select = (tab: GenerationParamTab): void => {
    for (const [id, panel] of panels) panel.hidden = id !== tab;
    for (const [id, button] of buttons) button.classList.toggle('active', id === tab);
  };
  for (const tab of GENERATION_PARAM_TABS) {
    const count = entries.filter(([, spec]) => spec.tab === tab.id).length;
    const button = document.createElement('button');
    button.textContent = `${tab.label} ${count}`;
    button.addEventListener('click', () => select(tab.id));
    bar.appendChild(button);
    buttons.set(tab.id, button);
    const panel = document.createElement('div');
    panel.className = 'p-panel';
    host.appendChild(panel);
    panels.set(tab.id, panel);
  }

  // 章ごとに行を 1 本作る。同じ章の項目は、表に現れた順にその行へ入る。
  const rowIds = new Map<string, string>();
  const setters = new Map<CloudTuningId, (value: number) => void>();
  for (const [id, spec] of entries) {
    const key = `${spec.tab}/${spec.section}`;
    if (!rowIds.has(key)) {
      const rowId = `p-section-${rowIds.size}`;
      rowIds.set(key, rowId);
      const section = document.createElement('section');
      section.className = 'p-section';
      const title = document.createElement('h3');
      title.textContent = spec.section;
      const row = document.createElement('div');
      row.className = 'row';
      row.id = rowId;
      section.append(title, row);
      panels.get(spec.tab)!.appendChild(section);
    }
    setters.set(id, buildSlider(rowIds.get(key)!, spec.label, spec.min, spec.max, spec.step,
      () => format(id), (value) => change(id, value),
      { code: id, tip: `${spec.description}\n既定値 ${defaults[id]}` }));
  }
  select(GENERATION_PARAM_TABS[0].id);
  attachTips(host);
  return setters;
}

// host の中の data-tip を持つ項目へ、カーソルについて動く説明を出す。画面の端では内側へ寄せる。
function attachTips(host: HTMLElement): void {
  const tip = document.createElement('div');
  tip.className = 'p-tip';
  tip.hidden = true;
  document.body.appendChild(tip);
  const place = (event: MouseEvent): void => {
    const x = Math.min(event.clientX + TIP_OFFSET, window.innerWidth - tip.offsetWidth - TIP_MARGIN);
    const below = event.clientY + TIP_OFFSET + tip.offsetHeight < window.innerHeight;
    tip.style.left = `${Math.max(TIP_MARGIN, x)}px`;
    tip.style.top = `${below ? event.clientY + TIP_OFFSET : event.clientY - TIP_OFFSET - tip.offsetHeight}px`;
  };
  const tipOf = (event: MouseEvent): HTMLElement | null =>
    event.target instanceof Element ? event.target.closest<HTMLElement>('[data-tip]') : null;
  host.addEventListener('mouseover', (event) => {
    const field = tipOf(event);
    if (field === null) return;
    tip.textContent = field.dataset.tip ?? '';
    tip.hidden = false;
    place(event);
  });
  host.addEventListener('mousemove', (event) => {
    if (!tip.hidden) place(event);
  });
  host.addEventListener('mouseout', (event) => {
    const leaving = tipOf(event);
    if (leaving !== null && !leaving.contains(event.relatedTarget as Node | null)) tip.hidden = true;
  });
}
