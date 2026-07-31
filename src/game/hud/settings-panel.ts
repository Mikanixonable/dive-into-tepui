// 一時停止 / 設定パネル(BGM トグル・タイトルへ戻る・閉じる)とギアボタン。
// 設定まわりの状態(bgmOn)・DOM 構築・コールバックを一手に所有する。
// ⚙ギアクリック・[閉じる]クリック・[Esc]キーいずれの経路で開閉しても toggle() を通るので、
// onSettingsOpenChange 経由でゲーム側の一時停止フラグを漏れなく同期できる。
// CSS(#hud-gear / #hud-settings)は hud/dom.ts の STYLE に一元管理されている。
import type { Input } from '../input/input';
import { KEY_MAPPING as K } from '../input/key-mapping';

export class SettingsPanel {
  private readonly panel: HTMLElement;
  private readonly gear: HTMLElement;
  private readonly bgmToggle: HTMLElement;
  private bgmOn = true;

  // 開閉状態が変化した際に呼ぶ。ゲーム側はこれを HP自動回復・時間経過の一時停止フラグ (paused) に同期させる。
  onSettingsOpenChange: ((open: boolean) => void) | null = null;
  // 「ゲームを中断してタイトル画面に戻る」ボタン
  onQuitToTitle: (() => void) | null = null;
  onBgmToggle: ((on: boolean) => void) | null = null;

  constructor(root: HTMLElement) {
    this.gear = document.createElement('div');
    this.gear.id = 'hud-gear';
    this.gear.textContent = '⚙';
    this.gear.addEventListener('click', () => this.toggle());
    root.appendChild(this.gear);

    this.panel = document.createElement('div');
    this.panel.id = 'hud-settings';
    this.panel.className = 'panel';
    this.panel.innerHTML = `
      <h3>一時停止 / 設定</h3>
      <div class="srow"><span class="k">BGM</span><span class="stoggle" data-id="bgmtoggle">ON</span></div>
      <div class="squit" data-id="settingsquit">ゲームを中断してタイトル画面に戻る</div>
      <div class="sclose" data-id="settingsclose">[閉じる]</div>`;
    root.appendChild(this.panel);

    this.bgmToggle = this.panel.querySelector<HTMLElement>('[data-id="bgmtoggle"]')!;
    this.bgmToggle.addEventListener('click', () => {
      const on = !this.bgmOn;
      this.setBgmState(on);
      this.onBgmToggle?.(on);
    });
    this.panel.querySelector<HTMLElement>('[data-id="settingsquit"]')!.addEventListener('click', () => {
      this.onQuitToTitle?.();
    });
    this.panel.querySelector<HTMLElement>('[data-id="settingsclose"]')!.addEventListener('click', () =>
      this.toggle(false),
    );
  }

  // 一時停止メニューの開閉は [Esc]。⚙ギア・[閉じる]と同じ toggle() を通すので、
  // どの経路でも onSettingsOpenChange が発火する。
  handleInput(input: Input): void {
    if (input.takeKey(K.pauseMenu)) this.toggle();
  }

  // 設定パネルの開閉。force を渡すとその状態に固定する。
  toggle(force?: boolean): void {
    const wasOpen = this.panel.style.display === 'block';
    const show = force !== undefined ? force : !wasOpen;
    if (show === wasOpen) return;
    this.panel.style.display = show ? 'block' : 'none';
    this.onSettingsOpenChange?.(show);
  }

  // BGM トグル表示の反映(実際の再生制御は呼び出し側の Sfx が行う)
  setBgmState(on: boolean): void {
    this.bgmOn = on;
    this.bgmToggle.textContent = on ? 'ON' : 'OFF';
    this.bgmToggle.classList.toggle('on', on);
  }
}
