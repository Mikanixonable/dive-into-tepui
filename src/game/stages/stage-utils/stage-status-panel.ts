// ステージ固有の状況表示パネル(自機の装甲・エンジン出力・温度・ラジエーター・ステージからの補助メッセージ・撃墜数)。
// 表示内容がステージごとに決まるので Stage が所有し、hudSubStatus() を返すステージでだけ現れる。
// CSS(#hud-stagestatus)は hud/dom.ts の STYLE に一元管理されている。

const LOW_HP_RATIO = 0.3;
const RADIATOR_LOW_INTEGRITY = 0.5;
import * as C from '../../const';
import type { Player } from '../../player/player';
import { ContextMenu } from '../../hud/context-menu';
import type { RadiatorSide } from '../../player/radiator';

export class StageStatusPanel {
  private readonly panel: HTMLElement;
  private readonly hpRow: HTMLElement;
  private readonly body: HTMLElement;
  private readonly radiatorMenu = new ContextMenu();
  private lastHpHtml = '';
  private lastBodyHtml = '';
  private player: Player | null = null;

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

    // hpRow 自体は innerHTML の書き換えでも作り直されないので、ここへ委譲して聞き続ける
    this.hpRow.addEventListener('contextmenu', (e) => {
      const target = e.target instanceof HTMLElement ? e.target.closest('[data-radiator-row]') : null;
      if (!target || !this.player) return;
      e.preventDefault();
      const radiator = this.player.radiator;
      const upDeployed = radiator.deployOf('up') >= 0.5;
      const downDeployed = radiator.deployOf('down') >= 0.5;
      this.radiatorMenu.open((e as MouseEvent).clientX, (e as MouseEvent).clientY, [
        { label: upDeployed ? '上パネルを収納' : '上パネルを展開', act: 'toggle-up' },
        { label: downDeployed ? '下パネルを収納' : '下パネルを展開', act: 'toggle-down' },
      ]);
    });
    this.radiatorMenu.onSelect = (act) => {
      if (!this.player) return;
      const side: RadiatorSide | null = act === 'toggle-up' ? 'up' : act === 'toggle-down' ? 'down' : null;
      if (side) this.player.radiator.toggle(side);
    };
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

    // 展開度は毎フレーム連続的に変化するため、丸めてから比較しないと差分更新が効かない
    const radiator = player.radiator;
    const radiatorRow = (side: RadiatorSide, label: string): string => {
      const deployPct = Math.round(radiator.deployOf(side) * 100);
      const integrityPct = Math.round(radiator.integrityOf(side) * 100);
      const low = integrityPct < RADIATOR_LOW_INTEGRITY * 100;
      return (
        `<div style="position:relative; width:160px; height:12px; background:${C.COLOR_HUD_BAR_BG}; margin-bottom:2px;">` +
        `<div style="width:${deployPct}%; height:100%; background:${low ? C.COLOR_HUD_HP_LOW : C.COLOR_HUD_HP_OK}; transition:width 0.2s;"></div>` +
        `<div style="position:absolute; right:4px; top:0; bottom:0; display:flex; align-items:center; font-size:10px; color:#fff; text-shadow:0 0 2px #000, 0 0 2px #000;">${label} 展開${deployPct}% / 健全${integrityPct}%</div></div>`
      );
    };

    const hpHtml =
      `<div style="display:grid; grid-template-columns:auto 1fr; gap:4px 8px; align-items:center;">` +
      `<span>装甲</span>` +
      `<div style="position:relative; width:160px; height:12px; background:${C.COLOR_HUD_BAR_BG};">` +
      `<div style="width:${pct}%; height:100%; background:${low ? C.COLOR_HUD_HP_LOW : C.COLOR_HUD_HP_OK}; transition:width 0.2s;"></div>` +
      `<div style="position:absolute; right:4px; top:0; bottom:0; display:flex; align-items:center; font-size:10px; color:#fff; text-shadow:0 0 2px #000, 0 0 2px #000;">${Math.floor(hp)} / ${maxHp}</div></div>` +
      `<span>エンジン出力</span>` +
      `<div style="position:relative; width:160px; height:12px; background:${C.COLOR_HUD_BAR_BG};">` +
      `<div style="width:${throttlePct}%; height:100%; background:${C.COLOR_HUD_HP_OK}; transition:width 0.2s;"></div>` +
      `<div style="position:absolute; right:4px; top:0; bottom:0; display:flex; align-items:center; font-size:10px; color:#fff; text-shadow:0 0 2px #000, 0 0 2px #000;">${throttleText}</div></div>` +
      `<span>温度</span>` +
      `<div style="position:relative; width:160px; height:12px; background:${C.COLOR_HUD_BAR_BG};">` +
      `<div style="width:${tempPct}%; height:100%; background:${tempHigh ? C.COLOR_HUD_HP_LOW : C.COLOR_HUD_HP_OK}; transition:width 0.2s;"></div>` +
      `<div style="position:absolute; right:4px; top:0; bottom:0; display:flex; align-items:center; font-size:10px; color:#fff; text-shadow:0 0 2px #000, 0 0 2px #000;">${temp} K</div></div>` +
      `<span data-radiator-row style="pointer-events:auto;">ラジエーター</span>` +
      `<div data-radiator-row style="pointer-events:auto;">${radiatorRow('up', '上')}${radiatorRow('down', '下')}</div>` +
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
