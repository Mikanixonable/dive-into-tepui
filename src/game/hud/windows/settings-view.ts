import faviconUrl from '../../../../public/favicon.svg';
import type { Bgm } from '../../../audio/bgm/bgm';
import type { GraphicsSettings } from '../../../render/graphics-settings';
import { BgmSettingsPanel } from '../panels/bgm-settings-panel';
import { GraphicsPanel } from '../panels/graphics-panel';
import { ThemePanel } from '../panels/theme-panel';
import type { OverlayHandle, OverlayManager } from '../overlay-manager';
import { CloseButton, TabBar } from '../widgets';

type SettingsTab = 'theme' | 'graphics' | 'bgm';

const OPEN_STORAGE_KEY = 'tepui.settingsViewOpen';

// 設定ビューの開閉状態を localStorage から読み、次回起動時に復元できるようにする。
function loadSettingsViewOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

// 設定ビューの開閉状態を localStorage へ書き、次回起動時の復元に使う。
function saveSettingsViewOpen(open: boolean): void {
  try {
    localStorage.setItem(OPEN_STORAGE_KEY, open ? '1' : '0');
  } catch {
    /* localStorage 不可なら保存しない */
  }
}

// タイトル画面とゲーム中の両方から開く、システム設定の共通ビュー。
// 3D の ViewManager とは独立した DOM ビューなので、閉じると開く前のビューへ戻る。
export class SettingsView implements OverlayHandle {
  private readonly panel: HTMLElement;
  private readonly overlayManager: OverlayManager;
  private readonly bgm: Bgm;
  private readonly bgmPanel: BgmSettingsPanel;
  private _isOpen = false;

  public onOpenChange: ((open: boolean) => void) | null = null;

  // ブランド表示・ヘッダ・タブバーと、配色/描画/BGMの3面を組み立てて root へ差し込む。
  public constructor(
    root: HTMLElement, overlayManager: OverlayManager, bgm: Bgm, graphics: GraphicsSettings,
  ) {
    this.overlayManager = overlayManager;
    this.bgm = bgm;

    this.panel = document.createElement('section');
    this.panel.id = 'hud-settings-view';
    this.panel.className = 'panel';
    this.panel.setAttribute('role', 'dialog');
    this.panel.setAttribute('aria-modal', 'true');
    this.panel.setAttribute('aria-labelledby', 'hud-settings-title');
    this.panel.appendChild(this.buildBrand());
    this.panel.appendChild(this.buildHeader());

    const description = document.createElement('p');
    description.className = 'sv-description';
    description.textContent = '配色・描画・BGMの設定を切り替えられます。';
    this.panel.appendChild(description);

    // タブバー: 配色・描画・BGMの3面を切り替える。
    const tabPanels = new Map<SettingsTab, HTMLElement>();
    const tabs = new TabBar<SettingsTab>(
      [['theme', '配色'], ['graphics', '描画'], ['bgm', 'BGM']],
      (selectedTab) => {
        tabs.setSelected(selectedTab);
        for (const [tab, panel] of tabPanels) panel.hidden = tab !== selectedTab;
      },
    );
    tabs.element.classList.add('sv-tabs');
    this.panel.appendChild(tabs.element);

    // 見出し付きの節を1つ作る。タブ切り替え時に対応する節だけを取り出せるよう登録しておく。
    const addTabPanel = (tab: SettingsTab, title: string): HTMLElement => {
      const section = document.createElement('section');
      section.className = 'sv-section sv-tab-panel';
      section.setAttribute('role', 'tabpanel');
      section.setAttribute('aria-label', title);
      section.hidden = true;
      const sectionTitle = document.createElement('h3');
      sectionTitle.textContent = title;
      section.appendChild(sectionTitle);
      // タブ切り替え時に対応する節だけを表示するため、ここで登録しておく。
      tabPanels.set(tab, section);
      return section;
    };

    const themeSection = addTabPanel('theme', '配色');
    const themePanel = new ThemePanel();
    themeSection.appendChild(themePanel.element);
    this.panel.appendChild(themeSection);

    const graphicsSection = addTabPanel('graphics', '描画');
    const graphicsPanel = new GraphicsPanel(graphics);
    graphicsSection.appendChild(graphicsPanel.element);
    this.panel.appendChild(graphicsSection);

    const bgmSection = addTabPanel('bgm', 'BGM');
    this.bgmPanel = new BgmSettingsPanel(bgm);
    bgmSection.appendChild(this.bgmPanel.element);
    this.panel.appendChild(bgmSection);

    tabs.setSelected('theme');
    const initialPanel = tabPanels.get('theme');
    if (initialPanel !== undefined) initialPanel.hidden = false;

    root.appendChild(this.panel);
  }

  // ロゴ・タイトル・バージョンを縦に積んだブランド表示を組み立てる。
  private buildBrand(): HTMLElement {
    const brand = document.createElement('div');
    brand.className = 'sv-brand';
    const brandLogo = document.createElement('img');
    brandLogo.className = 'sv-brand-logo';
    brandLogo.src = faviconUrl;
    brandLogo.alt = '';
    brand.appendChild(brandLogo);
    // ロゴに続けて、タイトルとバージョンをまとめて積む。
    const brandText = document.createElement('div');
    brandText.className = 'sv-brand-text';
    const brandTitle = document.createElement('span');
    brandTitle.className = 'sv-brand-title';
    brandTitle.textContent = 'Dive into Tepui';
    brandText.appendChild(brandTitle);
    const brandVersion = document.createElement('span');
    brandVersion.className = 'sv-brand-version';
    brandVersion.textContent = `v${__APP_VERSION__}`;
    brandText.appendChild(brandVersion);
    brand.appendChild(brandText);
    return brand;
  }

  // 見出しと閉じるボタンを持つヘッダを組み立てる。
  private buildHeader(): HTMLElement {
    const header = document.createElement('div');
    header.className = 'sv-header';
    const headingGroup = document.createElement('div');
    headingGroup.className = 'sv-heading-group';
    const heading = document.createElement('h2');
    heading.id = 'hud-settings-title';
    heading.textContent = '設定';
    headingGroup.appendChild(heading);
    const eyebrow = document.createElement('span');
    eyebrow.className = 'sv-eyebrow';
    eyebrow.textContent = 'SYSTEM / SETTINGS';
    headingGroup.appendChild(eyebrow);
    header.appendChild(headingGroup);
    // 見出しの隣に閉じるボタンを置く。
    const closeButton = new CloseButton(() => this.toggle(false));
    header.appendChild(closeButton.element);
    return header;
  }

  public contains(target: Node): boolean {
    return this.panel.contains(target);
  }

  // 起動シーケンスの配線(onOpenChange 等)が終わったあとに、呼び出し側から一度だけ呼ぶ。
  public restorePersistedOpenState(): void {
    if (loadSettingsViewOpen()) this.toggle(true);
  }

  public close(): void {
    this.toggle(false);
  }

  // 開閉を切り替える。force を渡せばその状態へ強制し、省略時は現在の逆にする。
  public toggle(force?: boolean): void {
    const show = force !== undefined ? force : !this._isOpen;
    if (show === this._isOpen) return;
    this._isOpen = show;
    saveSettingsViewOpen(show);
    this.panel.style.display = show ? 'block' : 'none';
    // 開いている間はゲーム中の BGM を伏せ、試聴だけが聞こえる状態にする。閉じるときは試聴を
    // 止めてゲーム中の BGM へ戻す。
    if (show) {
      this.bgm.beginAudition();
      this.overlayManager.open('settings-view', this, {
        kind: 'modal', closeOnEscape: true, closeOnOutsideClick: false, gatesInput: true,
        exclusiveGroup: 'system-modal',
      });
    } else {
      this.overlayManager.close('settings-view');
      this.bgmPanel.stopAudition();
    }
    this.onOpenChange?.(show);
  }
}
