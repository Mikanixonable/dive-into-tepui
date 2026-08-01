// ステージ固有の状況表示パネル(自機 HP バー・ステージからの補助メッセージ・撃墜数)。
// 表示内容がステージごとに決まるので Stage が所有し、hudSubStatus() を返すステージでだけ現れる。
// CSS(#hud-stagestatus)は hud/dom.ts の STYLE に一元管理されている。

const LOW_HP_RATIO = 0.3;
import * as C from '../../const';

export class StageStatusPanel {
  private readonly panel: HTMLElement;
  private readonly hpRow: HTMLElement;
  private readonly body: HTMLElement;
  private lastHpHtml = '';
  private lastBodyHtml = '';

  // 非表示状態のパネル DOM を組み立てて root に追加する
  constructor(root: HTMLElement) {
    this.panel = document.createElement('div');
    this.panel.id = 'hud-stagestatus';
    this.panel.className = 'panel';
    this.panel.style.display = 'none';
    this.panel.innerHTML = `<div class="t"></div><div class="k"></div>`;
    this.hpRow = this.panel.querySelector<HTMLElement>('.t')!;
    this.body = this.panel.querySelector<HTMLElement>('.k')!;
    root.appendChild(this.panel);
  }

  // 毎フレーム(sync 時)呼ぶ。DOM の書き換えは内容が変わったフレームだけに絞る。
  sync(hp: number, maxHp: number, message: string, kills: number, throttleIdx: number): void {
    // HP バーは内容が変わったフレームだけ書き換える
    const low = hp <= maxHp * LOW_HP_RATIO;
    const pct = Math.max(0, Math.min(100, (hp / maxHp) * 100));
    const throttleLabels = ['弱', '中', '強'];
    const throttleVal = C.THROTTLE_LEVELS[throttleIdx];
    const throttlePct = ((throttleIdx + 1) / 3) * 100;
    const throttleText = `${throttleLabels[throttleIdx]} (${throttleVal!.toFixed(1)} m/s²)`;

    const hpHtml =
      `<div style="display:grid; grid-template-columns:auto 1fr; gap:4px 8px; align-items:center;">` +
      `<span>磁気装甲</span>` +
      `<div style="position:relative; width:160px; height:12px; background:${C.COLOR_HUD_BAR_BG};">` +
      `<div style="width:${pct}%; height:100%; background:${low ? C.COLOR_HUD_HP_LOW : C.COLOR_HUD_HP_OK}; transition:width 0.2s;"></div>` +
      `<div style="position:absolute; right:4px; top:0; bottom:0; display:flex; align-items:center; font-size:10px; color:#fff; text-shadow:0 0 2px #000, 0 0 2px #000;">${Math.floor(hp)} / ${maxHp}</div></div>` +
      `<span>エンジン出力</span>` +
      `<div style="position:relative; width:160px; height:12px; background:${C.COLOR_HUD_BAR_BG};">` +
      `<div style="width:${throttlePct}%; height:100%; background:${C.COLOR_HUD_HP_OK}; transition:width 0.2s;"></div>` +
      `<div style="position:absolute; right:4px; top:0; bottom:0; display:flex; align-items:center; font-size:10px; color:#fff; text-shadow:0 0 2px #000, 0 0 2px #000;">${throttleText}</div></div>` +
      `</div>`;
    if (this.lastHpHtml !== hpHtml) {
      this.hpRow.innerHTML = hpHtml;
      this.lastHpHtml = hpHtml;
    }
    this.hpRow.classList.toggle('warn', low);

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
