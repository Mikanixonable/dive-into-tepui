// ステージの補助メッセージ・撃墜数と、自機の装甲・温度・電力を示す状況パネル。

import type { ModularShip } from '../../ship/modular-ship';
import { fmtEnergy } from '../../../hud/utils';
import { Meter } from '../../../hud/widgets';
import { MAX_HULL_TEMP } from '../../dynamic/dynamic-entity/combat-ship-entity';
import { POWER_CAPACITY } from '../../player/power';
import {
  ARMOR_WARNING_RATIO, TEMPERATURE_CAUTION_RATIO, TEMPERATURE_WARNING_RATIO,
  armorAlarmLevel, temperatureAlarmLevel,
} from '../../alarm/alarm-level';

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
  public constructor(root: HTMLElement) {
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

    // 装甲と温度の警報段は、表示する物理量の境界に合わせる。
    this.hpMeter = this.buildMeterRow('装甲');
    this.hpMeter.setMarks(null, ARMOR_WARNING_RATIO);
    this.tempMeter = this.buildMeterRow('温度');
    this.tempMeter.setMarks(TEMPERATURE_CAUTION_RATIO, TEMPERATURE_WARNING_RATIO);
    this.powerMeter = this.buildMeterRow('電力');
  }

  // ステージ固有の UI(トグル等)を左部へ永続的に追加する。sync の innerHTML 書き換え対象外。
  public appendLeftWidget(el: HTMLElement): void {
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
  public sync(player: ModularShip | null, message: string, kills: number): void {
    this.panel.classList.toggle('hidden', !player);
    if (!player) return;

    const { hp, maxHp } = player;
    const temp = Math.round(player.motion.temperature);
    const chargeJ = player.motion.power.chargeJ;

    // 装甲・温度の表示値と警報段を同じ値から更新する。
    this.hpMeter.setRatio(hp / maxHp);
    this.hpMeter.setLevel(armorAlarmLevel(hp, maxHp));
    this.hpMeter.setLabel(`${Math.floor(hp)} / ${maxHp}`);

    this.tempMeter.setRatio(temp / MAX_HULL_TEMP);
    this.tempMeter.setLevel(temperatureAlarmLevel(temp, MAX_HULL_TEMP));
    this.tempMeter.setLabel(`${temp} / ${MAX_HULL_TEMP} K`);

    this.powerMeter.setRatio(player.motion.power.chargeRatio);
    this.powerMeter.setLabel(`${fmtEnergy(chargeJ)} / ${fmtEnergy(POWER_CAPACITY)}`);

    const leftHtml = message ? `<div>${message}</div><div>撃墜 ${kills}</div>` : `<div>撃墜 ${kills}</div>`;
    if (this.lastLeftHtml !== leftHtml) {
      this.leftText.innerHTML = leftHtml;
      this.lastLeftHtml = leftHtml;
    }
    this.panel.classList.remove('hidden');
  }

  // このパネルの DOM を破棄する。
  public dispose(): void {
    this.panel.remove();
  }
}
