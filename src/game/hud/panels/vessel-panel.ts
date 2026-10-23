// 常設 VESSEL パネル(#hud-vessel-status)の同期: RCS燃料・出力・動圧・太陽電池パドル・放熱板・
// RCS制動・微調整・進行方向ホールド・視点のRCS追従・弾薬。操作対象が無ければ隠す。
// 装填/姿勢リセット/視点追従切替/ターゲット選択の4操作と、タッチ時のみのスロットル段は、
// キー押下と同じ経路で発火するボタンとしてここに持つ — タッチでも到達できるようにするための、
// キー入力の代替 UI。
import { KEY_MAPPING as K } from '../../../input/key-mapping';
import { Button, Meter, SegmentedControl } from '../../../hud/widgets';
import { applyAlarmLevel, worstAlarmLevel, type AlarmLevel } from '../../../hud/alarm-level';
import { createKeyCap } from '../../../hud/key-cap';
import { setReadout } from '../../../hud/readout';
import { setStatePip } from '../../../hud/state-pip';
import {
  DYNAMIC_PRESSURE_CAUTION_RATIO, DYNAMIC_PRESSURE_WARNING_RATIO, FUEL_CAUTION_RATIO, FUEL_WARNING_RATIO,
  ammoAlarmLevel, dynamicPressureAlarmLevel, fuelAlarmLevel,
} from '../../alarm/alarm-level';
import { fmtAmmoStatus } from '../ammo-status';
import { SyncThrottle } from '../sync-throttle';
import type { HudEls, HudElId } from '../hud-els';
import type { KeyBinding } from '../../../input/key-mapping';
import type { RadiatorSide } from '../../player/radiator';
import type { SolarSide } from '../../player/power';
import { THROTTLE_LEVELS, THROTTLE_LABELS } from '../../player/throttle';
import { MAX_DYN_PRESSURE } from '../../player/aero-load';

const SYNC_INTERVAL_MS = 100;

// 展開物1枚ぶんの展開度(0〜1)と損耗度(0〜1)。損耗を持たない太陽電池パドルでは wear は 0。
interface DeployState {
  readonly deploy: number;
  readonly wear: number;
}

// VESSEL パネルが1フレームに表示する値と、ボタン操作のコールバック。
export interface VesselPanelViewModel {
  readonly rcsDamp: boolean;
  readonly throttleIdx: number;
  // 大気を受けない操作対象では null。
  readonly dynamicPressurePa: number | null;
  readonly fineAttitude: boolean;
  readonly cameraFollowsAttitude: boolean;
  readonly progradeHold: boolean;
  readonly totalFuel: number;
  readonly totalMaxFuel: number;
  // 機関砲を積んでいない操作対象では null。
  readonly ammo: { readonly rounds: number; readonly mags: number; readonly cooldown: number } | null;
  // 太陽電池パドル・放熱板を積んでいない操作対象では null。
  readonly solar: Record<SolarSide, DeployState> | null;
  readonly radiator: Record<RadiatorSide, DeployState> | null;
  // キー入力と同じ経路で発火する代替操作。
  tapKey(key: KeyBinding): void;
  toggleSolar(side: SolarSide): void;
  toggleRadiator(side: RadiatorSide): void;
}

const THROTTLE_KEYS: readonly KeyBinding[] = [K.throttleLow, K.throttleMid, K.throttleHigh, K.throttleMax];
const RADIATOR_HIGH_WEAR = 0.5;

// side を「左(+X)/右(-X)」ラベルとショートカットキーへ対応させる。
// (機体の+Zが前なので、後ろから見ると+Xは左になる)
const RADIATOR_UI: Record<RadiatorSide, { label: string; key: string }> = {
  up: { label: '左', key: K.radiatorDeployLeft.label },
  down: { label: '右', key: K.radiatorDeployRight.label },
};

const SOLAR_UI: Record<SolarSide, { label: string; key: string }> = {
  up: { label: '左', key: K.solarDeployLeft.label },
  down: { label: '右', key: K.solarDeployRight.label },
};

// 行の中のバー1本ぶんの表示要素(メーター・右寄せの値)。
interface VesselMeterDom {
  readonly meter: Meter;
  readonly value: HTMLElement;
}

// 展開ボタン1つぶんの表示要素。name は部品名と左右(読み上げ名の前半)で、last* は、変わったときだけ
// 書き直すための直近の表示値。
interface DeployButtonDom {
  readonly button: Button;
  readonly name: string;
  readonly fill: HTMLElement;
  readonly state: HTMLElement;
  lastText: string;
  lastFillWidth: string;
  lastFillColor: string;
}

export class VesselPanel {
  private readonly throttle = new SyncThrottle(SYNC_INTERVAL_MS);
  // 直近の sync で受け取った状態。ボタン押下はフレーム外で発生するため、現在のコールバックをここから取得する。
  private view: VesselPanelViewModel | null = null;
  private followButton: Button | null = null;
  private readonly throttleControl: SegmentedControl<number>;
  private readonly throttleMeter: VesselMeterDom;
  private readonly qdynMeter: VesselMeterDom;
  private readonly fuelMeter: Meter;
  private readonly solarButtons: Record<SolarSide, DeployButtonDom>;
  private readonly radiatorButtons: Record<RadiatorSide, DeployButtonDom>;

  // els が指す DOM の中へ、計器のバー・代替操作ボタン・展開ボタンを組み込む。
  public constructor(private readonly els: HudEls) {
    this.throttleMeter = this.buildMeter('throttle-meter', 'throttle-value', '並進出力');
    this.qdynMeter = this.buildMeter('qdyn-gauge', 'qdyn-value', '動圧');
    this.qdynMeter.meter.setMarks(DYNAMIC_PRESSURE_CAUTION_RATIO, DYNAMIC_PRESSURE_WARNING_RATIO);
    this.fuelMeter = this.mountMeter('rcs-fuel-meter', 'RCS 燃料');
    // 動圧とRCS燃料には、それぞれの危険境界を示す目盛りを持たせる。
    this.fuelMeter.setMarks(FUEL_CAUTION_RATIO, FUEL_WARNING_RATIO);
    this.buildActionButtons();
    this.throttleControl = this.buildThrottleControl();
    const deployContainer = this.els.get('vessel-deploy-controls');
    this.solarButtons = this.buildSolarButtons(deployContainer);
    this.radiatorButtons = this.buildRadiatorButtons(deployContainer);
  }

  // Meter ウィジェットを容器要素へ差し込む。
  private mountMeter(containerId: HudElId, label: string): Meter {
    const meter = new Meter(label);
    this.els.get(containerId).appendChild(meter.element);
    return meter;
  }

  // 行の中のメーターを gaugeId の要素へ差し込み、値を書く要素 valueId と組にして返す。
  private buildMeter(gaugeId: HudElId, valueId: HudElId, label: string): VesselMeterDom {
    return { meter: this.mountMeter(gaugeId, label), value: this.els.get(valueId) };
  }

  // R/F/G/T の代替操作ボタンを組み立てて status-actions プレースホルダへ足す。
  private buildActionButtons(): void {
    const container = this.els.get('status-actions');
    // 操作名と割り当てキーをボタンに結び付ける。
    const addAction = (label: string, title: string, key: KeyBinding, isPrimary = false): Button => {
      const variants = isPrimary ? (['dense', 'primary'] as const) : (['dense', 'secondary'] as const);
      const button = new Button(label, () => this.view?.tapKey(key), undefined, variants, key.label);
      button.element.title = title;
      button.element.setAttribute('aria-label', `${label}、キー ${key.label}`);
      button.element.setAttribute('aria-keyshortcuts', key.label);
      container.appendChild(button.element);
      return button;
    };
    addAction('進行方向', 'プログレード姿勢リセット（機首を進行方向へ即座に向ける）', K.progradeReset);
    this.followButton = addAction('視点追従', '視点のRCS追従を切り替える', K.followAttitudeToggle);
    addAction('ターゲット', '照準に近い敵を第一ターゲットにする', K.targetSelect, true);
    addAction('装填', 'マニュアル装填', K.reload);
  }

  // スロットル 1-4 の SegmentedControl を組み立てて status-throttle-touch プレースホルダへ足す。
  // 表示可否は CSS(body.touch-ui-active)側が持つ — ここでは常に組む。
  private buildThrottleControl(): SegmentedControl<number> {
    const container = this.els.get('status-throttle-touch');
    const control = new SegmentedControl<number>(
      '推力段', THROTTLE_KEYS.map((key, i) => [i, key.label] as const),
      (index) => this.view?.tapKey(THROTTLE_KEYS[index]!),
    );
    container.appendChild(control.element);
    return control;
  }

  // 太陽電池パドル(左右)の展開/収納ボタン2つを組み立てる。
  private buildSolarButtons(container: HTMLElement): Record<SolarSide, DeployButtonDom> {
    return {
      up: this.buildDeployButton(container, 'パドル', SOLAR_UI.up, () => this.view?.toggleSolar('up')),
      down: this.buildDeployButton(container, 'パドル', SOLAR_UI.down, () => this.view?.toggleSolar('down')),
    };
  }

  // 放熱板(左右)の展開/収納ボタン2つを組み立てる。
  private buildRadiatorButtons(container: HTMLElement): Record<RadiatorSide, DeployButtonDom> {
    return {
      up: this.buildDeployButton(container, '放熱板', RADIATOR_UI.up, () => this.view?.toggleRadiator('up')),
      down: this.buildDeployButton(container, '放熱板', RADIATOR_UI.down, () => this.view?.toggleRadiator('down')),
    };
  }

  // 太陽電池パドル・放熱板1枚ぶんの展開/収納ボタンを組み立て、以後の更新に使う要素を返す。
  // ラベルは「部品名と左右・キーキャップ・状態」の並び。
  private buildDeployButton(
    container: HTMLElement, partName: string, side: { label: string; key: string }, onClick: () => void,
  ): DeployButtonDom {
    // 左右それぞれの部品状態を、操作可能なひとつの領域として表示する。
    const button = new Button('', onClick);
    button.element.classList.add('vessel-deploy-btn');
    const fill = document.createElement('div');
    fill.className = 'fill';
    const label = document.createElement('div');
    label.className = 'label';
    const name = `${partName}${side.label}`;
    const nameEl = document.createElement('span');
    nameEl.textContent = name;
    const state = document.createElement('span');
    label.append(nameEl, createKeyCap(side.key), state);
    button.element.replaceChildren(fill, label);
    container.appendChild(button.element);

    return { button, name, fill, state, lastText: '', lastFillWidth: '', lastFillColor: '' };
  }

  // 操作対象の状態を VESSEL パネルへ反映する。view が null(操作対象が無い)ならパネルごと隠す。
  public sync(view: VesselPanelViewModel | null, nowMs: number): void {
    this.view = view;
    if (!view) {
      this.els.get('hud-vessel-status').classList.add('hidden');
      return;
    }
    // CSS 側でも表示条件を持つが、未配置状態からの復帰時は JS で明示的に戻す。
    this.els.get('hud-vessel-status').classList.remove('hidden');

    if (!this.throttle.due(nowMs)) return;

    this.syncDeployButtons(view);

    // 制動・微調整・進行方向ホールドは自分が掛けているモード(自分の色)、視点追従は中立。
    setStatePip(this.els.get('rcs'), view.rcsDamp, true);
    const throttleIdx = view.throttleIdx;
    this.syncMeter(
      this.throttleMeter,
      throttleIdx + 1,
      THROTTLE_LEVELS.length,
      { value: THROTTLE_LABELS[throttleIdx]!, unit: `${THROTTLE_LEVELS[throttleIdx]!.toFixed(1)} m/s²` },
      'normal',
    );
    this.throttleControl.setSelected(throttleIdx);

    // 動圧の行は、大気を受ける操作対象のときだけ出す。
    const qdyn = view.dynamicPressurePa;
    this.els.get('qdyn-row').classList.toggle('hidden', qdyn === null);
    let qdynLevel: AlarmLevel = 'normal';
    let qdynText = '';
    if (qdyn !== null) {
      qdynLevel = dynamicPressureAlarmLevel(qdyn, MAX_DYN_PRESSURE);
      const parts = qdyn >= 1000
        ? { value: (qdyn / 1000).toFixed(2), unit: 'kPa' }
        : { value: qdyn.toFixed(0), unit: 'Pa' };
      qdynText = `動圧 ${parts.value} ${parts.unit}`;
      this.syncMeter(this.qdynMeter, qdyn, MAX_DYN_PRESSURE, parts, qdynLevel);
    }

    // 微調整・視点追従・進行方向ホールドの状態。
    setStatePip(this.els.get('fine'), view.fineAttitude, true);
    setStatePip(this.els.get('camfollow'), view.cameraFollowsAttitude);
    this.followButton?.setOn(view.cameraFollowsAttitude);
    setStatePip(this.els.get('prohold'), view.progradeHold, true);

    const maxFuel = view.totalMaxFuel;
    const clampedFuel = Math.max(0, Math.min(maxFuel, view.totalFuel));
    const fuelLevel = fuelAlarmLevel(clampedFuel, maxFuel);
    this.syncMeter(
      { meter: this.fuelMeter, value: this.els.get('rcs-fuel-value') },
      clampedFuel, maxFuel, { value: `${Math.round(clampedFuel)}`, unit: `/ ${Math.round(maxFuel)}` }, fuelLevel,
    );

    // 機関砲を持たない操作対象では、同じ行に燃料の読み値を出す。
    const ammoEl = this.els.get('ammo');
    const ammo = view.ammo;
    let ammoLevel: AlarmLevel = 'normal';
    let ammoSummary = '';
    if (ammo) {
      ammoLevel = ammoAlarmLevel(ammo.rounds, ammo.mags);
      ammoSummary = ammo.rounds <= 0 && ammo.mags <= 0 ? '弾切れ' : `予備 ${ammo.mags}連`;
      this.els.setText('ammo', fmtAmmoStatus(ammo.rounds, ammo.mags, ammo.cooldown));
    } else {
      this.els.setText('ammo', `Fuel: ${Math.round(view.totalFuel)} / ${maxFuel}`);
    }
    applyAlarmLevel(ammoEl, ammoLevel);

    // 畳んだ見出しには、最も重い状態を残す。平常なら燃料の残量。
    const candidates = [
      { level: fuelLevel, text: `燃料 ${maxFuel > 0 ? Math.round((clampedFuel / maxFuel) * 100) : 0}%` },
      { level: qdynLevel, text: qdynText },
      { level: ammoLevel, text: ammoSummary },
    ];
    const worstLevel = worstAlarmLevel(fuelLevel, qdynLevel, ammoLevel);
    const summary = candidates.find((entry) => entry.level === worstLevel)!;
    this.els.setText('hud-vessel-status-summary', summary.text);
    applyAlarmLevel(this.els.get('hud-vessel-status-summary'), summary.level);
  }

  // now/max の実数からメーターの満ち幅・段・aria 属性を反映し、値の要素へ「値 単位」と段を書く。
  private syncMeter(
    dom: VesselMeterDom, now: number, max: number, parts: { value: string; unit: string }, level: AlarmLevel,
  ): void {
    dom.meter.setProgress(now, max, `${parts.value} ${parts.unit}`, level);
    applyAlarmLevel(dom.value, level);
    setReadout(dom.value, parts.value, parts.unit);
  }

  // 展開度・損耗度をボタンへ同期する。損耗の表示は wear が 0 より大きいときだけ出る。
  private syncDeployButton(dom: DeployButtonDom, state: DeployState): void {
    const { deploy, wear } = state;
    const deployed = deploy >= 0.5;
    const wearPct = Math.round(wear * 100);
    const highWear = wearPct > RADIATOR_HIGH_WEAR * 100;

    dom.button.setOn(deployed);

    // 損耗は残りの幅で示し、大きくなったときだけ色でも警告する。
    const fillWidth = `${100 - wearPct}%`;
    const fillColor = highWear ? 'var(--color-error)' : 'transparent';
    if (dom.lastFillWidth !== fillWidth) {
      dom.fill.style.width = fillWidth;
      dom.lastFillWidth = fillWidth;
    }
    if (dom.lastFillColor !== fillColor) {
      dom.fill.style.background = fillColor;
      dom.lastFillColor = fillColor;
    }

    const stateText = `${deployed ? '展開' : '収納'}${wear > 0 ? ` / 損耗${wearPct}%` : ''}`;
    if (dom.lastText !== stateText) {
      const text = `${dom.name} ${stateText}`;
      dom.state.textContent = stateText;
      dom.button.element.title = `${text}（クリックで${deployed ? '収納' : '展開'}）`;
      dom.button.element.setAttribute('aria-label', `${text}。クリックで${deployed ? '収納' : '展開'}`);
      dom.lastText = stateText;
    }
  }

  // 太陽電池パドルと放熱板の4枚を同期する。どちらかを積んでいなければ行ごと畳む。
  private syncDeployButtons(view: VesselPanelViewModel): void {
    const { solar, radiator } = view;
    const container = this.els.get('vessel-deploy-controls');
    container.classList.toggle('hidden', solar === null || radiator === null);
    if (!solar || !radiator) return;

    this.syncDeployButton(this.solarButtons.up, solar.up);
    this.syncDeployButton(this.solarButtons.down, solar.down);
    this.syncDeployButton(this.radiatorButtons.up, radiator.up);
    this.syncDeployButton(this.radiatorButtons.down, radiator.down);
  }
}
