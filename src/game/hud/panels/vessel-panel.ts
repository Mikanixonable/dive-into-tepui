// 常設 VESSEL パネル(#hud-status)の同期: RCS燃料・出力・動圧・太陽電池パドル・放熱板・RCS制動・微調整・
// 進行方向ホールド・視点のRCS追従・弾薬。自機が無ければ隠す。
// 装填/姿勢リセット/視点追従切替/ターゲット選択の4操作と、タッチ時のみのスロットル段は、
// キー押下と同じ経路(Input.tapKey)で発火するボタンとして
// ここに持つ — タッチでも到達できるようにするための、キー入力の代替 UI。
import * as C from '../../const';
import { KEY_MAPPING as K } from '../../input/key-mapping';
import { Button, SegmentedControl } from '../widgets';
import { fmtAmmoStatus } from '../utils';
import type { Game } from '../../game';
import type { Input } from '../../input/input';
import type { KeyBinding } from '../../input/key-mapping';
import { Player } from '../../player/player';
import type { RadiatorSide } from '../../player/radiator';
import type { SolarSide } from '../../player/power';
import { Base } from '../../game-entity/base';
import { DANGER } from '../../theme';

const SYNC_INTERVAL_MS = 100;

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

interface VesselMeterDom {
  readonly meter: HTMLElement;
  readonly fill: HTMLElement;
  readonly value: HTMLElement;
}

interface DeployButtonDom {
  readonly button: Button;
  readonly fill: HTMLElement;
  readonly label: HTMLElement;
  lastText: string;
  lastFillWidth: string;
  lastFillColor: string;
}

export class VesselPanel {
  private nextSyncAt = 0;
  private input: Input | null = null;
  private player: Player | null = null;
  private followButton: Button | null = null;
  private readonly throttleControl: SegmentedControl<number> | null;
  private readonly throttleMeter: VesselMeterDom | null;
  private readonly qdynMeter: VesselMeterDom | null;
  private readonly solarButtons: Record<SolarSide, DeployButtonDom> | null;
  private readonly radiatorButtons: Record<RadiatorSide, DeployButtonDom> | null;

  public constructor(private readonly els: ReadonlyMap<string, HTMLElement>) {
    this.throttleMeter = this.buildMeter('throttle-readout', '並進出力');
    this.qdynMeter = this.buildMeter('qdyn-readout', '動圧');
    this.buildActionButtons();
    this.throttleControl = this.buildThrottleControl();
    const deployContainer = this.els.get('vessel-deploy-controls');
    this.solarButtons = this.buildSolarButtons(deployContainer);
    this.radiatorButtons = this.buildRadiatorButtons(deployContainer);
  }

  // Vessel パネルの既存バー(RCS燃料)と同じ、トラック+右寄せ値のバーを組み立てる。
  private buildMeter(readoutId: string, label: string): VesselMeterDom | null {
    const readout = this.els.get(readoutId);
    if (!readout) return null;
    const meter = document.createElement('span');
    meter.className = 'vessel-meter w-meter-track';
    meter.setAttribute('role', 'progressbar');
    meter.setAttribute('aria-label', label);
    meter.setAttribute('aria-valuemin', '0');
    const fill = document.createElement('span');
    fill.className = 'w-meter-fill';
    const value = document.createElement('output');
    value.className = 'vessel-meter-value';
    value.textContent = '—';
    meter.appendChild(fill);
    readout.appendChild(meter);
    readout.appendChild(value);
    return { meter, fill, value };
  }

  // 操作の受け口となる Input を差し込む。ボタン構築時にはまだ存在しないための late injection で、
  // null は「今は受け口が無い」— このパネルは Game より長生きするので、その状態が実在する。
  public setInput(input: Input | null): void {
    this.input = input;
  }

  // R/F/G/T の代替操作ボタンを組み立てて status-actions プレースホルダへ足す。
  private buildActionButtons(): void {
    const container = this.els.get('status-actions');
    if (!container) return;
    const addAction = (label: string, title: string, key: KeyBinding, isPrimary = false): Button => {
      const button = new Button(label, () => this.input?.tapKey(key));
      button.element.title = title;
      button.element.setAttribute('aria-label', `${label}、キー ${key.label}`);
      button.element.setAttribute('aria-keyshortcuts', key.label);
      button.element.classList.toggle('status-action-primary', isPrimary);
      container.appendChild(button.element);
      return button;
    };
    addAction(
      `進行方向 [${K.progradeReset.label}]`,
      'プログレード姿勢リセット（機首を進行方向へ即座に向ける）',
      K.progradeReset,
    );
    this.followButton = addAction(
      `視点追従 [${K.followAttitudeToggle.label}]`,
      '視点のRCS追従を切り替える',
      K.followAttitudeToggle,
    );
    addAction(
      `ターゲット [${K.targetSelect.label}]`,
      '照準に近い敵を第一ターゲットにする',
      K.targetSelect,
      true,
    );
    addAction(`装填 [${K.reload.label}]`, 'マニュアル装填', K.reload);
  }

  // スロットル 1-4 の SegmentedControl を組み立てて status-throttle-touch プレースホルダへ足す。
  // 表示可否は CSS(body.touch-ui-active)側が持つ — ここでは常に組む。
  private buildThrottleControl(): SegmentedControl<number> | null {
    const container = this.els.get('status-throttle-touch');
    if (!container) return null;
    const control = new SegmentedControl<number>(
      '推力段', THROTTLE_KEYS.map((key, i) => [i, key.label] as const),
      (index) => this.input?.tapKey(THROTTLE_KEYS[index]!),
    );
    container.appendChild(control.element);
    return control;
  }

  private buildSolarButtons(container: HTMLElement | undefined): Record<SolarSide, DeployButtonDom> | null {
    if (!container) return null;
    return {
      up: this.buildDeployButton(container, () => this.player?.power.toggle('up')),
      down: this.buildDeployButton(container, () => this.player?.power.toggle('down')),
    };
  }

  private buildRadiatorButtons(container: HTMLElement | undefined): Record<RadiatorSide, DeployButtonDom> | null {
    if (!container) return null;
    return {
      up: this.buildDeployButton(container, () => this.player?.radiator.toggle('up')),
      down: this.buildDeployButton(container, () => this.player?.radiator.toggle('down')),
    };
  }

  // 太陽電池パドル・放熱板1枚ぶんの展開/収納ボタンを組み立て、以後の更新に使う要素を返す。
  private buildDeployButton(container: HTMLElement, onClick: () => void): DeployButtonDom {
    const button = new Button('', onClick);
    button.element.classList.add('vessel-deploy-btn');
    button.element.innerHTML = '<div class="fill"></div><div class="label"></div>';
    container.appendChild(button.element);

    return {
      button,
      fill: button.element.querySelector<HTMLElement>('.fill')!,
      label: button.element.querySelector<HTMLElement>('.label')!,
      lastText: '',
      lastFillWidth: '',
      lastFillColor: '',
    };
  }

  public sync(game: Game): void {
    const target = game.activeControllableEntity;
    this.player = target instanceof Player ? target : null;
    if (!target) {
      document.getElementById('hud-vessel-status')?.classList.add('hidden');
      return;
    }
    // 通常のマップビューでは艦固有の情報をプロパティウィンドウで参照するので畳む。
    // クリエイティブでは配置後の艦を常に操作できるため、マップビューでも VESSEL を表示する。
    // CSS 側でも同じ条件を持つが、未配置状態からの復帰時は JS で明示的に戻す。
    if (!game.cameraSystem.overviewMode || game.activeStage.id === 'creative') {
      document.getElementById('hud-vessel-status')?.classList.remove('hidden');
    }

    const now = performance.now();
    if (now < this.nextSyncAt) return;
    this.nextSyncAt = now + SYNC_INTERVAL_MS;

    const throttleObj = target instanceof Player ? target : (target instanceof Base ? target : null);
    this.syncDeployButtons();
    if (!throttleObj) return;

    this.syncState('rcs', throttleObj.throttle.rcsDamp, 'near');
    const throttleIdx = throttleObj.throttle.throttleIdx;
    this.syncMeter(
      this.throttleMeter,
      (throttleIdx + 1) / C.THROTTLE_LEVELS.length,
      `${C.THROTTLE_LABELS[throttleIdx]} (${C.THROTTLE_LEVELS[throttleIdx]!.toFixed(1)} m/s²)`,
      C.THROTTLE_LEVELS.length,
      throttleIdx + 1,
      false,
    );
    this.throttleControl?.setSelected(throttleIdx);
    const qdynRow = this.els.get('qdyn-row');
    const hasQdyn = target instanceof Player;
    qdynRow?.classList.toggle('hidden', !hasQdyn);
    if (hasQdyn) {
      const qdyn = target.aero.qdyn;
      const qdynText = qdyn >= 1000 ? `${(qdyn / 1000).toFixed(2)} kPa` : `${qdyn.toFixed(0)} Pa`;
      this.syncMeter(
        this.qdynMeter,
        qdyn / C.MAX_DYN_PRESSURE,
        qdynText,
        C.MAX_DYN_PRESSURE,
        qdyn,
        qdyn > 0.5 * C.MAX_DYN_PRESSURE,
      );
    }
    const fineAtt = target instanceof Player ? target.fineAttitude : false;
    this.syncState('fine', fineAtt, 'near');
    const cameraFollowsAttitude = game.cameraSystem.combatCamera.camFollowAttitude;
    this.syncState('camfollow', cameraFollowsAttitude, 'signal');
    this.followButton?.setOn(cameraFollowsAttitude);
    this.syncState('prohold', throttleObj.throttle.progradeHold, 'near');

    let currentFuel = 0;
    let maxFuel = 0;
    if (target instanceof Player) {
      currentFuel = target.totalFuel;
      maxFuel = target.totalMaxFuel;
    } else if (target instanceof Base) {
      currentFuel = target.fuel;
      maxFuel = target.maxFuel;
    }

    const clampedFuel = Math.max(0, Math.min(maxFuel, currentFuel));
    const fuelPercent = maxFuel > 0 ? (clampedFuel / maxFuel) * 100 : 0;
    const fuelValueText = `${Math.round(clampedFuel)} / ${Math.round(maxFuel)}`;

    const fuelMeter = this.els.get('rcs-fuel-meter');
    if (fuelMeter) {
      fuelMeter.setAttribute('aria-valuemax', String(maxFuel));
      fuelMeter.setAttribute('aria-valuenow', String(clampedFuel));
      fuelMeter.setAttribute('aria-valuetext', fuelValueText);
    }
    const fuelFill = this.els.get('rcs-fuel-fill');
    if (fuelFill) {
      fuelFill.style.width = `${fuelPercent.toFixed(1)}%`;
      fuelFill.classList.toggle('danger', maxFuel > 0 && clampedFuel < maxFuel * 0.2);
    }
    this.setText('rcs-fuel-value', fuelValueText);

    const ammo = this.els.get('ammo');
    if (ammo) {
      if (target instanceof Player) {
        ammo.textContent = fmtAmmoStatus(target.roundsInMag, target.magsLeft, target.reloadTimer);
        ammo.classList.toggle('warn-hot', target.reloadTimer > 0 || target.magsLeft < 4);
      } else if (target instanceof Base) {
        ammo.textContent = `Fuel: ${Math.round(target.fuel)} / ${target.maxFuel}`;
        ammo.classList.toggle('warn-hot', target.fuel < target.maxFuel * 0.2);
      }
    }
  }

  // id 要素のテキストを、変化があるときだけ書き換える。
  private setText(id: string, text: string): void {
    const element = this.els.get(id);
    if (element && element.textContent !== text) element.textContent = text;
  }

  private syncMeter(
    dom: VesselMeterDom | null, ratio: number, label: string, max: number, now: number, critical: boolean,
  ): void {
    if (!dom) return;
    const clampedRatio = Math.max(0, Math.min(1, ratio));
    dom.fill.style.width = `${(clampedRatio * 100).toFixed(1)}%`;
    dom.fill.classList.toggle('danger', critical);
    dom.meter.setAttribute('aria-valuemax', String(max));
    dom.meter.setAttribute('aria-valuenow', String(now));
    dom.meter.setAttribute('aria-valuetext', label);
    if (dom.value.textContent !== label) dom.value.textContent = label;
  }

  // 展開度・損耗度をボタンへ同期する。損耗ぶんは放熱板だけの表示なので、パドルには0を渡す。
  private syncDeployButton(
    dom: DeployButtonDom,
    deploy: number,
    wear: number,
    name: string,
    uiConf: { label: string; key: string },
  ): void {
    const deployed = deploy >= 0.5;
    const wearPct = Math.round(wear * 100);
    const highWear = wearPct > RADIATOR_HIGH_WEAR * 100;

    dom.button.setOn(deployed);

    const fillWidth = `${100 - wearPct}%`;
    const fillColor = highWear ? DANGER : 'transparent';
    if (dom.lastFillWidth !== fillWidth) {
      dom.fill.style.width = fillWidth;
      dom.lastFillWidth = fillWidth;
    }
    if (dom.lastFillColor !== fillColor) {
      dom.fill.style.background = fillColor;
      dom.lastFillColor = fillColor;
    }

    const text = `${name}${uiConf.label}[${uiConf.key}] ${deployed ? '展開' : '収納'}${wear > 0 ? ` / 損耗${wearPct}%` : ''}`;
    if (dom.lastText !== text) {
      dom.label.textContent = text;
      dom.button.element.title = `${text}（クリックで${deployed ? '収納' : '展開'}）`;
      dom.button.element.setAttribute('aria-label', `${text}。クリックで${deployed ? '収納' : '展開'}`);
      dom.lastText = text;
    }
  }

  private syncDeployButtons(): void {
    const container = this.els.get('vessel-deploy-controls');
    const player = this.player;
    container?.classList.toggle('hidden', player === null);
    if (!player || !this.solarButtons || !this.radiatorButtons) return;

    this.syncDeployButton(this.solarButtons.up, player.power.deployOf('up'), 0, 'パドル', SOLAR_UI.up);
    this.syncDeployButton(this.solarButtons.down, player.power.deployOf('down'), 0, 'パドル', SOLAR_UI.down);
    this.syncDeployButton(
      this.radiatorButtons.up, player.radiator.deployOf('up'), player.radiator.wearOf('up'), '放熱板', RADIATOR_UI.up,
    );
    this.syncDeployButton(
      this.radiatorButtons.down, player.radiator.deployOf('down'), player.radiator.wearOf('down'), '放熱板', RADIATOR_UI.down,
    );
  }

  // 機体モードの状態語と色ロールを同期する。
  // Near は隣接する操縦支援、Signal は視点同期に使う。
  private syncState(id: string, isActive: boolean, role: 'near' | 'signal'): void {
    const element = this.els.get(id);
    if (!element) return;
    element.textContent = isActive ? 'On' : 'Off';
    element.classList.toggle('state-near', isActive && role === 'near');
    element.classList.toggle('state-signal', isActive && role === 'signal');
  }
}
