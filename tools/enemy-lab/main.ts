// 敵の実験環境(enemy-lab)。組み立て型の敵の形状パラメータとばらつきを調整し、個体の見た目・
// 統計・被弾の挙動を確かめて、ゲームへ反映する(SPEC/ASSEMBLY.md)。
import {
  ASSEMBLY_TUNING_DEFAULTS, resolveAssemblyTuning, type AssemblyTuning, type AssemblyTuningId,
} from '../../src/physics/assembly-tuning';
import { changedIds, onlyChanged, sendTuning, type ApplyTarget } from './apply-client';
import {
  StudioScene, type IndividualLabel, type IndividualReadout, type StudioMode,
} from './studio-scene';
import { buildRangeControl, buildValueControl, type TuningRow } from './tuning-controls';
import { TUNING_GROUPS } from './tuning-spec';
import { computeVarianceStats } from './variance-stats';

const STATS_SAMPLE = 400;
const STATS_DEBOUNCE_MS = 200;
const ROLE_LABEL = { structure: '構造', emitter: '発射部', core: '中核' } as const;

function element<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

// 調整値の現在値。つまみはここへ書き、変わるたびに舞台と統計を組み直す。
const values: Record<AssemblyTuningId, number> = { ...ASSEMBLY_TUNING_DEFAULTS };
let firstSeed = 0;
let count = 12;

// 値を既定値へ重ねて整える(上限が下限を下回らない・整数の丸め)。
function resolved(): AssemblyTuning {
  return resolveAssemblyTuning(values);
}

function showMessage(text: string, kind: 'info' | 'ok' | 'error' = 'info'): void {
  const box = element('message');
  box.textContent = text;
  box.className = kind === 'info' ? '' : kind;
}

// 選んだ個体の状況カード。
function renderInspector(r: IndividualReadout | null): void {
  const box = element('inspector');
  box.hidden = r === null;
  if (r === null) return;
  const badge = r.destroyed
    ? '<span class="badge bad">撃破</span>'
    : r.emitterAlive ? '<span class="badge ok">射撃可</span>' : '<span class="badge warn">射撃不能</span>';
  const ratio = Math.max(0, Math.min(1, r.integrity / r.maxIntegrity));
  const parts = r.partList.map((part) => {
    const lost = part.hp <= 0;
    return `<div class="part${lost ? ' lost' : ''}"><span class="role ${part.role}">${ROLE_LABEL[part.role]} ${part.index}</span>`
      + `<div class="meter"><i style="width:${(part.hp / part.maxHp) * 100}%"></i></div><span>${part.hp.toFixed(1)}</span></div>`;
  }).join('');
  box.innerHTML = `<h2><span>SEED ${r.seed}</span>${badge}</h2>`
    + `<div class="kv"><span>integrity</span><b>${r.integrity.toFixed(2)} / ${r.maxIntegrity}</b></div>`
    + `<div class="meter"><i style="width:${ratio * 100}%"></i></div>`
    + `<div class="kv"><span>外接半径</span><b>${r.outerRadius.toFixed(1)} m</b>`
    + `<span>部品</span><b>${r.parts - r.lost} / ${r.parts}</b>`
    + `<span>慣性</span><b>${r.inertia.x.toFixed(2)} ${r.inertia.y.toFixed(2)} ${r.inertia.z.toFixed(2)}</b></div>`
    + `<div class="parts">${parts}</div>`;
}

// 個体ごとの seed ラベル。数が変わったときだけ作り直す。
function updateLabels(labels: readonly IndividualLabel[], selected: number): void {
  const layer = element('labels');
  while (layer.children.length < labels.length) layer.appendChild(Object.assign(document.createElement('div'), { className: 'label' }));
  while (layer.children.length > labels.length) layer.lastElementChild!.remove();
  for (const label of labels) {
    const el = layer.children[label.index] as HTMLElement;
    el.textContent = String(label.seed);
    el.style.left = `${label.x}px`;
    el.style.top = `${label.y + 6}px`;
    el.style.display = label.visible ? '' : 'none';
    el.classList.toggle('selected', label.index === selected);
  }
}

async function main(): Promise<void> {
  const canvas = element<HTMLCanvasElement>('canvas');
  const view = element('view');
  const studio = new StudioScene(canvas, resolved());
  studio.onReadout = renderInspector;
  studio.onLabels = (labels) => updateLabels(labels, studio.selectedIndex());
  await studio.init();
  const resize = (): void => studio.resize(view.clientWidth, view.clientHeight);
  new ResizeObserver(resize).observe(view);
  resize();
  // 縦横比が決まってから、格子全体が収まる位置へ引く。
  studio.focusAll();
  // 撮影・計測の道具が舞台を直接動かすための入口(render-lab の window.renderLab と同じ位置づけ)。
  (window as unknown as { enemyLab: { studio: StudioScene } }).enemyLab = { studio };

  // 統計は重いので、つまみを止めてから数える。
  let statsTimer: number | null = null;
  const refreshStats = (): void => {
    if (statsTimer !== null) window.clearTimeout(statsTimer);
    statsTimer = window.setTimeout(() => {
      const s = computeVarianceStats(resolved(), firstSeed, STATS_SAMPLE);
      const counts = [...s.partCounts.entries()].sort((a, b) => a[0] - b[0]);
      const peak = Math.max(...counts.map(([, n]) => n));
      const rows = [
        `<tr><td>外接半径 最小/平均/最大</td><td>${s.outerRadius.min.toFixed(0)} / ${s.outerRadius.mean.toFixed(0)} / ${s.outerRadius.max.toFixed(0)} m</td></tr>`,
        `<tr><td>全体が結び目の個体</td><td>${(s.wholeKnotRatio * 100).toFixed(0)} %</td></tr>`,
        `<tr><td>結び目を持つ個体</td><td>${(s.anyKnotRatio * 100).toFixed(0)} %</td></tr>`,
        `<tr><td>慣性の偏り(最大/最小)</td><td>${s.inertiaSpreadMean.toFixed(2)}</td></tr>`,
        ...counts.map(([parts, n]) => `<tr><td>部品 ${parts} 個</td><td><span class="bar" style="width:${Math.max(2, (n / peak) * 90)}px"></span>${n}</td></tr>`),
      ];
      element('stats').innerHTML = `<table>${rows.join('')}</table>`;
    }, STATS_DEBOUNCE_MS);
  };

  // 値が変わったあとの更新を、1 フレームにまとめる。
  let rebuildQueued = false;
  const changed = (): void => {
    refreshMarks();
    if (rebuildQueued) return;
    rebuildQueued = true;
    requestAnimationFrame(() => {
      rebuildQueued = false;
      studio.setTuning(resolved());
    });
    refreshStats();
  };

  // 調整値を、節ごとの折りたたみに組む。項目は既定へ戻すボタンを持ち、節の見出しは変更数と節ごとの戻すボタンを持つ。
  interface Entry { readonly row: TuningRow; readonly ids: readonly AssemblyTuningId[] }
  interface Section { readonly details: HTMLElement; readonly count: HTMLElement; readonly entries: Entry[] }
  const sections: Section[] = [];
  const resetIds = (ids: readonly AssemblyTuningId[]): void => {
    for (const id of ids) values[id] = ASSEMBLY_TUNING_DEFAULTS[id];
    for (const section of sections) for (const entry of section.entries) entry.row.sync();
    changed();
  };
  const tuningRoot = element('tuning');
  for (const [groupIndex, group] of TUNING_GROUPS.entries()) {
    const details = document.createElement('details');
    details.open = true;
    const summary = document.createElement('summary');
    const title = document.createElement('span');
    title.textContent = group.title;
    const countEl = document.createElement('span');
    countEl.className = 'count';
    summary.append(title, countEl);
    const body = document.createElement('div');
    body.className = 'body';
    body.id = `group-${groupIndex}`;
    const note = document.createElement('p');
    note.className = 'note';
    note.textContent = group.note;
    body.appendChild(note);
    details.append(summary, body);
    tuningRoot.appendChild(details);
    const entries: Entry[] = [];
    const section: Section = { details, count: countEl, entries };
    sections.push(section);
    // 節の戻すボタン。見出しを押して開閉する操作とぶつからないよう、伝播を止める。
    const groupReset = document.createElement('button');
    groupReset.className = 'reset-group';
    groupReset.textContent = '↺';
    groupReset.title = 'この節を既定値へ戻す';
    groupReset.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      resetIds(entries.flatMap((entry) => entry.ids));
    });
    summary.appendChild(groupReset);
    for (const item of group.items) {
      if (item.kind === 'range') {
        const ids = [item.minId, item.maxId] as const;
        entries.push({
          ids,
          row: buildRangeControl(
            body.id, item.label, item.min, item.max, item.step,
            () => [values[item.minId], values[item.maxId]],
            () => `${resolved()[item.minId]} 〜 ${resolved()[item.maxId]}`,
            (low, high) => {
              values[item.minId] = low;
              values[item.maxId] = high;
              changed();
            },
            () => resetIds(ids),
          ),
        });
      } else {
        entries.push({
          ids: [item.id],
          row: buildValueControl(
            body.id, item.label, item.min, item.max, item.step,
            () => values[item.id], () => String(resolved()[item.id]),
            (value) => {
              values[item.id] = value;
              changed();
            },
            () => resetIds([item.id]),
          ),
        });
      }
    }
  }
  // 既定値と違う項目の強調と、節・全体の変更数。
  function refreshMarks(): void {
    const diff = new Set(changedIds(resolved()));
    for (const section of sections) {
      let n = 0;
      for (const entry of section.entries) {
        const on = entry.ids.some((id) => diff.has(id));
        entry.row.setChanged(on);
        if (on) n += 1;
      }
      section.count.textContent = n > 0 ? `${n} 変更` : '';
      section.details.classList.toggle('changed', n > 0);
    }
    element('changed-count').textContent = String(diff.size);
  }
  for (const section of sections) for (const entry of section.entries) entry.row.sync();

  // 個体の入力。
  const seedInput = element<HTMLInputElement>('seed');
  const countInput = element<HTMLInputElement>('count');
  const applySeeds = (): void => {
    firstSeed = Math.max(0, Math.floor(Number(seedInput.value) || 0));
    count = Math.min(24, Math.max(1, Math.floor(Number(countInput.value) || 12)));
    studio.setSeeds(firstSeed, count);
    refreshStats();
  };
  seedInput.addEventListener('change', applySeeds);
  countInput.addEventListener('change', applySeeds);
  element('reroll').addEventListener('click', () => {
    seedInput.value = String(Math.floor(Math.random() * 1_000_000));
    applySeeds();
  });

  // 操作の切り替え: 選択 / 試射。
  const modeButtons = element('mode-buttons');
  const modes: readonly (readonly [StudioMode, string, string])[] = [['look', '選択', '1'], ['shoot', '試射', '2']];
  const modeEls = new Map<StudioMode, HTMLButtonElement>();
  const setMode = (mode: StudioMode): void => {
    studio.setMode(mode);
    for (const [m, el] of modeEls) el.classList.toggle('active', m === mode);
    canvas.style.cursor = mode === 'shoot' ? 'crosshair' : 'default';
  };
  for (const [mode, label, key] of modes) {
    const button = document.createElement('button');
    button.innerHTML = `${label}<kbd>${key}</kbd>`;
    button.addEventListener('click', () => setMode(mode));
    modeButtons.appendChild(button);
    modeEls.set(mode, button);
  }
  setMode('look');
  element<HTMLInputElement>('damage').addEventListener('input', (e) => {
    studio.setDamage(Math.max(0.1, Number((e.target as HTMLInputElement).value) || 1));
  });
  element('repair').addEventListener('click', () => studio.repair());
  element('focus-all').addEventListener('click', () => studio.focusAll());
  element('prev').addEventListener('click', () => studio.selectRelative(-1));
  element('next').addEventListener('click', () => studio.selectRelative(1));
  element('toggle-side').addEventListener('click', () => {
    element('main').classList.toggle('collapsed');
    // 開閉で描画域の大きさが変わる。
    requestAnimationFrame(resize);
  });

  // キーボード。入力欄にいるときは奪わない。
  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || (e.target instanceof HTMLInputElement && e.target.type === 'number')) return;
    const handlers: Record<string, () => void> = {
      '1': () => setMode('look'), '2': () => setMode('shoot'),
      r: () => studio.repair(), f: () => studio.focusAll(),
      '[': () => studio.selectRelative(-1), ']': () => studio.selectRelative(1),
    };
    const handler = handlers[e.key.toLowerCase()];
    if (handler === undefined) return;
    e.preventDefault();
    handler();
  });

  // ゲームへ反映。
  const send = async (target: ApplyTarget, payload: Partial<Record<AssemblyTuningId, number>>, done: string): Promise<void> => {
    try {
      const result = await sendTuning(target, payload);
      const lines = result.changed.map((c) => `  ${c.key}: ${c.from} → ${c.to}`);
      showMessage(lines.length > 0 ? `${done}\n${lines.join('\n')}` : done, 'ok');
    } catch (error) {
      showMessage(`書き込めなかった: ${String((error as Error).message)}`, 'error');
    }
  };
  element('try').addEventListener('click', () => {
    void send('overrides', onlyChanged(resolved()), 'ゲームの上書きへ送った(実行中のゲームが拾う)');
  });
  element('clear').addEventListener('click', () => {
    void send('overrides', {}, 'ゲームの上書きを解除した');
  });
  element('commit').addEventListener('click', () => {
    const ids = changedIds(resolved());
    if (ids.length === 0) {
      showMessage('既定値と違う項目が無い');
      return;
    }
    const list = ids.map((id) => `  ${id}: ${ASSEMBLY_TUNING_DEFAULTS[id]} → ${resolved()[id]}`).join('\n');
    if (!window.confirm(`assembly-tuning.ts の既定値へ書き込む(${ids.length} 項目)\n\n${list}`)) return;
    void send('defaults', onlyChanged(resolved()), '既定値へ書き込んだ(git に差分が出る)');
  });
  element('reset').addEventListener('click', () => resetIds(Object.keys(ASSEMBLY_TUNING_DEFAULTS) as AssemblyTuningId[]));

  refreshMarks();
  refreshStats();
}

void main().catch((error: unknown) => showMessage(String(error), 'error'));
