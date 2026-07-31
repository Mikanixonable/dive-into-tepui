// 一時停止 / 設定パネル(BGM トグル・タイトルへ戻る・閉じる)とギアボタン。
import type { Input } from '../input/input';
import { KEY_MAPPING as K } from '../input/key-mapping';

export class SettingsPanel {
  private readonly panel: HTMLElement;
  private readonly gear: HTMLElement;
  private readonly bgmToggle: HTMLElement;
  private bgmOn = true;

  onSettingsOpenChange: ((open: boolean) => void) | null = null;
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

  handleInput(input: Input): void {
    if (input.takeKey(K.pauseMenu)) this.toggle();
  }

  toggle(force?: boolean): void {
    const wasOpen = this.panel.style.display === 'block';
    const show = force !== undefined ? force : !wasOpen;
    if (show === wasOpen) return;
    this.panel.style.display = show ? 'block' : 'none';
    this.onSettingsOpenChange?.(show);
  }

  setBgmState(on: boolean): void {
    this.bgmOn = on;
    this.bgmToggle.textContent = on ? 'ON' : 'OFF';
    this.bgmToggle.classList.toggle('on', on);
  }
}
