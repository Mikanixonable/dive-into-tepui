// ステージ固有の状況表示パネル(左部: ステージ補助メッセージ・撃墜数 / 中央部: 自機の装甲・エンジン出力・
// 動圧・温度・電力 / 右部: ラジエーター左右の展開ボタン)。表示内容がステージごとに決まるので Stage が所有し、
// hudSubStatus() を返すステージでだけ現れる。CSS(#hud-stagestatus)は hud/dom.ts の STYLE に一元管理されている。

const LOW_HP_RATIO = 0.3;
const RADIATOR_HIGH_WEAR = 0.5;
import * as C from '../../const';
import type { Player } from '../../player/player';
import type { RadiatorSide } from '../../player/radiator';
import { KEY_MAPPING as K } from '../../input/key-mapping';
import { fmtEnergy } from '../../hud/utils';
import { ACCENT, BAR_BG, DANGER, FONT_XS, TEXT_STRONG, TRANSITION_FAST, BG, SPACE_2, SPACE_4 } from '../../theme';

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
  readonly button: HTMLElement;
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
  private lastHpHtml = '';
  private lastLeftHtml = '';
  private player: Player | null = null;

  // ラジエーターボタンだけは展開/収納のクリックリスナを保つため、innerHTML の再構築対象から
  // 外した永続 DOM にしてある
  private readonly radiatorButtons: Record<RadiatorSide, RadiatorButtonDom>;
  private readonly solarButtons: Record<SolarSide, RadiatorButtonDom>;

  // 非表示状態のパネル DOM を組み立てて root に追加する
  constructor(root: HTMLElement) {
    this.panel = document.createElement('div');
    this.panel.id = 'hud-stagestatus';
    this.panel.className = 'panel';
    this.panel.style.display = 'none';
    this.panel.innerHTML =
      `<div class="k"><div class="k-text"></div><div class="k-widgets"></div></div>` +
      `<div class="t"></div><div class="radiators"></div>`;
    this.leftText = this.panel.querySelector<HTMLElement>('.k-text')!;
    this.leftWidgets = this.panel.querySelector<HTMLElement>('.k-widgets')!;
    this.centerCol = this.panel.querySelector<HTMLElement>('.t')!;
    root.appendChild(this.panel);

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

  // 1枚ぶんの展開/収納ボタンを組み立て、以後の更新に使う要素を返す。
  private buildButton(col: HTMLElement, onClick: () => void): RadiatorButtonDom {
    const button = document.createElement('button');
    button.className = 'radiator-btn';
    button.innerHTML = `<div class="fill"></div><div class="label"></div>`;
    button.addEventListener('click', onClick);
    col.appendChild(button);

    return {
      button,
      fill: button.querySelector<HTMLElement>('.fill')!,
      label: button.querySelector<HTMLElement>('.label')!,
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
    
    dom.button.classList.toggle('on', deployed);

    const fillWidth = `${100 - wearPct}%`;
    const fillColor = highWear ? DANGER : deployed ? 'transparent' : 'transparent';
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

  // 毎フレーム(sync 時)呼ぶ。DOM の書き換えは内容が変わったフレームだけに絞る。
  sync(player: Player, message: string, kills: number): void {
    this.player = player;
    const { hp, maxHp } = player;
    const throttleIdx = player.throttleIdx;
    const low = hp <= maxHp * LOW_HP_RATIO;
    const pct = Math.max(0, Math.min(100, (hp / maxHp) * 100));
    const throttleVal = C.THROTTLE_LEVELS[throttleIdx];
    const throttlePct = ((throttleIdx + 1) / C.THROTTLE_LEVELS.length) * 100;
    const throttleText = `${C.THROTTLE_LABELS[throttleIdx]} (${throttleVal!.toFixed(1)} m/s²)`;
    const temp = Math.round(player.thermal.hullTemp);
    const tempHigh = temp > 0.7 * C.MAX_HULL_TEMP;
    const tempPct = Math.max(0, Math.min(100, (temp / C.MAX_HULL_TEMP) * 100));
    const qdyn = player.thermal.qdyn;
    const qdynHigh = qdyn > 0.5 * C.MAX_DYN_PRESSURE;
    const qdynPct = Math.max(0, Math.min(100, (qdyn / C.MAX_DYN_PRESSURE) * 100));
    const qdynText = qdyn >= 1000 ? `${(qdyn / 1000).toFixed(2)} kPa` : `${qdyn.toFixed(0)} Pa`;
    const chargeJ = player.power.chargeJ;
    const chargePct = Math.max(0, Math.min(100, player.power.chargeRatio * 100));

    const hpHtml =
      `<div style="display:grid; grid-template-columns:auto 1fr; gap:${SPACE_2} ${SPACE_4}; align-items:center;">` +
      `<span>装甲</span>` +
      `<div style="position:relative; width:160px; height:12px; background:${BAR_BG};">` +
      `<div style="width:${pct}%; height:100%; background:${low ? DANGER : ACCENT}; transition:width ${TRANSITION_FAST};"></div>` +
      `<div style="position:absolute; right:4px; top:0; bottom:0; display:flex; align-items:center; font-size:${FONT_XS}; color:${TEXT_STRONG}; text-shadow:0 0 2px ${BG}, 0 0 2px ${BG};">${Math.floor(hp)} / ${maxHp}</div></div>` +
      `<span>出力</span>` +
      `<div style="position:relative; width:160px; height:12px; background:${BAR_BG};">` +
      `<div style="width:${throttlePct}%; height:100%; background:${ACCENT}; transition:width ${TRANSITION_FAST};"></div>` +
      `<div style="position:absolute; right:4px; top:0; bottom:0; display:flex; align-items:center; font-size:${FONT_XS}; color:${TEXT_STRONG}; text-shadow:0 0 2px ${BG}, 0 0 2px ${BG};">${throttleText}</div></div>` +
      `<span>動圧</span>` +
      `<div style="position:relative; width:160px; height:12px; background:${BAR_BG};">` +
      `<div style="width:${qdynPct}%; height:100%; background:${qdynHigh ? DANGER : ACCENT}; transition:width ${TRANSITION_FAST};"></div>` +
      `<div style="position:absolute; right:4px; top:0; bottom:0; display:flex; align-items:center; font-size:${FONT_XS}; color:${TEXT_STRONG}; text-shadow:0 0 2px ${BG}, 0 0 2px ${BG};">${qdynText}</div></div>` +
      `<span>温度</span>` +
      `<div style="position:relative; width:160px; height:12px; background:${BAR_BG};">` +
      `<div style="width:${tempPct}%; height:100%; background:${tempHigh ? DANGER : ACCENT}; transition:width ${TRANSITION_FAST};"></div>` +
      `<div style="position:absolute; right:4px; top:0; bottom:0; display:flex; align-items:center; font-size:${FONT_XS}; color:${TEXT_STRONG}; text-shadow:0 0 2px ${BG}, 0 0 2px ${BG};">${temp} / ${C.MAX_HULL_TEMP} K</div></div>` +
      `<span>電力</span>` +
      `<div style="position:relative; width:160px; height:12px; background:${BAR_BG};">` +
      `<div style="width:${chargePct}%; height:100%; background:${ACCENT}; transition:width ${TRANSITION_FAST};"></div>` +
      `<div style="position:absolute; right:4px; top:0; bottom:0; display:flex; align-items:center; font-size:${FONT_XS}; color:${TEXT_STRONG}; text-shadow:0 0 2px ${BG}, 0 0 2px ${BG};">${fmtEnergy(chargeJ)} / ${fmtEnergy(C.POWER_CAPACITY)}</div></div>` +
      `</div>`;
    if (this.lastHpHtml !== hpHtml) {
      this.centerCol.innerHTML = hpHtml;
      this.lastHpHtml = hpHtml;
    }
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
    this.panel.style.display = 'flex';
  }

  // パネル DOM を非表示にする
  hide(): void {
    this.panel.style.display = 'none';
  }
}
