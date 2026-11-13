// クリエイティブモードの「ステージ操作」パネル: 補給・波状攻撃のトグルと、手動スポーンの入力
// (距離・敵の形状/色)の DOM と UI 状態を持ち、確定した値を onXxx のコールバックで知らせる。
import { Button, SegmentedControl, TabBar, ToggleSwitch, ValueInput } from '../../hud/widgets';

type EnemyShapeDefinition =
  | { readonly id: 'drifting'; readonly family: 'conventional'; readonly kind: 'drifting' }
  | { readonly id: 'variant-a' | 'variant-b' | 'variant-c'; readonly family: 'conventional'; readonly kind: 'variant'; readonly typeIndex: number }
  | { readonly id: 'assembly'; readonly family: 'assembly'; readonly kind: 'assembly' };

export const STAGE_CONTROL_ENEMY_SHAPES: readonly EnemyShapeDefinition[] = [
  { id: 'drifting', family: 'conventional', kind: 'drifting' },
  { id: 'variant-a', family: 'conventional', kind: 'variant', typeIndex: 0 },
  { id: 'variant-b', family: 'conventional', kind: 'variant', typeIndex: 1 },
  { id: 'variant-c', family: 'conventional', kind: 'variant', typeIndex: 2 },
  { id: 'assembly', family: 'assembly', kind: 'assembly' },
];
export type EnemySpawnShape = typeof STAGE_CONTROL_ENEMY_SHAPES[number]['id'];

const STAGE_CONTROL_ENEMY_COLORS = [
  [0xff4a3d, '赤'], [0xff7a2d, '橙'], [0xe0409f, '桃'], [0xbf3dff, '紫'], [0x3dc6ff, '青'],
] as const;

export class StageControlsPanel {
  public readonly element: HTMLElement;
  // setSpawnButtonsEnabled がまとめて有効/無効を切り替える対象。
  private readonly spawnEnemyButtons: readonly Button[];

  public onToggleResupply: ((on: boolean) => void) | null = null;
  public onToggleFuelResupply: ((on: boolean) => void) | null = null;
  public onToggleWaveAttack: ((on: boolean) => void) | null = null;
  public onAddMagazine: (() => void) | null = null;
  public onRefillFuel: (() => void) | null = null;
  public onSpawnDistanceChange: ((distanceM: number) => void) | null = null;
  public onSpawnEnemy: ((shape: EnemySpawnShape, colorValue: string) => void) | null = null;

  // 入力欄が無効値を弾いたときに直前の有効値へ戻すための保持値。
  private spawnDistance: number;

  // 各引数はパネルの初期値。以後の変更は onXxx コールバックで知らせる。
  public constructor(
    resupplyEnabled: boolean, rcsFuelResupplyEnabled: boolean, waveAttackEnabled: boolean,
    initialSpawnDistance: number,
  ) {
    this.spawnDistance = initialSpawnDistance;

    // パネルの外枠と、内容をまとめて畳めるコンパクト表示トグル。
    const panel = document.createElement('div');
    panel.id = 'hud-stage-controls';
    panel.className = 'panel hidden editorial-control-sheet';
    panel.addEventListener('pointerdown', (e) => e.stopPropagation());
    const head = document.createElement('div');
    head.className = 'editorial-panel-head';
    head.innerHTML = '<span class="ui-section-code" aria-hidden="true">LAB</span><h3 class="editorial-panel-title">CREATIVE CONTROL</h3>';
    panel.appendChild(head);
    const body = document.createElement('div');
    body.className = 'stage-controls-body';
    panel.appendChild(body);
    const compactToggle = new ToggleSwitch('コンパクト表示', (on) => body.classList.toggle('hidden', on));
    compactToggle.setOn(false);
    panel.insertBefore(compactToggle.element, body);

    // 補給・波状攻撃・手動スポーンの各セクションを body へ組み込む。
    this.buildGeneralControls(body, resupplyEnabled, rcsFuelResupplyEnabled, waveAttackEnabled);
    const conventional = this.buildConventionalEnemySection();
    const assembly = this.buildAssemblyEnemySection();
    this.appendEnemyTabs(
      body,
      [['conventional', '従来型の敵', conventional.element],
        ['assembly', '組み立て型の敵', assembly.element]],
    );
    this.spawnEnemyButtons = [
      conventional.spawnButton, assembly.spawnButton,
    ];

    this.element = panel;
  }

  // 操作艦の有無に応じて、敵スポーン系のボタンをまとめて有効/無効にする。
  public setSpawnButtonsEnabled(enabled: boolean): void {
    for (const button of this.spawnEnemyButtons) button.setEnabled(enabled);
  }

  // 補給2種・波状攻撃のトグルと、敵のスポーン距離入力を body へ足す。
  private buildGeneralControls(
    body: HTMLElement, resupplyEnabled: boolean, rcsFuelResupplyEnabled: boolean, waveAttackEnabled: boolean,
  ): void {
    const resupplyToggle = new ToggleSwitch('弾薬の自動投入', (on) => this.onToggleResupply?.(on));
    resupplyToggle.setOn(resupplyEnabled);
    body.appendChild(resupplyToggle.element);
    const fuelResupplyToggle = new ToggleSwitch('RCS燃料の自動投入', (on) => this.onToggleFuelResupply?.(on));
    fuelResupplyToggle.setOn(rcsFuelResupplyEnabled);
    body.appendChild(fuelResupplyToggle.element);
    const waveAttackToggle = new ToggleSwitch('敵の波状攻撃', (on) => this.onToggleWaveAttack?.(on));
    waveAttackToggle.setOn(waveAttackEnabled);
    body.appendChild(waveAttackToggle.element);
    const addMagazineButton = new Button('チェーンにマガジンを1つ追加', () => this.onAddMagazine?.());
    body.appendChild(addMagazineButton.element);
    const refillFuelButton = new Button('RCS燃料を満タンにする', () => this.onRefillFuel?.());
    body.appendChild(refillFuelButton.element);

    // 手動スポーンが使う距離の入力欄。無効値は直前の有効値へ戻す。
    const spawnDistanceWrapper = document.createElement('label');
    spawnDistanceWrapper.className = 'stage-control-select';
    const spawnDistanceTitle = document.createElement('span');
    spawnDistanceTitle.textContent = '敵のスポーン距離 (m)';
    spawnDistanceWrapper.appendChild(spawnDistanceTitle);
    const spawnDistanceInput = new ValueInput({ type: 'number', min: 0, step: 1 }, (text) => {
      const distance = Number(text);
      if (Number.isFinite(distance) && distance >= 0) {
        this.spawnDistance = distance;
        this.onSpawnDistanceChange?.(distance);
      }
      spawnDistanceInput.setValue(String(this.spawnDistance));
    });
    spawnDistanceInput.setValue(String(this.spawnDistance));
    spawnDistanceWrapper.appendChild(spawnDistanceInput.element);
    body.appendChild(spawnDistanceWrapper);
  }

  // 従来型の敵(漂流/接近3種)の形状・色選択とスポーンボタンをまとめたセクションを組み立てる。
  private buildConventionalEnemySection(): { element: HTMLElement; spawnButton: Button } {
    const shapes = STAGE_CONTROL_ENEMY_SHAPES.filter(({ family }) => family === 'conventional');
    let selectedShape: EnemySpawnShape = shapes[0]!.id;
    const section = document.createElement('div');
    section.className = 'stage-control-section';
    section.id = 'stage-control-panel-conventional';
    section.setAttribute('role', 'tabpanel');
    section.setAttribute('aria-label', '従来型の敵');
    const title = document.createElement('div');
    title.className = 'stage-control-section-title';
    title.textContent = '従来型の敵';
    section.appendChild(title);
    // 形状・色の選択。
    const shapeControl = new SegmentedControl<EnemySpawnShape>(
      '敵の形状', shapes.map(({ id }) => [id, id] as const),
      (shape) => {
        selectedShape = shape;
        shapeControl.setSelected(shape);
      },
    );
    shapeControl.element.classList.add('stage-control-shapes');
    shapeControl.setSelected(selectedShape);
    section.appendChild(shapeControl.element);
    const colorSelect = buildColorSelect('敵の色', STAGE_CONTROL_ENEMY_COLORS);
    section.appendChild(colorSelect.wrapper);
    const spawnButton = new Button('敵をスポーン', () => this.onSpawnEnemy?.(selectedShape, colorSelect.select.value));
    section.appendChild(spawnButton.element);
    return { element: section, spawnButton };
  }

  // 組み立て型の敵の色選択とスポーンボタンをまとめたセクションを組み立てる。
  // 形状は seed の手続き生成で選ぶものがないので、色だけを選ばせる。
  private buildAssemblyEnemySection(): { element: HTMLElement; spawnButton: Button } {
    const section = document.createElement('div');
    section.className = 'stage-control-section';
    section.id = 'stage-control-panel-assembly';
    section.setAttribute('role', 'tabpanel');
    section.setAttribute('aria-label', '組み立て型の敵');
    const title = document.createElement('div');
    title.className = 'stage-control-section-title';
    title.textContent = '組み立て型の敵';
    section.appendChild(title);
    const colorSelect = buildColorSelect('敵の色', STAGE_CONTROL_ENEMY_COLORS);
    section.appendChild(colorSelect.wrapper);
    const spawnButton = new Button('敵をスポーン', () => this.onSpawnEnemy?.('assembly', colorSelect.select.value));
    section.appendChild(spawnButton.element);
    return { element: section, spawnButton };
  }

  // 敵の種類ごとのタブ切り替えを body へ追加し、選ばれた側のセクションだけを表示する。
  private appendEnemyTabs(
    body: HTMLElement,
    entries: readonly (readonly [family: string, label: string, element: HTMLElement])[],
  ): void {
    let selectedFamily = entries[0]![0];
    const tabs = new TabBar<string>(
      entries.map(([family, label]) => [family, label] as const),
      (family) => {
        selectedFamily = family;
        tabs.setSelected(family);
        for (const [tab, , section] of entries) {
          const visible = tab === selectedFamily;
          section.classList.toggle('hidden', !visible);
          section.setAttribute('aria-hidden', String(!visible));
        }
      },
    );
    tabs.element.classList.add('stage-control-enemy-tabs');
    tabs.element.setAttribute('aria-label', '敵の種類');
    // タブ要素と対応するセクションを aria 属性で結びつける。
    tabs.element.querySelectorAll<HTMLElement>('[role="tab"]').forEach((tab, index) => {
      const family = entries[index]![0];
      tab.id = `stage-control-tab-${family}`;
      tab.setAttribute('aria-controls', `stage-control-panel-${family}`);
    });
    body.appendChild(tabs.element);
    for (const [, , section] of entries) body.appendChild(section);
    // 初期表示は先頭のタブを選んだ状態にする。
    tabs.setSelected(selectedFamily);
    for (const [family, , section] of entries) {
      const visible = family === selectedFamily;
      section.classList.toggle('hidden', !visible);
      section.setAttribute('aria-hidden', String(!visible));
    }
  }
}

// ラベル付き <select> を組み立てて返す。
function buildColorSelect<T extends number>(
  label: string, items: readonly (readonly [T, string])[],
): { readonly wrapper: HTMLElement; readonly select: HTMLSelectElement } {
  const wrapper = document.createElement('label');
  wrapper.className = 'stage-control-select';
  const title = document.createElement('span');
  title.textContent = label;
  wrapper.appendChild(title);
  const select = document.createElement('select');
  select.className = 'w-select';
  select.setAttribute('aria-label', label);
  select.addEventListener('keydown', (event) => event.stopPropagation());
  // items の順に <option> を並べる。
  for (const [value, text] of items) {
    const option = document.createElement('option');
    option.value = String(value);
    option.textContent = text;
    select.appendChild(option);
  }
  wrapper.appendChild(select);
  return { wrapper, select };
}
