// 敵の実験環境(enemy-lab)。組み立て型の敵の形状パラメータとばらつきを調整し、個体の見た目・
// 統計・被弾の挙動を確かめて、ゲームへ反映する(SPEC/ASSEMBLY.md)。
import {
  ASSEMBLY_TUNING_DEFAULTS, resolveAssemblyTuning, type AssemblyTuning, type AssemblyTuningId,
} from '../../src/physics/assembly-tuning';
import { buildSlider } from '../lab-controls';
import { changedIds, onlyChanged, sendTuning, type ApplyTarget } from './apply-client';
import { StudioScene, PART_HP, type IndividualReadout, type StudioMode } from './studio-scene';
import { TUNING_GROUPS } from './tuning-spec';
import { computeVarianceStats } from './variance-stats';

const STATS_SAMPLE = 400;
const STATS_DEBOUNCE_MS = 200;

function element<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

// 調整値の現在値。スライダーはここへ書き、変わるたびに舞台と統計を組み直す。
let values: Record<AssemblyTuningId, number> = { ...ASSEMBLY_TUNING_DEFAULTS };
let firstSeed = 0;
let count = 12;

// 値を既定値へ重ねて整える(上限が下限を下回らない・整数の丸め)。
function resolved(): AssemblyTuning {
  return resolveAssemblyTuning(values);
}

function showMessage(text: string, error = false): void {
  const box = element('message');
  box.textContent = text;
  box.classList.toggle('error', error);
}

function formatReadout(r: IndividualReadout): string {
  const state = r.destroyed ? '撃破' : r.emitterAlive ? '射撃可' : '発射部を喪失(射撃不能)';
  return [
    `seed ${r.seed}   部品 ${r.parts}(失った ${r.lost})   外接半径 ${r.outerRadius.toFixed(1)} m`,
    `integrity ${r.integrity.toFixed(2)} / ${r.maxIntegrity}   部品 HP ${PART_HP}   ${state}`,
    `慣性 (${r.inertia.x.toFixed(2)}, ${r.inertia.y.toFixed(2)}, ${r.inertia.z.toFixed(2)})`,
  ].join('\n');
}

async function main(): Promise<void> {
  const canvas = element<HTMLCanvasElement>('canvas');
  const view = element('view');
  const studio = new StudioScene(canvas, resolved());
  studio.onReadout = (readout) => {
    element('readout').textContent = readout === null ? '' : formatReadout(readout);
  };
  await studio.init();
  const resize = (): void => studio.resize(view.clientWidth, view.clientHeight);
  new ResizeObserver(resize).observe(view);
  resize();
  // 縦横比が決まってから、格子全体が収まる位置へ引く。
  studio.focusAll();

  // 撮影・計測の道具が舞台を直接動かすための入口(render-lab の window.renderLab と同じ位置づけ)。
  (window as unknown as { enemyLab: { studio: StudioScene } }).enemyLab = { studio };

  // 統計は重いので、スライダーを止めてから数える。
  let statsTimer: number | null = null;
  const refreshStats = (): void => {
    if (statsTimer !== null) window.clearTimeout(statsTimer);
    statsTimer = window.setTimeout(() => {
      const s = computeVarianceStats(resolved(), firstSeed, STATS_SAMPLE);
      const counts = [...s.partCounts.entries()].sort((a, b) => a[0] - b[0]);
      const peak = Math.max(...counts.map(([, n]) => n));
      const rows = [
        `<tr><td>外接半径 最小/平均/最大</td><td>${s.outerRadius.min.toFixed(1)} / ${s.outerRadius.mean.toFixed(1)} / ${s.outerRadius.max.toFixed(1)} m</td></tr>`,
        `<tr><td>全体が結び目の個体</td><td>${(s.wholeKnotRatio * 100).toFixed(0)} %</td></tr>`,
        `<tr><td>結び目を持つ個体</td><td>${(s.anyKnotRatio * 100).toFixed(0)} %</td></tr>`,
        `<tr><td>慣性の偏り(最大/最小の平均)</td><td>${s.inertiaSpreadMean.toFixed(2)}</td></tr>`,
        ...counts.map(([parts, n]) => `<tr><td>部品 ${parts} 個</td><td><span class="bar" style="width:${Math.max(2, (n / peak) * 120)}px"></span> ${n}</td></tr>`),
      ];
      element('stats').innerHTML = `<table>${rows.join('')}</table>`;
    }, STATS_DEBOUNCE_MS);
  };

  // 値が変わったあとの更新を、1 フレームにまとめる。
  let rebuildQueued = false;
  const changed = (): void => {
    refreshChangedMarks();
    if (rebuildQueued) return;
    rebuildQueued = true;
    requestAnimationFrame(() => {
      rebuildQueued = false;
      studio.setTuning(resolved());
    });
    refreshStats();
  };

  // スライダーを群ごとに組む。
  const tuningRoot = element('tuning');
  const setters = new Map<AssemblyTuningId, (value: number) => void>();
  const itemElements = new Map<AssemblyTuningId, HTMLElement>();
  for (const [groupIndex, group] of TUNING_GROUPS.entries()) {
    const section = document.createElement('section');
    section.innerHTML = `<h2>${group.title}</h2><p class="note">${group.note}</p>`;
    const rowId = `group-${groupIndex}`;
    const row = document.createElement('div');
    row.id = rowId;
    section.appendChild(row);
    tuningRoot.appendChild(section);
    for (const item of group.items) {
      const set = buildSlider(
        rowId, item.label, item.min, item.max, item.step,
        () => String(resolved()[item.id]),
        (value) => {
          values[item.id] = value;
          changed();
        },
      );
      set(values[item.id]);
      setters.set(item.id, set);
      itemElements.set(item.id, row.lastElementChild as HTMLElement);
    }
  }
  // 既定値と違う項目の見出しを点灯させる。
  const refreshChangedMarks = (): void => {
    const diff = new Set(changedIds(resolved()));
    for (const [id, el] of itemElements) el.classList.toggle('changed', diff.has(id));
  };
  const setAll = (next: Record<AssemblyTuningId, number>): void => {
    values = { ...next };
    for (const [id, set] of setters) set(values[id]);
    changed();
  };

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

  // 操作: 選択 / 試射。
  const modeButtons = element('mode-buttons');
  const modes: readonly (readonly [StudioMode, string])[] = [['look', '選択'], ['shoot', '試射']];
  const modeEls = new Map<StudioMode, HTMLButtonElement>();
  for (const [mode, label] of modes) {
    const button = document.createElement('button');
    button.textContent = label;
    button.addEventListener('click', () => {
      studio.setMode(mode);
      for (const [m, el] of modeEls) el.classList.toggle('active', m === mode);
    });
    modeButtons.appendChild(button);
    modeEls.set(mode, button);
  }
  modeEls.get('look')!.classList.add('active');
  element<HTMLInputElement>('damage').addEventListener('input', (e) => {
    studio.setDamage(Math.max(0.1, Number((e.target as HTMLInputElement).value) || 1));
  });
  element('repair').addEventListener('click', () => studio.repair());
  element('focus-all').addEventListener('click', () => studio.focusAll());

  // ゲームへ反映。
  const send = async (target: ApplyTarget, payload: Partial<Record<AssemblyTuningId, number>>, done: string): Promise<void> => {
    try {
      const result = await sendTuning(target, payload);
      const lines = result.changed.map((c) => `  ${c.key}: ${c.from} → ${c.to}`);
      showMessage(lines.length > 0 ? `${done}\n${lines.join('\n')}` : done);
    } catch (error) {
      showMessage(`書き込めなかった: ${String((error as Error).message)}`, true);
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
  element('reset').addEventListener('click', () => setAll({ ...ASSEMBLY_TUNING_DEFAULTS }));

  refreshChangedMarks();
  refreshStats();
}

void main().catch((error: unknown) => showMessage(String(error), true));
