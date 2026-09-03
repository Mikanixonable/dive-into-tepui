// ステージ固有の状況表示パネル(左部: ステージ補助メッセージ・撃墜数 / 中央部: 自機の装甲・温度・電力)。
// 表示内容がステージごとに決まるので Stage が所有する。

import type { Player } from '../../player/player';
import { fmtEnergy } from '../../../hud/utils';
import { Meter } from '../../../hud/widgets';
import { MAX_HULL_TEMP } from '../../dynamic/dynamic-entity/ship';
import { POWER_CAPACITY } from '../../player/power';

const LOW_HP_RATIO = 0.3;

export class StatusPanel {
  private readonly panel: HTMLElement;
  private readonly leftText: HTMLElement;
  private readonly leftWidgets: HTMLElement;
  private readonly centerCol: HTMLElement;
  private lastLeftHtml = '';
  private readonly hpMeter: Meter;
  private readonly tempMeter: Meter;
  private readonly powerMeter: Meter;

  // 非表示状態のパネル DOM を組み立てて root に追加する
  constructor(root: HTMLElement) {
    this.panel = document.createElement('div');
    this.panel.id = 'hud-stagestatus';
    this.panel.className = 'panel hidden';
    this.panel.innerHTML =
      `<div class="k"><div class="k-text"></div><div class="k-widgets"></div></div>` +
      `<div class="t"></div>`;
    this.leftText = this.panel.querySelector<HTMLElement>('.k-text')!;
    this.leftWidgets = this.panel.querySelector<HTMLElement>('.k-widgets')!;
    this.centerCol = this.panel.querySelector<HTMLElement>('.t')!;
    root.appendChild(this.panel);

    this.hpMeter = this.buildMeterRow('装甲');
    this.tempMeter = this.buildMeterRow('温度');
    this.powerMeter = this.buildMeterRow('電力');
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

  // 毎フレーム(sync 時)呼ぶ。player が null ならパネルを畳む。DOM の書き換えは
  // 内容が変わったフレームだけに絞る。
  sync(player: Player | null, message: string, kills: number): void {
    this.panel.classList.toggle('hidden', !player);
    if (!player) return;

    const { hp, maxHp } = player;
    const low = hp <= maxHp * LOW_HP_RATIO;
    const temp = Math.round(player.temperature);
    const tempHigh = temp > 0.7 * MAX_HULL_TEMP;
    const chargeJ = player.power.chargeJ;

    this.hpMeter.setRatio(hp / maxHp);
    this.hpMeter.setDanger(low);
    this.hpMeter.setLabel(`${Math.floor(hp)} / ${maxHp}`);

    this.tempMeter.setRatio(temp / MAX_HULL_TEMP);
    this.tempMeter.setDanger(tempHigh);
    this.tempMeter.setLabel(`${temp} / ${MAX_HULL_TEMP} K`);

    this.powerMeter.setRatio(player.power.chargeRatio);
    this.powerMeter.setLabel(`${fmtEnergy(chargeJ)} / ${fmtEnergy(POWER_CAPACITY)}`);

    this.centerCol.classList.toggle('warn', low);

    const leftHtml = message ? `<div>${message}</div><div>撃墜 ${kills}</div>` : `<div>撃墜 ${kills}</div>`;
    if (this.lastLeftHtml !== leftHtml) {
      this.leftText.innerHTML = leftHtml;
      this.lastLeftHtml = leftHtml;
    }
    this.panel.classList.remove('hidden');
  }

  // root へ追加したパネル DOM を取り除く。左部ウィジェット枠に他クラスが差し込んだ要素も
  // その配下なので一緒に消える。
  dispose(): void {
    this.panel.remove();
  }
}
