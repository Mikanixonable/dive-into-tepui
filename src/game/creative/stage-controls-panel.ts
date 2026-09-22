// クリエイティブモードの「ステージ操作」パネル: 補給・波状攻撃のトグルと、手動スポーンの入力
// (距離・敵の形状/色)と、タンパク質の表示設定の DOM と UI 状態を持ち、確定した値を onXxx の
// コールバックで知らせる。
import { Button, SegmentedControl, TabBar, ToggleSwitch, ValueInput } from '../../hud/widgets';
import { PROTEIN_ASSET_IDS, requestProteinAsset, type ProteinAssetId } from '../protein/protein-asset-loader';
import {
  DEFAULT_PROTEIN_DISPLAY, defaultProteinDisplayFor, PROTEIN_COLOR_LABELS, PROTEIN_DISPLAY_LABELS,
  proteinColorModesFor, proteinDisplayWithColor, type ProteinColorMode, type ProteinDisplaySettings,
  type ProteinRepresentation,
} from '../../render/protein/protein-display';

type EnemyShapeDefinition =
  | { readonly id: 'drifting'; readonly family: 'conventional'; readonly kind: 'drifting' }
  | { readonly id: 'variant-a' | 'variant-b' | 'variant-c'; readonly family: 'conventional'; readonly kind: 'variant'; readonly typeIndex: number }
  | { readonly id: ProteinAssetId; readonly family: 'protein'; readonly kind: 'protein'; readonly assetId: ProteinAssetId };

export const STAGE_CONTROL_ENEMY_SHAPES: readonly EnemyShapeDefinition[] = [
  { id: 'drifting', family: 'conventional', kind: 'drifting' },
  { id: 'variant-a', family: 'conventional', kind: 'variant', typeIndex: 0 },
  { id: 'variant-b', family: 'conventional', kind: 'variant', typeIndex: 1 },
  { id: 'variant-c', family: 'conventional', kind: 'variant', typeIndex: 2 },
  ...PROTEIN_ASSET_IDS.map((assetId) => ({ id: assetId, family: 'protein', kind: 'protein', assetId } as const)),
];
export type EnemySpawnShape = typeof STAGE_CONTROL_ENEMY_SHAPES[number]['id'];

const STAGE_CONTROL_ENEMY_COLORS = [
  [0xff4a3d, '赤'], [0xff7a2d, '橙'], [0xe0409f, '桃'], [0xbf3dff, '紫'], [0x3dc6ff, '青'],
] as const;

// タンパク質の表示形態と着色を選ぶ UI。選択は onProteinDisplayChange で返し、現在値は毎フレーム
// syncProteinDisplay で受ける。
export interface ProteinDisplayControl {
  onProteinDisplayChange: ((display: ProteinDisplaySettings) => void) | null;
  syncProteinDisplay(display: ProteinDisplaySettings): void;
}

export class StageControlsPanel implements ProteinDisplayControl {
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
  public onSpawnFormation: (() => void) | null = null;
  public onProteinDisplayChange: ((display: ProteinDisplaySettings) => void) | null = null;

  // 入力欄が無効値を弾いたときに直前の有効値へ戻すための保持値。
  private spawnDistance: number;
  // タンパク質型セクションの現在の表示選択。表示形態を切り替えても前回選んだ着色を覚えている。
  private proteinDisplay: ProteinDisplaySettings = DEFAULT_PROTEIN_DISPLAY;
  private readonly proteinDisplayByRepresentation = new Map<ProteinRepresentation, ProteinDisplaySettings>([
    ['molecular', defaultProteinDisplayFor('molecular')],
    ['ribbon', DEFAULT_PROTEIN_DISPLAY],
    ['silhouette', defaultProteinDisplayFor('silhouette')],
  ]);
  // 表示形態と着色の選択。選べる着色は表示形態ごとに異なるので、着色の選択肢は表示形態に
  // 合わせて差し替える。
  private readonly representationControl = new SegmentedControl<ProteinRepresentation>(
    '表示形態',
    (Object.keys(PROTEIN_DISPLAY_LABELS) as ProteinRepresentation[])
      .map((representation) => [representation, PROTEIN_DISPLAY_LABELS[representation]] as const),
    (representation) => this.selectRepresentation(representation),
  );
  private readonly colorControl = new SegmentedControl<ProteinColorMode>(
    '着色', [], (mode) => this.selectColorMode(mode),
  );

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
    const protein = this.buildProteinEnemySection();
    this.appendEnemyTabs(body, conventional.element, protein.element, protein.requestSelectedAsset);
    this.spawnEnemyButtons = [conventional.spawnButton, protein.spawnButton, protein.formationButton];

    this.element = panel;
  }

  // 操作艦の有無に応じて、敵スポーン系のボタンをまとめて有効/無効にする。
  public setSpawnButtonsEnabled(enabled: boolean): void {
    for (const button of this.spawnEnemyButtons) button.setEnabled(enabled);
  }

  // 表示形態と着色の選択を display に合わせる。いまの選択と同じなら何もしない。
  public syncProteinDisplay(display: ProteinDisplaySettings): void {
    if (display.representation === this.proteinDisplay.representation
      && display.colorMode === this.proteinDisplay.colorMode) return;
    this.proteinDisplay = display;
    this.proteinDisplayByRepresentation.set(display.representation, display);
    this.showProteinDisplay();
  }

  // 表示形態を選ぶ。その形態で前回選んだ着色へ戻し、onProteinDisplayChange で知らせる。
  private selectRepresentation(representation: ProteinRepresentation): void {
    this.proteinDisplay = this.proteinDisplayByRepresentation.get(representation) ?? defaultProteinDisplayFor(representation);
    this.proteinDisplayByRepresentation.set(representation, this.proteinDisplay);
    this.showProteinDisplay();
    this.onProteinDisplayChange?.(this.proteinDisplay);
  }

  // いまの表示形態で着色 mode を選び、onProteinDisplayChange で知らせる。選べない着色なら何もしない。
  private selectColorMode(mode: ProteinColorMode): void {
    const next = proteinDisplayWithColor(this.proteinDisplay.representation, mode);
    if (next === null) return;
    this.proteinDisplay = next;
    this.proteinDisplayByRepresentation.set(next.representation, next);
    this.colorControl.setSelected(mode);
    this.onProteinDisplayChange?.(next);
  }

  // 表示形態の選択と、着色の選択肢・選択を、いまの表示選択に合わせる。
  private showProteinDisplay(): void {
    this.representationControl.setSelected(this.proteinDisplay.representation);
    const modes = proteinColorModesFor(this.proteinDisplay.representation);
    this.colorControl.setItems(modes.map((mode) => [mode, PROTEIN_COLOR_LABELS[mode]] as const));
    this.colorControl.setSelected(this.proteinDisplay.colorMode);
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

  // タンパク質型の敵の形状・表示形態・着色選択と、単体/陣形スポーンボタンをまとめたセクションを
  // 組み立てる。
  private buildProteinEnemySection(): {
    element: HTMLElement; spawnButton: Button; formationButton: Button; requestSelectedAsset: () => void;
  } {
    const shapes = STAGE_CONTROL_ENEMY_SHAPES.filter(
      (shape): shape is Extract<EnemyShapeDefinition, { family: 'protein' }> => shape.family === 'protein',
    );
    let selectedShape: ProteinAssetId = shapes[0]!.assetId;
    // 選択そのものが取得の起点(SPEC/PROTEIN.md「出現」)。
    const selectShape = (assetId: ProteinAssetId): void => {
      selectedShape = assetId;
      shapeControl.setSelected(assetId);
      void requestProteinAsset(assetId);
    };
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
    const shapeControl = new SegmentedControl<ProteinAssetId>(
      '敵の形状', shapes.map(({ assetId }) => [assetId, assetId] as const), selectShape,
    );
    shapeControl.element.classList.add('stage-control-shapes');
    shapeControl.setSelected(selectedShape);
    section.appendChild(shapeControl.element);

    // 表示形態と着色の選択。
    this.representationControl.element.classList.add('stage-control-protein-representation');
    section.appendChild(this.representationControl.element);
    this.colorControl.element.classList.add('stage-control-protein-colors');
    section.appendChild(this.colorControl.element);
    this.showProteinDisplay();

    // 単体スポーンと陣形スポーンのボタン。
    const spawnButton = new Button('敵をスポーン', () => this.onSpawnEnemy?.(selectedShape, String(0xffffff)));
    section.appendChild(spawnButton.element);
    const formationButton = new Button('陣形をスポーン', () => this.onSpawnFormation?.());
    section.appendChild(formationButton.element);
    return {
      element: section, spawnButton, formationButton,
      requestSelectedAsset: () => { void requestProteinAsset(selectedShape); },
    };
  }

  // 従来型/タンパク質型のタブ切り替えを body へ追加し、選ばれた側のセクションだけを表示する。
  // onProteinShown はタンパク質型のタブが選ばれるたびに呼ぶ — 選ぶ画面が開いた時点が、
  // 既定で選ばれている体の取得の起点になる(SPEC/PROTEIN.md「出現」)。
  private appendEnemyTabs(
    body: HTMLElement, conventionalSection: HTMLElement, proteinSection: HTMLElement,
    onProteinShown: () => void,
  ): void {
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
        if (family === 'protein') onProteinShown();
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
