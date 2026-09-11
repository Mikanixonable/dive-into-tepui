import type { Bgm } from '../../audio/bgm/bgm';
import type { GraphicsSettingsData } from '../../render/graphics-settings';
import { BgmSettingsPanel } from '../panels/bgm-settings-panel';
import { GraphicsPanel } from '../panels/graphics-panel';
import { ThemePanel } from '../panels/theme-panel';
import { TabBar } from '../widgets';

type SettingsTab = 'theme' | 'graphics' | 'bgm';

// 描画・BGM・配色の詳細設定面。内側タブで3面を切り替え、各面の変更を onXxx で外へ返す。
export class SettingsView {
  public readonly element: HTMLElement;
  private readonly bgm: Bgm;
  private readonly bgmPanel: BgmSettingsPanel;
  private active = false;

  // 配色が選ばれたときに呼ばれる。
  public onThemeIdChange: ((id: string) => void) | null = null;
  // 描画品質の設定値一式が変わったときに呼ばれる。
  public onGraphicsChange: ((graphics: GraphicsSettingsData) => void) | null = null;
  // BGM の音量が変わったときに呼ばれる。
  public onBgmVolumeChange: ((volume: number) => void) | null = null;

  // 見出し・内側タブバーと、描画/BGM/配色の3面を組み立てる。graphics と bgmVolume は組み立て時の
  // 設定値。
  public constructor(bgm: Bgm, graphics: GraphicsSettingsData, bgmVolume: number) {
    this.bgm = bgm;

    this.element = document.createElement('section');
    this.element.className = 'pm-settings-view';
    this.element.setAttribute('aria-labelledby', 'hud-settings-title');
    this.element.appendChild(this.buildHeader());

    const description = document.createElement('p');
    description.className = 'sv-description';
    description.textContent = '描画・BGM・配色の設定を切り替えられます。';
    this.element.appendChild(description);

    // タブバー: 描画・BGM・配色の3面を切り替える。
    const tabPanels = new Map<SettingsTab, HTMLElement>();
    const tabs = new TabBar<SettingsTab>(
      [['graphics', '描画'], ['bgm', 'BGM'], ['theme', '配色']],
      (selectedTab) => {
        tabs.setSelected(selectedTab);
        for (const [tab, panel] of tabPanels) panel.hidden = tab !== selectedTab;
      },
    );
    tabs.element.classList.add('sv-tabs', 'ui-surface-inset');
    this.element.appendChild(tabs.element);

    // 見出し付きのタブ面を1つ作り、タブ切り替えで引けるよう tabPanels へ登録する。
    const addTabPanel = (tab: SettingsTab, title: string): HTMLElement => {
      const section = document.createElement('section');
      section.className = 'sv-section sv-tab-panel ui-surface-inset';
      section.setAttribute('role', 'tabpanel');
      section.setAttribute('aria-label', title);
      // タブで選ばれるまで隠しておく。
      section.hidden = true;
      const sectionTitle = document.createElement('h3');
      sectionTitle.textContent = title;
      section.appendChild(sectionTitle);
      const sectionBody = document.createElement('div');
      sectionBody.className = 'sv-section-body';
      section.appendChild(sectionBody);
      tabPanels.set(tab, section);
      return sectionBody;
    };

    // 3面それぞれの操作を、対応する自分の口へ繋ぎ替える。
    const graphicsSectionBody = addTabPanel('graphics', '描画');
    const graphicsPanel = new GraphicsPanel(graphics);
    graphicsPanel.onChange = (changed) => this.onGraphicsChange?.(changed);
    graphicsSectionBody.appendChild(graphicsPanel.element);

    const bgmSectionBody = addTabPanel('bgm', 'BGM');
    this.bgmPanel = new BgmSettingsPanel(bgm, bgmVolume);
    this.bgmPanel.onVolumeChange = (volume) => this.onBgmVolumeChange?.(volume);
    bgmSectionBody.appendChild(this.bgmPanel.element);

    const themeSectionBody = addTabPanel('theme', '配色');
    const themePanel = new ThemePanel();
    themePanel.onSelect = (id) => this.onThemeIdChange?.(id);
    themeSectionBody.appendChild(themePanel.element);

    for (const section of tabPanels.values()) this.element.appendChild(section);

    tabs.setSelected('graphics');
    const initialPanel = tabPanels.get('graphics');
    if (initialPanel !== undefined) initialPanel.hidden = false;
  }

  // 設定詳細面の見出しと説明用 eyebrow を組み立てる。
  private buildHeader(): HTMLElement {
    const header = document.createElement('div');
    header.className = 'sv-header';
    const headingGroup = document.createElement('div');
    headingGroup.className = 'sv-heading-group';
    const heading = document.createElement('h2');
    heading.id = 'hud-settings-title';
    heading.textContent = '設定';
    headingGroup.appendChild(heading);
    // 見出しに添える英字の小見出し。
    const eyebrow = document.createElement('span');
    eyebrow.className = 'sv-eyebrow';
    eyebrow.textContent = 'SYSTEM / SETTINGS';
    headingGroup.appendChild(eyebrow);
    header.appendChild(headingGroup);
    return header;
  }

  // 外から音量が変わったときに、BGM タブの表示を引き直す。
  public syncBgmVolume(volume: number): void {
    this.bgmPanel.syncVolume(volume);
  }

  // active の間を試聴の期間とし、切り替わったときに試聴を始める・終える。
  public setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    if (active) this.bgm.beginAudition();
    else this.bgmPanel.stopAudition();
  }
}
