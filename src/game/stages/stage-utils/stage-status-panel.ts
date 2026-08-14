// ステージ固有の状況表示パネル(左部: ステージ補助メッセージ・撃墜数 / 中央部: 自機の装甲・エンジン出力・
// 動圧・温度・電力 / 右部: ラジエーター左右の展開ボタン)。表示内容がステージごとに決まるので Stage が所有し、
// hudSubStatus() を返すステージでだけ現れる。CSS(#hud-stagestatus)は hud/hud-root.ts の STYLE に一元管理されている。

const LOW_HP_RATIO = 0.3;
const RADIATOR_HIGH_WEAR = 0.5;
import * as C from '../../const';
import type { Player } from '../../player/player';
import type { RadiatorSide } from '../../player/radiator';
import { KEY_MAPPING as K } from '../../input/key-mapping';
import { fmtEnergy } from '../../hud/utils';
import { DANGER } from '../../theme';
import { Button, Meter } from '../../hud/widgets';

// side を「左(+X)/右(-X)」ラベルとショートカットキーへ対応させる。
// (機体の+Zが前なので、後ろから見ると+Xは左になる)
const RADIATOR_UI: Record<RadiatorSide, { label: string; key: string }> = {
  up: { label: '左', key: K.radiatorDeployLeft.label },
  down: { label: '右', key: K.radiatorDeployRight.label },
};

import type { SolarSide } from '../../player/power';
const SOLAR_UI: Record<SolarSide, { label: string; key: string }> = {
  up: { label: '左', key: K.solarDeployLeft.label },
  down: { label: '右', key: K.solarDeployRight.label },
};

interface RadiatorButtonDom {
  readonly button: Button;
  readonly fill: HTMLElement;
  readonly label: HTMLElement;
  lastText: string;
  lastFillWidth: string;
  lastFillColor: string;
}

export class StageStatusPanel {
  private readonly panel: HTMLElement;
  private readonly leftText: HTMLElement;
  private readonly leftWidgets: HTMLElement;
  private readonly centerCol: HTMLElement;
  private lastLeftHtml = '';
  private player: Player | null = null;

  // ラジエーターボタンだけは展開/収納のクリックリスナを保つため、innerHTML の再構築対象から
  // 外した永続 DOM にしてある
  private readonly radiatorButtons: Record<RadiatorSide, RadiatorButtonDom>;
  private readonly solarButtons: Record<SolarSide, RadiatorButtonDom>;
  private readonly hpMeter: Meter;
  private readonly throttleMeter: Meter;
  private readonly qdynMeter: Meter;
  private readonly tempMeter: Meter;
  private readonly powerMeter: Meter;

  // 非表示状態のパネル DOM を組み立てて root に追加する
  constructor(root: HTMLElement) {
    this.panel = document.createElement('div');
    this.panel.id = 'hud-stagestatus';
    this.panel.className = 'panel hidden';
    this.panel.innerHTML =
      `<div class="k"><div class="k-text"></div><div class="k-widgets"></div></div>` +
      `<div class="t"></div><div class="radiators"></div>`;
    this.leftText = this.panel.querySelector<HTMLElement>('.k-text')!;
    this.leftWidgets = this.panel.querySelector<HTMLElement>('.k-widgets')!;
    this.centerCol = this.panel.querySelector<HTMLElement>('.t')!;
    root.appendChild(this.panel);

    this.hpMeter = this.buildMeterRow('装甲');
    this.throttleMeter = this.buildMeterRow('出力');
    this.qdynMeter = this.buildMeterRow('動圧');
    this.tempMeter = this.buildMeterRow('温度');
    this.powerMeter = this.buildMeterRow('電力');

    const radiatorsCol = this.panel.querySelector<HTMLElement>('.radiators')!;
    this.solarButtons = {
      up: this.buildButton(radiatorsCol, () => this.player?.power.toggle('up')),
      down: this.buildButton(radiatorsCol, () => this.player?.power.toggle('down')),
    };
    this.radiatorButtons = {
      up: this.buildButton(radiatorsCol, () => this.player?.radiator.toggle('up')),
      down: this.buildButton(radiatorsCol, () => this.player?.radiator.toggle('down')),
    };
  }

  // ステージ固有の UI(トグル等)を左部へ永続的に追加する。sync の innerHTML 書き換え対象外。
  appendLeftWidget(el: HTMLElement): void {
    this.leftWidgets.appendChild(el);
  }

  // 見出し + Meter の1行を centerCol へ足す。
  private buildMeterRow(label: string): Meter {
    const heading = document.createElement('span');
    heading.textContent = label;
    this.centerCol.appendChild(heading);
    const meter = new Meter();
    this.centerCol.appendChild(meter.element);
    return meter;
  }

  // 1枚ぶんの展開/収納ボタンを組み立て、以後の更新に使う要素を返す。
  private buildButton(col: HTMLElement, onClick: () => void): RadiatorButtonDom {
    const button = new Button('', onClick);
    button.element.classList.add('radiator-btn');
    button.element.innerHTML = `<div class="fill"></div><div class="label"></div>`;
    col.appendChild(button.element);

    return {
      button,
      fill: button.element.querySelector<HTMLElement>('.fill')!,
      label: button.element.querySelector<HTMLElement>('.label')!,
      lastText: '',
      lastFillWidth: '',
      lastFillColor: '',
    };
  }

  // dom の表示を side の展開度・損耗度へ合わせる。着色部の幅は損耗度に応じて減る
  // (損耗ぶん = 失われた放熱能力ぶん、と読めるようにするため)。DOM の書き換えは値が
  // 動いたフレームだけに絞る。
  private syncButton(
    dom: RadiatorButtonDom,
    deploy: number,
    wear: number,
    name: string,
    uiConf: { label: string; key: string }
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
      dom.lastText = text;
    }
  }

  // 毎フレーム(sync 時)呼ぶ。player が null ならパネルを畳む。DOM の書き換えは
  // 内容が変わったフレームだけに絞る。
  sync(player: Player | null, message: string, kills: number): void {
    this.player = player;
    if (!player) {
      this.panel.style.display = 'none';
      return;
    }
    const { hp, maxHp } = player;
    const throttleIdx = player.throttleIdx;
    const low = hp <= maxHp * LOW_HP_RATIO;
    const throttleVal = C.THROTTLE_LEVELS[throttleIdx];
    const throttleText = `${C.THROTTLE_LABELS[throttleIdx]} (${throttleVal!.toFixed(1)} m/s²)`;
    const temp = Math.round(player.thermal.hullTemp);
    const tempHigh = temp > 0.7 * C.MAX_HULL_TEMP;
    const qdyn = player.thermal.qdyn;
    const qdynHigh = qdyn > 0.5 * C.MAX_DYN_PRESSURE;
    const qdynText = qdyn >= 1000 ? `${(qdyn / 1000).toFixed(2)} kPa` : `${qdyn.toFixed(0)} Pa`;
    const chargeJ = player.power.chargeJ;

    this.hpMeter.setRatio(hp / maxHp);
    this.hpMeter.setDanger(low);
    this.hpMeter.setLabel(`${Math.floor(hp)} / ${maxHp}`);

    this.throttleMeter.setRatio((throttleIdx + 1) / C.THROTTLE_LEVELS.length);
    this.throttleMeter.setLabel(throttleText);

    this.qdynMeter.setRatio(qdyn / C.MAX_DYN_PRESSURE);
    this.qdynMeter.setDanger(qdynHigh);
    this.qdynMeter.setLabel(qdynText);

    this.tempMeter.setRatio(temp / C.MAX_HULL_TEMP);
    this.tempMeter.setDanger(tempHigh);
    this.tempMeter.setLabel(`${temp} / ${C.MAX_HULL_TEMP} K`);

    this.powerMeter.setRatio(player.power.chargeRatio);
    this.powerMeter.setLabel(`${fmtEnergy(chargeJ)} / ${fmtEnergy(C.POWER_CAPACITY)}`);

    this.centerCol.classList.toggle('warn', low);

    const power = player.power;
    this.syncButton(this.solarButtons.up, power.deployOf('up'), 0, 'パドル', SOLAR_UI.up);
    this.syncButton(this.solarButtons.down, power.deployOf('down'), 0, 'パドル', SOLAR_UI.down);

    const radiator = player.radiator;
    this.syncButton(this.radiatorButtons.up, radiator.deployOf('up'), radiator.wearOf('up'), '放熱板', RADIATOR_UI.up);
    this.syncButton(this.radiatorButtons.down, radiator.deployOf('down'), radiator.wearOf('down'), '放熱板', RADIATOR_UI.down);

    const leftHtml = message ? `<div>${message}</div><div>撃墜 ${kills}</div>` : `<div>撃墜 ${kills}</div>`;
    if (this.lastLeftHtml !== leftHtml) {
      this.leftText.innerHTML = leftHtml;
      this.lastLeftHtml = leftHtml;
    }
    this.panel.classList.remove('hidden');
  }
}
