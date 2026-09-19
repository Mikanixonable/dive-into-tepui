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
  public constructor(private _settings: OrbitGuideSettings = DEFAULT_ORBIT_GUIDE_SETTINGS) {}

  // 直列化された設定から復元する。欠けた項目は既定値で補い、範囲・本数を丸める。
  public static deserialize(serialized: Partial<OrbitGuideSettings>): OrbitGuideSelection {
    return new OrbitGuideSelection(deserializeOrbitGuideSettings(serialized));
  }

  public get settings(): OrbitGuideSettings { return this._settings; }

  // 直列化した形。
  public serialize(): OrbitGuideSettings { return this._settings; }

  // 設定を settings へ差し替える。範囲・本数は丸めてから持つ。
  public setSettings(settings: OrbitGuideSettings): void {
    this._settings = normalizeOrbitGuideSettings(settings);
  }
}
