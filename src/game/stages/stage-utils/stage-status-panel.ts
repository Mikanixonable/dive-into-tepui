// ステージ固有の状況表示パネル(自機の装甲・エンジン出力・温度・ラジエーター・ステージからの補助メッセージ・撃墜数)。
// 表示内容がステージごとに決まるので Stage が所有し、hudSubStatus() を返すステージでだけ現れる。
// CSS(#hud-stagestatus)は hud/dom.ts の STYLE に一元管理されている。

const LOW_HP_RATIO = 0.3;
const RADIATOR_LOW_INTEGRITY = 0.5;
import * as C from '../../const';
import type { Player } from '../../player/player';
import type { RadiatorSide } from '../../player/radiator';
import { hudButton } from '../../hud/buttons';

const BAR_WIDTH = 160;
const BAR_HEIGHT = 12;

interface RadiatorRowDom {
  readonly bar: HTMLElement;
  readonly text: HTMLElement;
  readonly button: HTMLElement;
  lastText: string;
  lastButtonLabel: string;
}

export class StageStatusPanel {
  private readonly panel: HTMLElement;
  private readonly hpRow: HTMLElement;
  private readonly body: HTMLElement;
  private lastHpHtml = '';
  private lastBodyHtml = '';
  private player: Player | null = null;

  // ラジエーター行だけは展開/収納ボタンのリスナを保つため、innerHTML の再構築対象から外した永続 DOM にしてある
  private readonly radiatorRows: Record<RadiatorSide, RadiatorRowDom>;

  // 非表示状態のパネル DOM を組み立てて root に追加する
  constructor(root: HTMLElement) {
    this.panel = document.createElement('div');
    this.panel.id = 'hud-stagestatus';
    this.panel.className = 'panel';
    this.panel.style.display = 'none';
    this.panel.innerHTML = `<div class="t"></div><div class="radiator-grid"></div><div class="k"></div>`;
    this.hpRow = this.panel.querySelector<HTMLElement>('.t')!;
    this.body = this.panel.querySelector<HTMLElement>('.k')!;
    root.appendChild(this.panel);

    // ラジエーター行は上下で別グリッドにしつつ、装甲/出力/温度と同じ列指定で見た目を揃える
    const radiatorGrid = this.panel.querySelector<HTMLElement>('.radiator-grid')!;
    radiatorGrid.style.display = 'grid';
    radiatorGrid.style.gridTemplateColumns = 'auto 1fr';
    radiatorGrid.style.gap = '4px 8px';
    radiatorGrid.style.alignItems = 'center';

    this.radiatorRows = {
      up: this.buildRadiatorRow(radiatorGrid, '上', 'up'),
      down: this.buildRadiatorRow(radiatorGrid, '下', 'down'),
    };
  }

  // side 1枚ぶんの行(ラベル・バー・展開ボタン)を grid へ組み立て、以後の更新に使う要素を返す。
  private buildRadiatorRow(grid: HTMLElement, label: string, side: RadiatorSide): RadiatorRowDom {
    const labelSpan = document.createElement('span');
    labelSpan.textContent = `ラジエーター${label}`;
    grid.appendChild(labelSpan);

    const cell = document.createElement('div');
    cell.style.display = 'flex';
    cell.style.alignItems = 'center';
    cell.style.gap = '6px';

    const barBox = document.createElement('div');
    barBox.style.position = 'relative';
    barBox.style.width = `${BAR_WIDTH}px`;
    barBox.style.height = `${BAR_HEIGHT}px`;
    barBox.style.background = C.COLOR_HUD_BAR_BG;

    const bar = document.createElement('div');
    bar.style.height = '100%';
    bar.style.transition = 'width 0.2s';
    barBox.appendChild(bar);

    const text = document.createElement('div');
    text.style.position = 'absolute';
    text.style.right = '4px';
    text.style.top = '0';
    text.style.bottom = '0';
    text.style.display = 'flex';
    text.style.alignItems = 'center';
    text.style.fontSize = '10px';
    text.style.color = '#fff';
    text.style.textShadow = '0 0 2px #000, 0 0 2px #000';
    barBox.appendChild(text);

    cell.appendChild(barBox);

    // ボタンはバーの右隣に並べる
    const button = hudButton('展開', () => {
      this.player?.radiator.toggle(side);
    });
    cell.appendChild(button);

    grid.appendChild(cell);

    return { bar, text, button, lastText: '', lastButtonLabel: '展開' };
  }

  // row の表示を side の展開度・健全度へ合わせる。文字列は値が動いたときだけ書き換える。
  private syncRadiatorRow(row: RadiatorRowDom, side: RadiatorSide, radiator: Player['radiator']): void {
    const deploy = radiator.deployOf(side);
    const deployPct = Math.round(deploy * 100);
    const integrityPct = Math.round(radiator.integrityOf(side) * 100);
    const low = integrityPct < RADIATOR_LOW_INTEGRITY * 100;

    row.bar.style.width = `${deployPct}%`;
    row.bar.style.background = low ? C.COLOR_HUD_HP_LOW : C.COLOR_HUD_HP_OK;

    const text = `展開${deployPct}% / 健全${integrityPct}%`;
    if (row.lastText !== text) {
      row.text.textContent = text;
      row.lastText = text;
    }

    const buttonLabel = deploy >= 0.5 ? '収納' : '展開';
    if (row.lastButtonLabel !== buttonLabel) {
      row.button.textContent = buttonLabel;
      row.lastButtonLabel = buttonLabel;
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
      `<div style="position:absolute; right:4px; top:0; bottom:0; display:flex; align-items:center; font-size:10px; color:#fff; text-shadow:0 0 2px #000, 0 0 2px #000;">${temp} K</div></div>` +
      `</div>`;
    if (this.lastHpHtml !== hpHtml) {
      this.hpRow.innerHTML = hpHtml;
      this.lastHpHtml = hpHtml;
    }
    this.hpRow.classList.toggle('warn', low);

    const radiator = player.radiator;
    this.syncRadiatorRow(this.radiatorRows.up, 'up', radiator);
    this.syncRadiatorRow(this.radiatorRows.down, 'down', radiator);

    // ステージからの補助メッセージと撃墜数
    const bodyHtml = message ? `${message} &nbsp;|&nbsp; 撃墜 ${kills}` : `撃墜 ${kills}`;
    if (this.lastBodyHtml !== bodyHtml) {
      this.body.innerHTML = bodyHtml;
      this.lastBodyHtml = bodyHtml;
    }
    this.panel.style.display = 'block';
  }

  // パネル DOM を非表示にする
  hide(): void {
    this.panel.style.display = 'none';
  }
}
