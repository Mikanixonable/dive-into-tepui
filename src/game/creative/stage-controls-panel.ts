// クリエイティブモードの「ステージ操作」パネル: 補給・波状攻撃のトグルと、手動スポーンの入力
// (距離・敵の形状/色・タンパク質表示設定)の DOM とその場の UI 状態だけを持つ。実際の補給状態の
// 変更・敵の生成・表示の反映は、確定した値をコールバックで受け取った呼び出し側(CreativeStage)の
// 責務。
import { Button, SegmentedControl, TabBar, ToggleSwitch, ValueInput } from '../hud/widgets';
import { PROTEIN_ASSET_IDS, type ProteinAssetId } from '../protein/protein-asset-loader';
import {
  DEFAULT_PROTEIN_DISPLAY, defaultProteinDisplayFor, PROTEIN_COLOR_LABELS, PROTEIN_DISPLAY_LABELS,
  proteinColorModesFor, proteinDisplayWithColor, type ProteinColorMode, type ProteinDisplaySettings,
  type ProteinRepresentation,
} from '../protein/protein-display';

type EnemyShapeDefinition =
  | { readonly id: 'drifting'; readonly family: 'conventional'; readonly kind: 'drifting' }
  | { readonly id: 'stage0-a' | 'stage0-b' | 'stage0-c'; readonly family: 'conventional'; readonly kind: 'stage0'; readonly typeIndex: number }
  | { readonly id: ProteinAssetId; readonly family: 'protein'; readonly kind: 'protein'; readonly assetId: ProteinAssetId };

export const STAGE_CONTROL_ENEMY_SHAPES: readonly EnemyShapeDefinition[] = [
  { id: 'drifting', family: 'conventional', kind: 'drifting' },
  { id: 'stage0-a', family: 'conventional', kind: 'stage0', typeIndex: 0 },
  { id: 'stage0-b', family: 'conventional', kind: 'stage0', typeIndex: 1 },
  { id: 'stage0-c', family: 'conventional', kind: 'stage0', typeIndex: 2 },
  ...PROTEIN_ASSET_IDS.map((assetId) => ({ id: assetId, family: 'protein', kind: 'protein', assetId } as const)),
];
export type EnemySpawnShape = typeof STAGE_CONTROL_ENEMY_SHAPES[number]['id'];

const STAGE_CONTROL_ENEMY_COLORS = [
  [0xff4a3d, '赤'], [0xff7a2d, '橙'], [0xe0409f, '桃'], [0xbf3dff, '紫'], [0x3dc6ff, '青'],
] as const;

export class StageControlsPanel {
  readonly element: HTMLElement;
  // sync() が操作艦の有無に応じて有効/無効を切り替える対象。
  readonly spawnEnemyButtons: readonly Button[];

  onToggleResupply: ((on: boolean) => void) | null = null;
  onToggleFuelResupply: ((on: boolean) => void) | null = null;
  onToggleWaveAttack: ((on: boolean) => void) | null = null;
  onRefillAmmo: (() => void) | null = null;
  onRefillFuel: (() => void) | null = null;
  onSpawnDistanceChange: ((distanceM: number) => void) | null = null;
  onSpawnEnemy: ((shape: EnemySpawnShape, colorValue: string) => void) | null = null;
  onSpawnFormation: (() => void) | null = null;
  onProteinDisplayChange: ((display: ProteinDisplaySettings) => void) | null = null;

  // 入力欄が無効値を弾いたときに直前の有効値へ戻すための保持値。
  private spawnDistance: number;
  // タンパク質型セクションの現在の表示選択。表示形態を切り替えても前回選んだ着色を覚えている。
  private proteinDisplay: ProteinDisplaySettings;
  private readonly proteinDisplayByRepresentation: Map<ProteinRepresentation, ProteinDisplaySettings>;

  // 各初期値は呼び出し側(CreativeStage)が持つ現在の状態を渡す。以後の変更は onXxx コールバックで
  // 呼び出し側へ通知するので、このクラス自身は補給状態や実体の生成には触れない。
  constructor(
    resupplyEnabled: boolean, rcsFuelResupplyEnabled: boolean, waveAttackEnabled: boolean,
    initialSpawnDistance: number, initialProteinDisplay: ProteinDisplaySettings,
  ) {
    this.spawnDistance = initialSpawnDistance;
    this.proteinDisplay = initialProteinDisplay;
    this.proteinDisplayByRepresentation = new Map<ProteinRepresentation, ProteinDisplaySettings>([
      ['molecular', defaultProteinDisplayFor('molecular')],
      ['ribbon', DEFAULT_PROTEIN_DISPLAY],
      ['silhouette', defaultProteinDisplayFor('silhouette')],
    ]);
    this.proteinDisplayByRepresentation.set(initialProteinDisplay.representation, initialProteinDisplay);

    // パネルの外枠と、内容をまとめて畳めるコンパクト表示トグル。
    const panel = document.createElement('div');
    panel.id = 'hud-stage-controls';
    panel.className = 'panel hidden';
    panel.addEventListener('pointerdown', (e) => e.stopPropagation());
    const title = document.createElement('h3');
    title.textContent = 'ステージ操作';
    panel.appendChild(title);
    const body = document.createElement('div');
    body.className = 'stage-controls-body';
    panel.appendChild(body);
    const compactToggle = new ToggleSwitch('コンパクト表示', (on) => body.classList.toggle('hidden', on));
    compactToggle.setOn(false);
    panel.insertBefore(compactToggle.element, body);

    // 補給・波状攻撃・手動スポーンの各セクションを body へ組み込む。
    this.buildGeneralControls(body, resupplyEnabled, rcsFuelResupplyEnabled, waveAttackEnabled);
    const conventional = this.buildConventionalEnemySection();
    const protein = this.buildProteinEnemySection();
    this.appendEnemyTabs(body, conventional.element, protein.element);
    this.spawnEnemyButtons = [conventional.spawnButton, protein.spawnButton, protein.formationButton];

    this.element = panel;
  }

  // 操作艦の有無に応じて、敵スポーン系のボタンをまとめて有効/無効にする。
  setSpawnButtonsEnabled(enabled: boolean): void {
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
    const refillAmmoButton = new Button('弾薬を満タンにする', () => this.onRefillAmmo?.());
    body.appendChild(refillAmmoButton.element);
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

  // タンパク質型の敵の形状・表示形態・着色選択と、単体/陣形スポーンボタンをまとめたセクションを
  // 組み立てる。表示形態・着色の変更は onProteinDisplayChange で即座に呼び出し側へ通知する
  // (既存の敵への反映は呼び出し側の責務)。
  private buildProteinEnemySection(): { element: HTMLElement; spawnButton: Button; formationButton: Button } {
    const shapes = STAGE_CONTROL_ENEMY_SHAPES.filter(({ family }) => family === 'protein');
    let selectedShape: EnemySpawnShape = shapes[0]!.id;
    const section = document.createElement('div');
    section.className = 'stage-control-section';
    section.id = 'stage-control-panel-protein';
    section.setAttribute('role', 'tabpanel');
    section.setAttribute('aria-label', 'タンパク質型の敵');
    const title = document.createElement('div');
    title.className = 'stage-control-section-title';
    title.textContent = 'タンパク質型の敵';
    section.appendChild(title);
    // 形状の選択。
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

    // 表示形態の選択。切り替えるたびその形態で前回選んだ着色へ復元し、着色の選択肢を差し替える。
    const representationItems = (Object.keys(PROTEIN_DISPLAY_LABELS) as ProteinRepresentation[])
      .map((representation) => [representation, PROTEIN_DISPLAY_LABELS[representation]] as const);
    const displayControl = new SegmentedControl<ProteinRepresentation>(
      '表示形態', representationItems,
      (representation) => {
        this.proteinDisplay = this.proteinDisplayByRepresentation.get(representation) ?? defaultProteinDisplayFor(representation);
        this.proteinDisplayByRepresentation.set(representation, this.proteinDisplay);
        displayControl.setSelected(representation);
        updateColorItems();
        this.onProteinDisplayChange?.(this.proteinDisplay);
      },
    );
    displayControl.element.classList.add('stage-control-protein-representation');
    displayControl.setSelected(this.proteinDisplay.representation);
    section.appendChild(displayControl.element);

    // 着色の選択。選べる着色モードは表示形態ごとに異なるため、表示形態が変わるたび
    // updateColorItems で選択肢自体を差し替える。
    const colorControl = new SegmentedControl<ProteinColorMode>('着色', [], (mode) => {
      const next = proteinDisplayWithColor(this.proteinDisplay.representation, mode);
      if (next === null) return;
      this.proteinDisplay = next;
      this.proteinDisplayByRepresentation.set(next.representation, next);
      colorControl.setSelected(mode);
      this.onProteinDisplayChange?.(next);
    });
    colorControl.element.classList.add('stage-control-protein-colors');
    // 現在の表示形態が選べる着色モードへ colorControl の選択肢を合わせる。
    const updateColorItems = (): void => {
      const modes = proteinColorModesFor(this.proteinDisplay.representation);
      colorControl.setItems(modes.map((mode) => [mode, PROTEIN_COLOR_LABELS[mode]] as const));
      colorControl.setSelected(this.proteinDisplay.colorMode);
    };
    updateColorItems();
    section.appendChild(colorControl.element);

    // 単体スポーンと陣形スポーンのボタン。
    const spawnButton = new Button('敵をスポーン', () => this.onSpawnEnemy?.(selectedShape, String(0xffffff)));
    section.appendChild(spawnButton.element);
    const formationButton = new Button('陣形をスポーン', () => this.onSpawnFormation?.());
    section.appendChild(formationButton.element);
    return { element: section, spawnButton, formationButton };
  }

  // 従来型/タンパク質型のタブ切り替えを body へ追加し、選ばれた側のセクションだけを表示する。
  private appendEnemyTabs(body: HTMLElement, conventionalSection: HTMLElement, proteinSection: HTMLElement): void {
    type EnemyFamily = 'conventional' | 'protein';
    const sections = new Map<EnemyFamily, HTMLElement>([['conventional', conventionalSection], ['protein', proteinSection]]);
    let selectedFamily: EnemyFamily = 'conventional';
    const tabs = new TabBar<EnemyFamily>(
      [['conventional', '従来型の敵'], ['protein', 'タンパク質型の敵']],
      (family) => {
        selectedFamily = family;
        tabs.setSelected(family);
        for (const [tab, section] of sections) {
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
      const family = (index === 0 ? 'conventional' : 'protein') as EnemyFamily;
      tab.id = `stage-control-tab-${family}`;
      tab.setAttribute('aria-controls', `stage-control-panel-${family}`);
    });
    body.appendChild(tabs.element);
    body.appendChild(conventionalSection);
    body.appendChild(proteinSection);
    // 初期表示は従来型のタブを選んだ状態にする。
    tabs.setSelected(selectedFamily);
    for (const [tab, section] of sections) {
      const visible = tab === selectedFamily;
      section.classList.toggle('hidden', !visible);
      section.setAttribute('aria-hidden', String(!visible));
    }
  }
}

// ラベル付き <select> を組み立てて返す。敵の色選択にだけ使う。
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
