// 常設 VESSEL パネル(#hud-vessel-status)の同期。「いま艦はどんな状態で、どう構えているか」を、
// 計器(RCS燃料・並進出力・動圧・船体温度)・モード(RCS制動・微調整・進行方向ホールド)・展開部品
// (太陽電池パドル・放熱板)・操作(姿勢リセット・ターゲット選択)の4区画で示す。操作対象が無ければ隠す。
// ボタンはキー押下と同じ経路で発火し、タッチでは推力段とモードがキー無しで押せるボタンになる。
import { KEY_MAPPING as K } from '../../../input/key-mapping';
import { Button, Meter, SegmentedControl } from '../../../hud/widgets';
import { applyAlarmLevel, worstAlarmLevel, type AlarmLevel } from '../../../hud/alarm-level';
import { createKeyCap } from '../../../hud/key-cap';
import { setReadout } from '../../../hud/readout';
import { setStatePip } from '../../../hud/state-pip';
import {
  DYNAMIC_PRESSURE_CAUTION_RATIO, DYNAMIC_PRESSURE_WARNING_RATIO, FUEL_CAUTION_RATIO, FUEL_WARNING_RATIO,
  TEMPERATURE_CAUTION_RATIO, TEMPERATURE_WARNING_RATIO, WEAR_CAUTION_RATIO, WEAR_WARNING_RATIO,
  wearAlarmLevel,
} from '../../alarm/alarm-level';
import { SyncThrottle } from '../sync-throttle';
import type { HudEls, HudElId } from '../hud-els';
import type { KeyBinding } from '../../../input/key-mapping';
import type { RadiatorSide } from '../../player/radiator';
import type { SolarSide } from '../../player/power';
import { THROTTLE_LEVELS, THROTTLE_LABELS } from '../../player/throttle';
import { MAX_DYN_PRESSURE } from '../../player/aero-load';
import { MAX_HULL_TEMP } from '../../dynamic/dynamic-entity/combat-ship-entity';

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
  readonly temperatureK: number;
  // 警報の評価器が判定した動圧・燃料・船体温度の段。行・メーターは警報灯と同じ判定を読む。
  readonly dynamicPressureLevel: AlarmLevel;
  readonly fuelLevel: AlarmLevel;
  readonly temperatureLevel: AlarmLevel;
  readonly fineAttitude: boolean;
  readonly progradeHold: boolean;
  readonly totalFuel: number;
  readonly totalMaxFuel: number;
  // 太陽電池パドル・放熱板を積んでいない操作対象では null。
  readonly solar: Record<SolarSide, DeployState> | null;
  readonly radiator: Record<RadiatorSide, DeployState> | null;
  // キー入力と同じ経路で発火する代替操作。
  tapKey(key: KeyBinding): void;
  toggleSolar(side: SolarSide): void;
  toggleRadiator(side: RadiatorSide): void;
}

const THROTTLE_KEYS: readonly KeyBinding[] = [K.throttleLow, K.throttleMid, K.throttleHigh, K.throttleMax];

// タッチで押せるモードの列。押下はキー押下と同じ経路で、点灯は view の対応する状態から決まる。
const TOUCH_MODES: readonly { readonly label: string; readonly key: KeyBinding }[] = [
  { label: 'RCS 制動', key: K.rcsDampToggle },
  { label: '微調整', key: K.fineAttitudeToggle },
  { label: '進行方向ホールド', key: K.progradeHoldToggle },
];

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

// 展開ボタン1つぶんの表示要素。name は部品名と左右(読み上げ名の前半)で、pip は展開の点と左右の語。
// lastText は、変わったときだけ書き直すための直近の読み上げ名。
interface DeployButtonDom {
  readonly button: Button;
  readonly name: string;
  readonly pip: HTMLElement;
  lastText: string;
}

// 放熱板1枚ぶんの損耗の行。損耗が無い間は行ごと畳む。
interface WearRowDom {
  readonly row: HTMLElement;
  readonly meter: Meter;
  readonly value: HTMLElement;
}

export class VesselPanel {
  private readonly throttle = new SyncThrottle(SYNC_INTERVAL_MS);
  // 直近の sync で受け取った状態。ボタン押下はフレーム外で発生するため、現在のコールバックをここから取得する。
  private view: VesselPanelViewModel | null = null;
  private readonly throttleControl: SegmentedControl<number>;
  private readonly modeButtons: readonly Button[];
  private readonly throttleMeter: VesselMeterDom;
  private readonly qdynMeter: VesselMeterDom;
  private readonly tempMeter: VesselMeterDom;
  private readonly fuelMeter: Meter;
  private readonly solarButtons: Record<SolarSide, DeployButtonDom>;
  private readonly radiatorButtons: Record<RadiatorSide, DeployButtonDom>;
  private readonly radiatorWearRows: Record<RadiatorSide, WearRowDom>;

  // els が指す DOM の中へ、計器のバー・タッチ用ボタン・展開部品の行・操作ボタンを組み込む。
  public constructor(private readonly els: HudEls) {
    // 計器のメーター。
    this.throttleMeter = this.buildMeter('throttle-meter', 'throttle-value', '並進出力');
    this.qdynMeter = this.buildMeter('qdyn-gauge', 'qdyn-value', '動圧');
    this.qdynMeter.meter.setMarks(DYNAMIC_PRESSURE_CAUTION_RATIO, DYNAMIC_PRESSURE_WARNING_RATIO);
    this.tempMeter = this.buildMeter('vessel-temp-gauge', 'vessel-temp-value', '船体温度');
    this.tempMeter.meter.setMarks(TEMPERATURE_CAUTION_RATIO, TEMPERATURE_WARNING_RATIO);
    this.fuelMeter = this.mountMeter('rcs-fuel-meter', 'RCS 燃料');
    this.fuelMeter.setMarks(FUEL_CAUTION_RATIO, FUEL_WARNING_RATIO);
    // タッチ用の推力段とモードのボタン。
    this.throttleControl = this.buildThrottleControl();
    this.modeButtons = this.buildModeButtons();
    // 展開部品の行と損耗の行、単発操作。
    const deploy = this.els.get('vessel-deploy-controls');
    this.solarButtons = {
      up: this.buildDeployButton('パドル', SOLAR_UI.up, () => this.view?.toggleSolar('up')),
      down: this.buildDeployButton('パドル', SOLAR_UI.down, () => this.view?.toggleSolar('down')),
    };
    this.radiatorButtons = {
      up: this.buildDeployButton('放熱板', RADIATOR_UI.up, () => this.view?.toggleRadiator('up')),
      down: this.buildDeployButton('放熱板', RADIATOR_UI.down, () => this.view?.toggleRadiator('down')),
    };
    deploy.append(
      this.buildDeployRow('パドル', this.solarButtons.up, this.solarButtons.down),
      this.buildDeployRow('放熱板', this.radiatorButtons.up, this.radiatorButtons.down),
    );
    this.radiatorWearRows = {
      up: this.buildWearRow(deploy, `放熱板 ${RADIATOR_UI.up.label} 損耗`),
      down: this.buildWearRow(deploy, `放熱板 ${RADIATOR_UI.down.label} 損耗`),
    };
    this.buildActionButtons();
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

  // F/T の単発操作ボタンを組み立てて status-actions プレースホルダへ足す。ターゲット選択はターゲットの色。
  private buildActionButtons(): void {
    const container = this.els.get('status-actions');
    // 操作名と割り当てキーをボタンに結び付ける。
    const addAction = (label: string, title: string, key: KeyBinding): Button => {
      const button = new Button(label, () => this.view?.tapKey(key), undefined, ['dense', 'secondary'], key.label);
      button.element.title = title;
      button.element.setAttribute('aria-label', `${label}、キー ${key.label}`);
      button.element.setAttribute('aria-keyshortcuts', key.label);
      container.appendChild(button.element);
      return button;
    };
    addAction('進行方向', 'プログレード姿勢リセット（機首を進行方向へ即座に向ける）', K.progradeReset);
    addAction('ターゲット', '照準に近い敵を第一ターゲットにする', K.targetSelect).element.classList.add('is-target');
  }

  // 推力段 1-4 の SegmentedControl を組み立てて status-throttle-touch プレースホルダへ足す。
  // 表示可否は CSS(body.touch-ui-active)側が持つ — ここでは常に組む。
  private buildThrottleControl(): SegmentedControl<number> {
    const container = this.els.get('status-throttle-touch');
    const control = new SegmentedControl<number>(
      '並進出力',
      THROTTLE_KEYS.map((key, i) => [i, `${key.label} ${THROTTLE_LABELS[i]!}`] as const),
      (index) => this.view?.tapKey(THROTTLE_KEYS[index]!),
    );
    container.appendChild(control.element);
    return control;
  }

  // モードのボタン列を組み立てて status-modes-touch プレースホルダへ足す。表示可否は CSS が持つ。
  private buildModeButtons(): readonly Button[] {
    const container = this.els.get('status-modes-touch');
    return TOUCH_MODES.map(({ label, key }) => {
      const button = new Button(label, () => this.view?.tapKey(key));
      button.element.setAttribute('aria-keyshortcuts', key.label);
      container.appendChild(button.element);
      return button;
    });
  }

  // 太陽電池パドル・放熱板1枚ぶんの展開/収納ボタンを組み立てる。面は「展開の点と左右の語・キーキャップ」。
  private buildDeployButton(
    partName: string, side: { label: string; key: string }, onClick: () => void,
  ): DeployButtonDom {
    const button = new Button('', onClick, undefined, ['dense', 'secondary']);
    const pip = document.createElement('span');
    pip.className = 'ui-pip';
    pip.textContent = side.label;
    button.element.replaceChildren(pip, createKeyCap(side.key));
    return { button, name: `${partName}${side.label}`, pip, lastText: '' };
  }

  // 展開部品1種の行([ラベル][左の面][右の面])を組む。
  private buildDeployRow(label: string, left: DeployButtonDom, right: DeployButtonDom): HTMLElement {
    const row = document.createElement('div');
    row.className = 'vessel-deploy-row';
    const labelEl = document.createElement('span');
    labelEl.className = 'ui-k';
    labelEl.textContent = label;
    row.append(labelEl, left.button.element, right.button.element);
    return row;
  }

  // 放熱板の損耗の行([ラベル][メーター][値])を container の末尾へ足す。
  private buildWearRow(container: HTMLElement, label: string): WearRowDom {
    // 行は損耗が出るまで畳んでおく。
    const row = document.createElement('div');
    row.className = 'ui-row hidden';
    const labelEl = document.createElement('span');
    labelEl.className = 'ui-k';
    labelEl.textContent = label;
    const gauge = document.createElement('span');
    gauge.className = 'ui-gauge';
    const meter = new Meter(label);
    meter.setMarks(WEAR_CAUTION_RATIO, WEAR_WARNING_RATIO);
    gauge.appendChild(meter.element);
    const value = document.createElement('output');
    value.className = 'ui-v';
    row.append(labelEl, gauge, value);
    container.appendChild(row);
    return { row, meter, value };
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

    const wearLevel = this.syncDeployParts(view);
    const fuelLevel = this.syncFuel(view);
    const tempLevel = this.syncTemperature(view);
    const qdynLevel = this.syncDynamicPressure(view);
    this.syncThrottle(view);
    this.syncModes(view);

    // 畳んだ見出しには、最も重い状態を残す。平常なら燃料の残量。
    const maxFuel = view.totalMaxFuel;
    const fuelPct = maxFuel > 0 ? Math.round((Math.max(0, Math.min(maxFuel, view.totalFuel)) / maxFuel) * 100) : 0;
    const candidates = [
      { level: fuelLevel, text: `燃料 ${fuelPct}%` },
      { level: tempLevel, text: `船体 ${view.temperatureK.toFixed(0)} K` },
      { level: qdynLevel, text: `動圧 ${this.dynamicPressureText(view)}` },
      { level: wearLevel.level, text: wearLevel.text },
    ];
    const worstLevel = worstAlarmLevel(fuelLevel, tempLevel, qdynLevel, wearLevel.level);
    const summary = candidates.find((entry) => entry.level === worstLevel)!;
    this.els.setText('hud-vessel-status-summary', summary.text);
    applyAlarmLevel(this.els.get('hud-vessel-status-summary'), summary.level);
  }

  // RCS 燃料の行を反映して段を返す。
  private syncFuel(view: VesselPanelViewModel): AlarmLevel {
    const maxFuel = view.totalMaxFuel;
    const clampedFuel = Math.max(0, Math.min(maxFuel, view.totalFuel));
    const level = view.fuelLevel;
    this.syncMeter(
      { meter: this.fuelMeter, value: this.els.get('rcs-fuel-value') },
      clampedFuel, maxFuel, { value: `${Math.round(clampedFuel)}`, unit: `/ ${Math.round(maxFuel)}` }, level,
    );
    return level;
  }

  // 船体温度の行を反映して段を返す。
  private syncTemperature(view: VesselPanelViewModel): AlarmLevel {
    const level = view.temperatureLevel;
    this.syncMeter(
      this.tempMeter, view.temperatureK, MAX_HULL_TEMP, { value: view.temperatureK.toFixed(0), unit: 'K' }, level,
    );
    return level;
  }

  // 動圧の行を反映して段を返す。大気を受けない操作対象では行ごと畳み、平常を返す。
  private syncDynamicPressure(view: VesselPanelViewModel): AlarmLevel {
    const qdyn = view.dynamicPressurePa;
    this.els.get('qdyn-row').classList.toggle('hidden', qdyn === null);
    if (qdyn === null) return 'normal';
    const level = view.dynamicPressureLevel;
    this.syncMeter(this.qdynMeter, qdyn, MAX_DYN_PRESSURE, this.dynamicPressureParts(qdyn), level);
    return level;
  }

  // 動圧 [Pa] の値と単位。
  private dynamicPressureParts(qdyn: number): { value: string; unit: string } {
    return qdyn >= 1000
      ? { value: (qdyn / 1000).toFixed(2), unit: 'kPa' }
      : { value: qdyn.toFixed(0), unit: 'Pa' };
  }

  // 見出しの要約に出す動圧の文字列。
  private dynamicPressureText(view: VesselPanelViewModel): string {
    const parts = this.dynamicPressureParts(view.dynamicPressurePa ?? 0);
    return `${parts.value} ${parts.unit}`;
  }

  // 並進出力の行と、タッチの推力段の選択を反映する。
  private syncThrottle(view: VesselPanelViewModel): void {
    const throttleIdx = view.throttleIdx;
    this.syncMeter(
      this.throttleMeter,
      throttleIdx + 1,
      THROTTLE_LEVELS.length,
      { value: THROTTLE_LABELS[throttleIdx]!, unit: `${THROTTLE_LEVELS[throttleIdx]!.toFixed(1)} m/s²` },
      'normal',
    );
    this.throttleControl.setSelected(throttleIdx);
  }

  // 制動・微調整・進行方向ホールドの状態を、行のピップとタッチのボタンの点灯へ反映する。
  // 自分が掛けているモードなので、ピップは自分の色で点灯する。
  private syncModes(view: VesselPanelViewModel): void {
    const states = [view.rcsDamp, view.fineAttitude, view.progradeHold];
    setStatePip(this.els.get('rcs'), view.rcsDamp, true);
    setStatePip(this.els.get('fine'), view.fineAttitude, true);
    setStatePip(this.els.get('prohold'), view.progradeHold, true);
    this.modeButtons.forEach((button, i) => button.setOn(states[i]!));
  }

  // now/max の実数からメーターの満ち幅・段・aria 属性を反映し、値の要素へ「値 単位」と段を書く。
  private syncMeter(
    dom: VesselMeterDom, now: number, max: number, parts: { value: string; unit: string }, level: AlarmLevel,
  ): void {
    dom.meter.setProgress(now, max, `${parts.value} ${parts.unit}`, level);
    applyAlarmLevel(dom.value, level);
    setReadout(dom.value, parts.value, parts.unit);
  }

  // 太陽電池パドルと放熱板を同期する。どちらかを積んでいなければ区画ごと畳む。
  // 放熱板の損耗の最も重い段と、その要約の文字列を返す。
  private syncDeployParts(view: VesselPanelViewModel): { level: AlarmLevel; text: string } {
    const { solar, radiator } = view;
    this.els.get('vessel-deploy-controls').classList.toggle('hidden', solar === null || radiator === null);
    if (!solar || !radiator) return { level: 'normal', text: '' };

    // 展開の状態と、損耗が出ている放熱板の行。
    this.syncDeployButton(this.solarButtons.up, solar.up);
    this.syncDeployButton(this.solarButtons.down, solar.down);
    this.syncDeployButton(this.radiatorButtons.up, radiator.up);
    this.syncDeployButton(this.radiatorButtons.down, radiator.down);
    this.syncWearRow(this.radiatorWearRows.up, radiator.up.wear);
    this.syncWearRow(this.radiatorWearRows.down, radiator.down.wear);
    const worstWear = Math.max(radiator.up.wear, radiator.down.wear);
    return { level: wearAlarmLevel(worstWear), text: `放熱板 損耗 ${Math.round(worstWear * 100)}%` };
  }

  // 展開度をボタンの点灯・点・読み上げ名へ同期する。
  private syncDeployButton(dom: DeployButtonDom, state: DeployState): void {
    const deployed = state.deploy >= 0.5;
    dom.button.setOn(deployed);
    dom.pip.classList.toggle('on', deployed);
    const stateText = deployed ? '展開' : '収納';
    if (dom.lastText === stateText) return;
    dom.lastText = stateText;
    const text = `${dom.name} ${stateText}`;
    dom.button.element.title = `${text}（クリックで${deployed ? '収納' : '展開'}）`;
    dom.button.element.setAttribute('aria-label', `${text}。クリックで${deployed ? '収納' : '展開'}`);
  }

  // 損耗度 wear(0〜1)を行へ反映する。損耗が無ければ行を畳む。
  private syncWearRow(dom: WearRowDom, wear: number): void {
    dom.row.classList.toggle('hidden', !(wear > 0));
    if (!(wear > 0)) return;
    const level = wearAlarmLevel(wear);
    const percent = `${Math.round(wear * 100)}`;
    dom.meter.setProgress(wear, 1, `${percent} %`, level);
    applyAlarmLevel(dom.value, level);
    dom.row.classList.toggle('ui-warning-fill', level === 'warning');
    setReadout(dom.value, percent, '%');
  }
}
