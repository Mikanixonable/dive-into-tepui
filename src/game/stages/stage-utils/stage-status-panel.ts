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
    const throttleText = `エンジン出力: ${throttleLabels[throttleIdx]} (${C.THROTTLE_LEVELS[throttleIdx]!.toFixed(1)} m/s²)`;

    const hpHtml =
      `磁気装甲: ${Math.floor(hp)} / ${maxHp} ` +
      `<div style="display:inline-block; width:120px; height:10px; background:${C.COLORS.HUD_BAR_BG}; vertical-align:middle; margin-left:8px;">` +
      `<div style="width:${pct}%; height:100%; background:${low ? C.COLORS.HUD_HP_LOW : C.COLORS.HUD_HP_OK}; transition:width 0.2s;"></div></div>` +
      `<div style="font-size: 13px; color: ${C.COLORS.HUD_TEXT_MUTED}; margin-top: 4px;">${throttleText}</div>`;
    if (this.lastHpHtml !== hpHtml) {
      this.hpRow.innerHTML = hpHtml;
      this.lastHpHtml = hpHtml;
    }
    this.hpRow.classList.toggle('warn', low);

    // ステージからの補助メッセージと撃墜数
    const bodyHtml = `${message}<br>撃墜 ${kills}`;
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
