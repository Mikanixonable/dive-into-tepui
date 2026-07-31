// ステージ固有の状況表示パネル(自機 HP バー・ステージからの補助メッセージ・撃墜数)。
// 表示内容がステージごとに決まるので Stage が所有し、hudSubStatus() を返すステージでだけ現れる。
// CSS(#hud-stagestatus)は hud/dom.ts の STYLE に一元管理されている。

// HP バーの色。残量警告(30% 以下)で赤へ切り替える。
const BAR_LOW = '#ff4a3d';
const BAR_OK = '#4de8ff';
const LOW_HP_RATIO = 0.3;

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
  sync(hp: number, maxHp: number, message: string, kills: number): void {
    // HP バーは内容が変わったフレームだけ書き換える
    const low = hp <= maxHp * LOW_HP_RATIO;
    const pct = Math.max(0, Math.min(100, (hp / maxHp) * 100));
    const hpHtml =
      `HP: ${Math.floor(hp)} / ${maxHp} ` +
      `<div style="display:inline-block; width:120px; height:10px; border:1px solid #aaa; background:#222; vertical-align:middle; margin-left:8px;">` +
      `<div style="width:${pct}%; height:100%; background:${low ? BAR_LOW : BAR_OK}; transition:width 0.2s;"></div></div>`;
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
