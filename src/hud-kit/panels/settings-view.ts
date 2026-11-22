import type { BgmAudition } from '../../audio/bgm/bgm';
import type { GraphicsSelection } from '../../render/graphics-selection';
import { BgmSettingsPanel } from './bgm-settings-panel';
import { GraphicsPanel } from './graphics-panel';
import { ThemePanel } from './theme-panel';
import { TabBar } from '../widgets';

type SettingsTab = 'theme' | 'graphics' | 'bgm';

// 描画・BGM・配色の詳細設定ビュー。左の縦の内側タブで3つのパネルを切り替え、各設定の変更をコールバックで外部へ通知する。
export class SettingsView {
  public readonly element: HTMLElement;
  private readonly bgmPanel: BgmSettingsPanel;
  private active = false;

  // 配色が選ばれたときに呼ばれる。
  public onThemeIdChange: ((id: string) => void) | null = null;
  // 描画品質の選び方が変わったときに呼ばれる。
  public onGraphicsChange: ((selection: GraphicsSelection) => void) | null = null;
  // BGM の音量が変わったときに呼ばれる。
  public onBgmVolumeChange: ((volume: number) => void) | null = null;

  // ヘッダー・タブバーおよび描画/BGM/配色の各パネルを構築する。graphics・bgmVolume・themeId は
  // 組み立て時の設定値。
  public constructor(graphics: GraphicsSelection, bgmVolume: number, themeId: string) {
    this.element = document.createElement('section');
    this.element.className = 'pm-settings-view';

    // タブバー: 描画・BGM・配色の3パネルを切り替える。左に縦に並べ、右の本文を切り替える。
    const tabPanels = new Map<SettingsTab, HTMLElement>();
    const tabs = new TabBar<SettingsTab>(
      [['graphics', '描画'], ['bgm', 'BGM'], ['theme', '配色']],
      (selectedTab) => {
        tabs.setSelected(selectedTab);
        for (const [tab, panel] of tabPanels) panel.hidden = tab !== selectedTab;
      },
    );
    tabs.element.classList.add('sv-tabs');
    tabs.element.setAttribute('aria-orientation', 'vertical');
    this.element.appendChild(tabs.element);
    const panes = document.createElement('div');
    panes.className = 'sv-panes';
    this.element.appendChild(panes);

    // タブパネル要素を生成し、タブ切り替え用に tabPanels へ登録する。見出しはタブが兼ねるので持たない。
    const addTabPanel = (tab: SettingsTab, title: string): HTMLElement => {
      const section = document.createElement('section');
      section.className = 'sv-tab-panel';
      section.setAttribute('role', 'tabpanel');
      section.setAttribute('aria-label', title);
      // タブで選ばれるまで隠しておく。
      section.hidden = true;
      tabPanels.set(tab, section);
      return section;
    };

    // 各パネルのイベントハンドラを、自身の通知コールバックへ中継する。
    const graphicsSectionBody = addTabPanel('graphics', '描画');
    const graphicsPanel = new GraphicsPanel(graphics);
    graphicsPanel.onChange = (changed) => this.onGraphicsChange?.(changed);
    graphicsSectionBody.appendChild(graphicsPanel.element);

    const bgmSectionBody = addTabPanel('bgm', 'BGM');
    this.bgmPanel = new BgmSettingsPanel(bgmVolume);
    this.bgmPanel.onVolumeChange = (volume) => this.onBgmVolumeChange?.(volume);
    bgmSectionBody.appendChild(this.bgmPanel.element);

    const themeSectionBody = addTabPanel('theme', '配色');
    const themePanel = new ThemePanel(themeId);
    themePanel.onSelect = (id) => this.onThemeIdChange?.(id);
    themeSectionBody.appendChild(themePanel.element);

    for (const section of tabPanels.values()) panes.appendChild(section);

    tabs.setSelected('graphics');
    const initialPanel = tabPanels.get('graphics');
    if (initialPanel !== undefined) initialPanel.hidden = false;
  }

  // BGM試聴状態。設定ビューを開いている間を試聴期間とし、非表示時は null、停止時は 'silent'。
  public get bgmAudition(): BgmAudition | 'silent' | null {
    return this.active ? this.bgmPanel.audition ?? 'silent' : null;
  }

  // 設定ビューの表示を試聴の進行状況に同期する。nowMs [ms] はフレームの実時刻。毎フレーム呼ぶ。
  public sync(nowMs: number): void {
    if (!this.active) return;
    this.bgmPanel.sync(nowMs);
  }

  // 外部から音量が変更されたときに、BGM タブの表示を再描画する。
  public syncBgmVolume(volume: number): void {
    this.bgmPanel.syncVolume(volume);
  }

  // active の間を試聴の期間とし、期間を出るときに試聴を止める。
  public setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    if (!active) this.bgmPanel.stopAudition();
  }
}
