// ステージ固有の状況表示パネル(左部: ステージ補助メッセージ・撃墜数 / 中央部: 自機の装甲・エンジン出力・
// 温度・電力 / 右部: ラジエーター左右の展開ボタン)。表示内容がステージごとに決まるので Stage が所有し、
// hudSubStatus() を返すステージでだけ現れる。CSS(#hud-stagestatus)は hud/dom.ts の STYLE に一元管理されている。

const LOW_HP_RATIO = 0.3;
const RADIATOR_HIGH_WEAR = 0.5;
import * as C from '../../const';
import type { Player } from '../../player/player';
import type { RadiatorSide } from '../../player/radiator';
import { KEY_MAPPING as K } from '../../input/key-mapping';
import { fmtEnergy } from '../../hud/utils';
import { ACCENT } from '../../theme';

// side を「右(+X)/左(-X)」ラベルとショートカットキーへ対応させる。
const RADIATOR_UI: Record<RadiatorSide, { label: string; key: string }> = {
  up: { label: '右', key: K.radiatorDeployUp.label },
  down: { label: '左', key: K.radiatorDeployDown.label },
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
  private readonly leftCol: HTMLElement;
  private readonly centerCol: HTMLElement;
  private lastHpHtml = '';
  private lastLeftHtml = '';
  private player: Player | null = null;

  // ラジエーターボタンだけは展開/収納のクリックリスナを保つため、innerHTML の再構築対象から
  // 外した永続 DOM にしてある
  private readonly radiatorButtons: Record<RadiatorSide, RadiatorButtonDom>;

  // 非表示状態のパネル DOM を組み立てて root に追加する
  constructor(root: HTMLElement) {
    this.panel = document.createElement('div');
    this.panel.id = 'hud-stagestatus';
    this.panel.className = 'panel';
    this.panel.style.display = 'none';
    this.panel.innerHTML = `<div class="k"></div><div class="t"></div><div class="radiators"></div>`;
    this.leftCol = this.panel.querySelector<HTMLElement>('.k')!;
    this.centerCol = this.panel.querySelector<HTMLElement>('.t')!;
    root.appendChild(this.panel);

    const radiatorsCol = this.panel.querySelector<HTMLElement>('.radiators')!;
    this.radiatorButtons = {
      up: this.buildRadiatorButton(radiatorsCol, 'up'),
      down: this.buildRadiatorButton(radiatorsCol, 'down'),
    };
  }

  // side 1枚ぶんの展開/収納ボタンを組み立て、以後の更新に使う要素を返す。
  private buildRadiatorButton(col: HTMLElement, side: RadiatorSide): RadiatorButtonDom {
    const button = document.createElement('button');
    button.className = 'radiator-btn';
    button.innerHTML = `<div class="fill"></div><div class="label"></div>`;
    button.addEventListener('click', () => this.player?.radiator.toggle(side));
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
  private syncRadiatorButton(dom: RadiatorButtonDom, side: RadiatorSide, radiator: Player['radiator']): void {
    const ui = RADIATOR_UI[side];
    const deployed = radiator.deployOf(side) >= 0.5;
    const wearPct = Math.round(radiator.wearOf(side) * 100);
    const highWear = wearPct > RADIATOR_HIGH_WEAR * 100;

    const fillWidth = `${100 - wearPct}%`;
    const fillColor = highWear ? C.COLOR_HUD_HP_LOW : deployed ? ACCENT : C.COLOR_HUD_HP_OK;
    if (dom.lastFillWidth !== fillWidth) {
      dom.fill.style.width = fillWidth;
      dom.lastFillWidth = fillWidth;
    }
    if (dom.lastFillColor !== fillColor) {
      dom.fill.style.background = fillColor;
      dom.lastFillColor = fillColor;
    }

    const text =
      `<div>ラジエーター${ui.label} [${ui.key}]</div>` +
      `<div>${deployed ? '展開中' : '収納中'} / 損耗${wearPct}%</div>`;
    if (dom.lastText !== text) {
      dom.label.innerHTML = text;
      dom.lastText = text;
    }
  }

  // 毎フレーム(sync 時)呼ぶ。DOM の書き換えは内容が変わったフレームだけに絞る。
  sync(player: Player, message: string, kills: number): void {
    this.player = player;
    // 温度は整数 K に丸めてから組み立て、表示が動くフレームだけ DOM を書き換える
    const { hp, maxHp } = player;
    const throttleIdx = player.throttleIdx;
    const low = hp <= maxHp * LOW_HP_RATIO;
    const pct = Math.max(0, Math.min(100, (hp / maxHp) * 100));
    const throttleLabels = ['弱', '中', '強'];
    const throttleVal = C.THROTTLE_LEVELS[throttleIdx];
    const throttlePct = ((throttleIdx + 1) / 3) * 100;
    const throttleText = `${throttleLabels[throttleIdx]} (${throttleVal!.toFixed(1)} m/s²)`;
    const temp = Math.round(player.thermal.hullTemp);
    const tempHigh = temp > 0.7 * C.MAX_HULL_TEMP;
    const tempPct = Math.max(0, Math.min(100, (temp / C.MAX_HULL_TEMP) * 100));
    const chargeJ = player.power.chargeJ;
    const chargePct = Math.max(0, Math.min(100, player.power.chargeRatio * 100));

    const hpHtml =
      `<div style="display:grid; grid-template-columns:auto 1fr; gap:4px 8px; align-items:center;">` +
      `<span>装甲</span>` +
      `<div style="position:relative; width:160px; height:12px; background:${C.COLOR_HUD_BAR_BG};">` +
      `<div style="width:${pct}%; height:100%; background:${low ? C.COLOR_HUD_HP_LOW : C.COLOR_HUD_HP_OK}; transition:width 0.2s;"></div>` +
      `<div style="position:absolute; right:4px; top:0; bottom:0; display:flex; align-items:center; font-size:10px; color:#fff; text-shadow:0 0 2px #000, 0 0 2px #000;">${Math.floor(hp)} / ${maxHp}</div></div>` +
      `<span>出力</span>` +
      `<div style="position:relative; width:160px; height:12px; background:${C.COLOR_HUD_BAR_BG};">` +
      `<div style="width:${throttlePct}%; height:100%; background:${C.COLOR_HUD_HP_OK}; transition:width 0.2s;"></div>` +
      `<div style="position:absolute; right:4px; top:0; bottom:0; display:flex; align-items:center; font-size:10px; color:#fff; text-shadow:0 0 2px #000, 0 0 2px #000;">${throttleText}</div></div>` +
      `<span>温度</span>` +
      `<div style="position:relative; width:160px; height:12px; background:${C.COLOR_HUD_BAR_BG};">` +
      `<div style="width:${tempPct}%; height:100%; background:${tempHigh ? C.COLOR_HUD_HP_LOW : C.COLOR_HUD_HP_OK}; transition:width 0.2s;"></div>` +
      `<div style="position:absolute; right:4px; top:0; bottom:0; display:flex; align-items:center; font-size:10px; color:#fff; text-shadow:0 0 2px #000, 0 0 2px #000;">${temp} / ${C.MAX_HULL_TEMP} K</div></div>` +
      `<span>電力</span>` +
      `<div style="position:relative; width:160px; height:12px; background:${C.COLOR_HUD_BAR_BG};">` +
      `<div style="width:${chargePct}%; height:100%; background:${C.COLOR_HUD_HP_OK}; transition:width 0.2s;"></div>` +
      `<div style="position:absolute; right:4px; top:0; bottom:0; display:flex; align-items:center; font-size:10px; color:#fff; text-shadow:0 0 2px #000, 0 0 2px #000;">${fmtEnergy(chargeJ)} / ${fmtEnergy(C.POWER_CAPACITY)}</div></div>` +
      `</div>`;
    if (this.lastHpHtml !== hpHtml) {
      this.centerCol.innerHTML = hpHtml;
      this.lastHpHtml = hpHtml;
    }
    this.centerCol.classList.toggle('warn', low);

    const radiator = player.radiator;
    this.syncRadiatorButton(this.radiatorButtons.up, 'up', radiator);
    this.syncRadiatorButton(this.radiatorButtons.down, 'down', radiator);

    // ステージからの補助メッセージと撃墜数
    const leftHtml = message ? `<div>${message}</div><div>撃墜 ${kills}</div>` : `<div>撃墜 ${kills}</div>`;
    if (this.lastLeftHtml !== leftHtml) {
      this.leftCol.innerHTML = leftHtml;
      this.lastLeftHtml = leftHtml;
    }
    this.panel.style.display = 'block';
  }

  // パネル DOM を非表示にする
  hide(): void {
    this.panel.style.display = 'none';
  }
}
