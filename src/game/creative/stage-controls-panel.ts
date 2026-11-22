// クリエイティブモードの「ステージ操作」パネル: 補給・波状攻撃のトグルと、手動スポーンの入力
// (距離・敵の形状/色)の DOM と UI 状態を持ち、確定した値を onXxx のコールバックで知らせる。
import { Button, Pulldown, ToggleSwitch, ValueInput } from '../../hud-kit/widgets';

const STAGE_CONTROL_ENEMY_COLORS = [
  [0xff4a3d, '赤'], [0xff7a2d, '橙'], [0xe0409f, '桃'], [0xbf3dff, '紫'], [0x3dc6ff, '青'],
] as const;

export class StageControlsPanel {
  public readonly element: HTMLElement;
  // setShipRequiredButtonsEnabled がまとめて有効/無効を切り替える対象。
  private readonly shipRequiredButtons: readonly Button[];

  public onToggleAmmoResupply: ((on: boolean) => void) | null = null;
  public onToggleRcsFuelResupply: ((on: boolean) => void) | null = null;
  public onToggleWaveAttack: ((on: boolean) => void) | null = null;
  public onAddMagazine: (() => void) | null = null;
  public onRefillFuel: (() => void) | null = null;
  public onRefillBaseFuel: (() => void) | null = null;
  public onSpawnDistanceChange: ((distanceM: number) => void) | null = null;
  public onSpawnEnemy: ((colorValue: string) => void) | null = null;

  // 入力欄が無効値を弾いたときに直前の有効値へ戻すための保持値。
  private spawnDistance: number;

  // 各引数はパネルの初期値。以後の変更は onXxx コールバックで知らせる。
  public constructor(
    ammoResupplyEnabled: boolean, rcsFuelResupplyEnabled: boolean, waveAttackEnabled: boolean,
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
    const generalControls = this.buildGeneralControls(
      body, ammoResupplyEnabled, rcsFuelResupplyEnabled, waveAttackEnabled,
    );
    const enemy = this.buildEnemySection();
    body.appendChild(enemy.element);
    this.shipRequiredButtons = [...generalControls.shipRequiredButtons, enemy.spawnButton];

    this.element = panel;
  }

  // 操作艦の有無に応じて、操作艦を必要とするボタンをまとめて有効/無効にする。
  public setShipRequiredButtonsEnabled(enabled: boolean): void {
    for (const button of this.shipRequiredButtons) button.setEnabled(enabled);
  }

  // 補給2種・波状攻撃のトグルと、敵のスポーン距離入力を body へ足す。
  // 操作艦を必要とするボタンは、無効化の管理へ回せるよう返す。
  private buildGeneralControls(
    body: HTMLElement, ammoResupplyEnabled: boolean, rcsFuelResupplyEnabled: boolean, waveAttackEnabled: boolean,
  ): { shipRequiredButtons: readonly Button[] } {
    const ammoResupplyToggle = new ToggleSwitch('弾薬の自動投入', (on) => this.onToggleAmmoResupply?.(on));
    ammoResupplyToggle.setOn(ammoResupplyEnabled);
    body.appendChild(ammoResupplyToggle.element);
    const rcsFuelResupplyToggle = new ToggleSwitch('RCS燃料の自動投入', (on) => this.onToggleRcsFuelResupply?.(on));
    rcsFuelResupplyToggle.setOn(rcsFuelResupplyEnabled);
    body.appendChild(rcsFuelResupplyToggle.element);
    const waveAttackToggle = new ToggleSwitch('敵の波状攻撃', (on) => this.onToggleWaveAttack?.(on));
    waveAttackToggle.setOn(waveAttackEnabled);
    body.appendChild(waveAttackToggle.element);
    const addMagazineButton = new Button('チェーンにマガジンを1つ追加', () => this.onAddMagazine?.());
    body.appendChild(addMagazineButton.element);
    const refillFuelButton = new Button('RCS燃料を満タンにする', () => this.onRefillFuel?.());
    body.appendChild(refillFuelButton.element);
    const refillBaseFuelButton = new Button('基地の燃料を満タンにする', () => this.onRefillBaseFuel?.());
    body.appendChild(refillBaseFuelButton.element);
    const shipRequiredButtons = [addMagazineButton, refillFuelButton];

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
    return { shipRequiredButtons };
  }

  // 敵の色選択とスポーンボタンをまとめたセクションを組み立てる。敵はすべて組み立て型で、
  // 形状は seed の手続き生成で選ぶものがないので、色だけを選ばせる。
  private buildEnemySection(): { element: HTMLElement; spawnButton: Button } {
    const section = document.createElement('div');
    section.className = 'stage-control-section';
    section.setAttribute('aria-label', '敵のスポーン');
    const title = document.createElement('div');
    title.className = 'stage-control-section-title';
    title.textContent = '敵';
    section.appendChild(title);
    // 組み立て型の外観は色で選ぶ。
    const colorSelect = buildColorSelect('敵の色', STAGE_CONTROL_ENEMY_COLORS);
    section.appendChild(colorSelect.wrapper);
    const spawnButton = new Button('敵をスポーン', () => this.onSpawnEnemy?.(colorSelect.getValue()));
    section.appendChild(spawnButton.element);
    return { element: section, spawnButton };
  }
}

// ラベル付きのドロップダウン選択を組み立てて返す。値は選び直した時点ではなくスポーンの
// 押下時に読むため、Pulldown の即時通知で直近の選択を保持しておく。
function buildColorSelect<T extends number>(
  label: string, items: readonly (readonly [T, string])[],
): { readonly wrapper: HTMLElement; getValue: () => string } {
  let current: T = items[0]![0];
  const pulldown = new Pulldown(label, [{ items, description: label }], null, ([value]) => {
    if (value !== undefined) current = value;
  });
  pulldown.element.classList.add('stage-control-select');
  return { wrapper: pulldown.element, getValue: () => String(current) };
}
