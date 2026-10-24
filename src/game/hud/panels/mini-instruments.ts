// 常時小計器。スマホ横持ち(レールの無い幅)で、画面の上の両端へ常に出す2枚の小さな計器: 左は位置と速度
// (マップでは遠地点・近地点も)、右は RCS 燃料・並進出力・船体温度。値は常設パネル(軌道情報・艦のステータス)
// と同じ値・同じ行の文法で、細い中立のメーターが閾値を越えたときだけ色を帯びる。シートの中身を複製せず、
// 「いまの判断に要る読み値」だけを抜く。レールのある幅では CSS が出さない。
import { applyAlarmLevel, type AlarmLevel } from '../../../hud/alarm-level';
import { fmtDistParts, fmtSpeedParts } from '../../../hud/utils';
import { setReadout } from '../../../hud/readout';
import { Meter } from '../../../hud/widgets';
import { instrumentRowHtml } from '../../../hud/instrument-row';
import {
  FUEL_CAUTION_RATIO, FUEL_WARNING_RATIO, TEMPERATURE_CAUTION_RATIO, TEMPERATURE_WARNING_RATIO,
} from '../../alarm/alarm-level';
import { MAX_HULL_TEMP } from '../../dynamic/dynamic-entity/combat-ship-entity';
import { THROTTLE_LABELS, THROTTLE_LEVELS } from '../../player/throttle';
import { getApsisLabelSpec } from '../orbit/orbit-labels';
import { SyncThrottle } from '../sync-throttle';
import type { HudEls, HudElId } from '../hud-els';
import type { OrbitPanelViewModel } from '../orbit/orbit-panel';
import type { VesselPanelViewModel } from './vessel-panel';

const SYNC_INTERVAL_MS = 100;

// 左右の小計器の中身(HTML)。置き場(親要素)は hud-root が決める。
export const MINI_LEFT_HTML = `
  <div class="ui-readout is-s">
    <output class="ui-readout-value" data-id="mini-alt">—</output>
    <span class="ui-readout-cap">高度</span>
  </div>
  <div class="ui-rows">
    ${instrumentRowHtml({ label: '速度', valueId: 'mini-spd' })}
    ${instrumentRowHtml({ label: '遠地点', labelId: 'mini-ap-label', rowId: 'mini-ap-row', valueId: 'mini-ap' })}
    ${instrumentRowHtml({ label: '近地点', labelId: 'mini-pe-label', rowId: 'mini-pe-row', valueId: 'mini-pe' })}
  </div>`;

export const MINI_RIGHT_HTML = `
  <div class="ui-rows">
    ${instrumentRowHtml({ label: '燃料', gaugeId: 'mini-fuel-gauge', valueId: 'mini-fuel-value' })}
    ${instrumentRowHtml({ label: '出力', gaugeId: 'mini-throttle-gauge', valueId: 'mini-throttle-value' })}
    ${instrumentRowHtml({ label: '船体', gaugeId: 'mini-temp-gauge', valueId: 'mini-temp-value' })}
  </div>`;

// メーターと、その右の値の要素の組。
interface MiniMeterDom {
  readonly meter: Meter;
  readonly value: HTMLElement;
}

export class MiniInstruments {
  private readonly throttle = new SyncThrottle(SYNC_INTERVAL_MS);
  private readonly fuel: MiniMeterDom;
  private readonly output: MiniMeterDom;
  private readonly temperature: MiniMeterDom;

  // els が指す小計器の DOM へ、燃料・出力・船体温度のメーターを組み込む。
  public constructor(private readonly els: HudEls) {
    this.fuel = this.buildMeter('mini-fuel-gauge', 'mini-fuel-value', '燃料');
    this.fuel.meter.setMarks(FUEL_CAUTION_RATIO, FUEL_WARNING_RATIO);
    this.output = this.buildMeter('mini-throttle-gauge', 'mini-throttle-value', '並進出力');
    this.temperature = this.buildMeter('mini-temp-gauge', 'mini-temp-value', '船体温度');
    this.temperature.meter.setMarks(TEMPERATURE_CAUTION_RATIO, TEMPERATURE_WARNING_RATIO);
  }

  // メーターを gaugeId の要素へ差し込み、値の要素 valueId と組にして返す。
  private buildMeter(gaugeId: HudElId, valueId: HudElId, label: string): MiniMeterDom {
    const meter = new Meter(label);
    this.els.get(gaugeId).appendChild(meter.element);
    return { meter, value: this.els.get(valueId) };
  }

  // 操作対象の位置・速度と、艦の燃料・出力・船体温度を反映する。値の無い側は枠ごと隠す。
  public sync(orbit: OrbitPanelViewModel | null, vessel: VesselPanelViewModel | null, nowMs: number): void {
    this.els.get('hud-mini-left').classList.toggle('hidden', orbit === null);
    this.els.get('hud-mini-right').classList.toggle('hidden', vessel === null);
    if (!this.throttle.due(nowMs)) return;
    if (orbit !== null) this.syncOrbit(orbit);
    if (vessel !== null) this.syncVessel(vessel);
  }

  // 高度・速度と、遠地点・近地点(マップでだけ CSS が出す行)を反映する。
  private syncOrbit(view: OrbitPanelViewModel): void {
    // 高度は降下の警告を段で示し、速度は段を持たない。
    const altitude = this.els.get('mini-alt');
    const parts = fmtDistParts(view.altitudeM);
    setReadout(altitude, parts.value, parts.unit);
    applyAlarmLevel(altitude, view.altitudeLevel);
    const speed = fmtSpeedParts(view.speedMps);
    setReadout(this.els.get('mini-spd'), speed.value, speed.unit);
    for (const [kind, labelId, valueId, meters] of [
      ['ap', 'mini-ap-label', 'mini-ap', view.apAltitudeM],
      ['pe', 'mini-pe-label', 'mini-pe', view.peAltitudeM],
    ] as const) {
      const spec = getApsisLabelSpec(kind, view.centerId);
      setReadout(this.els.get(labelId), spec.nameJa, spec.short);
      const apsis = fmtDistParts(meters);
      setReadout(this.els.get(valueId), apsis.value, apsis.unit);
    }
  }

  // 燃料・並進出力・船体温度の行を反映する。
  private syncVessel(view: VesselPanelViewModel): void {
    const maxFuel = view.totalMaxFuel;
    const fuel = Math.max(0, Math.min(maxFuel, view.totalFuel));
    this.syncMeter(this.fuel, fuel, maxFuel, `${Math.round(fuel)}`, '', view.fuelLevel);
    this.syncMeter(
      this.output, view.throttleIdx + 1, THROTTLE_LEVELS.length, THROTTLE_LABELS[view.throttleIdx]!, '', 'normal',
    );
    this.syncMeter(this.temperature, view.temperatureK, MAX_HULL_TEMP, view.temperatureK.toFixed(0), 'K', view.temperatureLevel);
  }

  // now/max からメーターの満ち幅と段を、値の要素へ「値 単位」と段を書く。
  private syncMeter(dom: MiniMeterDom, now: number, max: number, value: string, unit: string, level: AlarmLevel): void {
    dom.meter.setProgress(now, max, `${value} ${unit}`.trim(), level);
    applyAlarmLevel(dom.value, level);
    setReadout(dom.value, value, unit);
  }
}
