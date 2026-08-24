// 軌道ガイド(表示パネルの軌道ガイドタブ)の設定値。参照として描く軌道の種類ごとに、表示の
// 可否・その種類が持つ軸・振幅や族範囲の値を持ち、localStorage へ永続化する。
// 軸は種類ごとに独立していて、ある種類の L1 を落としても他の種類は影響を受けない。

// 系とラグランジュ点の軸。ラグランジュ点まわりの軌道はどの種類もこの5つを持つ。
export interface GuideAxes {
  readonly sunEarth: boolean;
  readonly earthMoon: boolean;
  readonly l1: boolean;
  readonly l2: boolean;
  readonly l3: boolean;
}

// ハロー軌道。面外の突出が北か南かで鏡像の対をなすので南北の軸を持ち、値としては
// 族に沿った表示範囲(0=分岐直後の小振幅端、1=族末端)を持つ。
export interface HaloGuide extends GuideAxes {
  readonly on: boolean;
  readonly north: boolean;
  readonly south: boolean;
  readonly rangeMin: number;
  readonly rangeMax: number;
}

// 振幅ひとつで決まる種類(平面リヤプノフ=面内振幅、垂直リヤプノフ=面外振幅。いずれもメートル)。
export interface AmplitudeGuide extends GuideAxes {
  readonly on: boolean;
  readonly amplitude: number;
}

// リサジュー軌道。面内・面外の振幅を独立に取る [m]。
export interface LissajousGuide extends GuideAxes {
  readonly on: boolean;
  readonly inPlane: number;
  readonly outOfPlane: number;
}

// 遠距離逆行軌道。副天体を直接周回するのでラグランジュ点の軸を持たず、系と軌道半径 [m] だけを取る。
export interface DroGuide {
  readonly on: boolean;
  readonly sunEarth: boolean;
  readonly earthMoon: boolean;
  readonly amplitude: number;
}

export interface OrbitGuideSettings {
  readonly geostationary: boolean;
  readonly halo: HaloGuide;
  readonly planarLyapunov: AmplitudeGuide;
  readonly verticalLyapunov: AmplitudeGuide;
  readonly lissajous: LissajousGuide;
  readonly dro: DroGuide;
}

const DEFAULT_AXES: GuideAxes = { sunEarth: true, earthMoon: true, l1: true, l2: true, l3: false };

export const DEFAULT_ORBIT_GUIDE_SETTINGS: OrbitGuideSettings = {
  geostationary: true,
  halo: { ...DEFAULT_AXES, on: false, north: true, south: true, rangeMin: 0.15, rangeMax: 0.6 },
  planarLyapunov: { ...DEFAULT_AXES, on: false, amplitude: 20_000_000 },
  verticalLyapunov: { ...DEFAULT_AXES, on: false, amplitude: 30_000_000 },
  lissajous: { ...DEFAULT_AXES, on: false, inPlane: 15_000_000, outOfPlane: 30_000_000 },
  dro: { on: false, sunEarth: true, earthMoon: true, amplitude: 60_000_000 },
};

const STORAGE_KEY = 'tepui.orbitGuide';

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

// 保存データ・外部入力を安全な形に整える。族の範囲は 0..1 に丸め、下限が上限を超えていれば入れ替える。
export function normalizeOrbitGuideSettings(settings: OrbitGuideSettings): OrbitGuideSettings {
  const lo = clamp01(settings.halo.rangeMin);
  const hi = clamp01(settings.halo.rangeMax);
  return { ...settings, halo: { ...settings.halo, rangeMin: Math.min(lo, hi), rangeMax: Math.max(lo, hi) } };
}

// localStorage から設定を読み込む。壊れていれば既定値に戻る。
export function loadOrbitGuideSettings(): OrbitGuideSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_ORBIT_GUIDE_SETTINGS;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_ORBIT_GUIDE_SETTINGS;
    const stored = parsed as Partial<Record<keyof OrbitGuideSettings, object>>;
    return normalizeOrbitGuideSettings({
      ...DEFAULT_ORBIT_GUIDE_SETTINGS,
      ...(parsed as Partial<OrbitGuideSettings>),
      halo: { ...DEFAULT_ORBIT_GUIDE_SETTINGS.halo, ...stored.halo },
      planarLyapunov: { ...DEFAULT_ORBIT_GUIDE_SETTINGS.planarLyapunov, ...stored.planarLyapunov },
      verticalLyapunov: { ...DEFAULT_ORBIT_GUIDE_SETTINGS.verticalLyapunov, ...stored.verticalLyapunov },
      lissajous: { ...DEFAULT_ORBIT_GUIDE_SETTINGS.lissajous, ...stored.lissajous },
      dro: { ...DEFAULT_ORBIT_GUIDE_SETTINGS.dro, ...stored.dro },
    });
  } catch {
    return DEFAULT_ORBIT_GUIDE_SETTINGS;
  }
}

// 設定を localStorage へ保存する。保存できない環境では黙って諦める(次回は既定値)。
export function saveOrbitGuideSettings(settings: OrbitGuideSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* localStorage 不可なら保存しない */
  }
}
