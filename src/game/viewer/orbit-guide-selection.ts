// 軌道ガイドとして、どの参照軌道をどう描くかの選択。
import {
  DEFAULT_ORBIT_GUIDE_SETTINGS, normalizeOrbitGuideSettings, deserializeOrbitGuideSettings,
} from './orbit-guide-settings';
import type { OrbitGuideSettings } from './orbit-guide-settings';

// 軌道ガイドの選択を読む口。
export interface OrbitGuideSource {
  // 現在の軌道ガイドの設定。範囲・本数は丸め済み。
  readonly settings: OrbitGuideSettings;
}

export class OrbitGuideSelection implements OrbitGuideSource {
  private _settings: OrbitGuideSettings;

  // セーブに残っていた設定 saved を読み直して始める。無ければ既定から始める。
  public constructor(saved: Partial<OrbitGuideSettings> | undefined) {
    this._settings = saved === undefined ? DEFAULT_ORBIT_GUIDE_SETTINGS : deserializeOrbitGuideSettings(saved);
  }

  public get settings(): OrbitGuideSettings { return this._settings; }

  // 設定を settings へ差し替える。範囲・本数は丸めてから持つ。
  public setSettings(settings: OrbitGuideSettings): void {
    this._settings = normalizeOrbitGuideSettings(settings);
  }
}
