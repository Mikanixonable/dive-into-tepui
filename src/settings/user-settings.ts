// ラン跨ぎのユーザー設定の正本。設定ごとの現在値を1つずつ起こし、保存先のどの鍵へ載せるかを決める。

import {
  DEFAULT_BGM_VOLUME, formatBgmMuted, formatBgmVolume, parseBgmMuted, parseBgmVolume,
} from '../audio/bgm/bgm';
import {
  formatOrbitGuideGroupTab, formatPanelCollapsed, formatViewOptionsTab,
  parseOrbitGuideGroupTab, parsePanelCollapsed, parseViewOptionsTab,
} from '../game/hud/hud-selection';
import { formatMapDisplayToggles, parseMapDisplayToggles } from '../game/map/display-toggles';
import { formatGridVisibility, parseGridVisibility } from '../render/celestial-grid';
import { formatGraphics, parseGraphics } from '../render/graphics-settings';
import { formatRenderStyle, parseRenderStyle } from '../render/render-style';
import { formatThemePalette, parseThemePalette } from '../theme';
import { StoredSetting } from './stored-setting';
import type { OrbitGuideGroupTab, PanelCollapsedState, ViewOptionsTab } from '../game/hud/hud-selection';
import type { MapDisplayToggles } from '../game/map/display-toggles';
import type { CelestialGridVisibility } from '../render/celestial-grid';
import type { GraphicsSettingsData } from '../render/graphics-settings';
import type { RenderStyle } from '../render/render-style';
import type { ThemePalette } from '../theme';
import type { SettingStorage } from './stored-setting';

// ビュー別でない折りたたみ状態の鍵。新しい鍵がまだ無い環境で、移行元として読む。
const LEGACY_PANEL_COLLAPSED_KEY = 'tepui.panelCollapsed';

export class UserSettings {
  // 描画の品質設定。
  public readonly graphics: StoredSetting<GraphicsSettingsData>;
  // 3D 世界を描く画面すべてが共有する見せ方。
  public readonly renderStyle: StoredSetting<RenderStyle>;
  // BGM のユーザー音量。0〜1。
  public readonly bgmVolume: StoredSetting<number>;
  // BGM を消音しているか。消音を解けば bgmVolume の音量で鳴る。
  public readonly bgmMuted: StoredSetting<boolean>;
  // 選ばれている配色。
  public readonly themePalette: StoredSetting<ThemePalette>;
  // マップに出す天体分類・個体種別のトグル。
  public readonly mapDisplayToggles: StoredSetting<MapDisplayToggles>;
  // 天球グリッドの表示。
  public readonly gridVisibility: StoredSetting<CelestialGridVisibility>;
  // HUD パネルのビュー別折りたたみ状態。
  public readonly panelCollapsed: StoredSetting<PanelCollapsedState>;
  // 表示パネルで選んでいるタブ。
  public readonly viewOptionsTab: StoredSetting<ViewOptionsTab>;
  // 軌道ガイドタブで選んでいる群タブ。
  public readonly orbitGuideGroupTab: StoredSetting<OrbitGuideGroupTab>;

  // storage は設定一式を残す先。鍵は既存ユーザーの保存に残っている文字列なので、変えると
  // 保存済みの設定が読めなくなる。
  public constructor(storage: SettingStorage) {
    // 画面全体に効く設定。
    this.graphics = new StoredSetting(storage, 'tepui.settings.graphics', parseGraphics, formatGraphics);
    this.renderStyle = new StoredSetting(storage, 'tepui.settings.renderStyle', parseRenderStyle, formatRenderStyle);
    this.bgmVolume = new StoredSetting(storage, 'tepui.settings.bgm_vol', parseBgmVolume, formatBgmVolume);
    this.bgmMuted = new StoredSetting(storage, 'tepui.settings.bgm_muted', parseBgmMuted, formatBgmMuted);
    this.themePalette = new StoredSetting(storage, 'tepui.theme-palette', parseThemePalette, formatThemePalette);
    // マップ・天球の表示に効く設定。
    this.mapDisplayToggles = new StoredSetting(
      storage, 'tepui.mapDisplayToggles', parseMapDisplayToggles, formatMapDisplayToggles,
    );
    this.gridVisibility = new StoredSetting(
      storage, 'tepui.gridVisibility', parseGridVisibility, formatGridVisibility,
    );
    // ランを跨いで残る HUD の選択。
    const legacyPanelCollapsed = storage.read(LEGACY_PANEL_COLLAPSED_KEY);
    this.panelCollapsed = new StoredSetting(
      storage, 'tepui.panelCollapsed.v2',
      (text) => parsePanelCollapsed(text, legacyPanelCollapsed), formatPanelCollapsed,
    );
    this.viewOptionsTab = new StoredSetting(
      storage, 'tepui.viewOptionsTab', parseViewOptionsTab, formatViewOptionsTab,
    );
    this.orbitGuideGroupTab = new StoredSetting(
      storage, 'tepui.orbitGuideGroupTab', parseOrbitGuideGroupTab, formatOrbitGuideGroupTab,
    );
  }

  // 消音を織り込んだ BGM の音量。
  public get audibleBgmVolume(): number {
    return this.bgmMuted.current ? 0 : this.bgmVolume.current;
  }

  // BGM の音量を volume にし、消音を解く。
  public setBgmVolume(volume: number): void {
    this.bgmVolume.set(volume);
    this.bgmMuted.set(false);
  }

  // BGM の消音を muted にする。音量 0 のまま解くと無音が続くので、そのときは既定の音量へ戻して解く。
  public setBgmMuted(muted: boolean): void {
    if (!muted && this.bgmVolume.current <= 0) this.bgmVolume.set(DEFAULT_BGM_VOLUME);
    this.bgmMuted.set(muted);
  }
}
