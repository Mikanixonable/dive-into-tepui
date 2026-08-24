// ハロー軌道パネルの設定値。マップのガイドとして描くラグランジュ点周期軌道の内訳
// (系・点・南北・族範囲・発展ファミリー)を1つの構造に持ち、localStorage へ永続化する。
// パネルが操作する内訳だけを持ち、ガイド全体の ON/OFF は天球グリッドのトグルが担う。

// 発展ファミリーの1件分。amplitude の意味はファミリーごとに異なる(平面リヤプノフ=面内振幅、
// 垂直リヤプノフ=面外振幅、DRO=軌道半径。いずれもメートル)。
export interface FamilyToggle {
  readonly on: boolean;
  readonly amplitude: number;
}

// リサジュー軌道だけは面内・面外の振幅を独立に持つ。
export interface LissajousToggle {
  readonly on: boolean;
  readonly inPlane: number;
  readonly outOfPlane: number;
}

export interface HaloGuideSettings {
  readonly north: boolean;
  readonly south: boolean;
  readonly l1: boolean;
  readonly l2: boolean;
  readonly l3: boolean;
  readonly sunEarth: boolean;
  readonly earthMoon: boolean;
  // ハロー族に沿った表示範囲。0=分岐直後(ラグランジュ点に近い小振幅端)、1=族末端(NRHO側)。
  readonly rangeMin: number;
  readonly rangeMax: number;
  readonly planarLyapunov: FamilyToggle;
  readonly verticalLyapunov: FamilyToggle;
  readonly lissajous: LissajousToggle;
  readonly dro: FamilyToggle;
}

export const DEFAULT_HALO_GUIDE_SETTINGS: HaloGuideSettings = {
  north: true,
  south: true,
  l1: true,
  l2: true,
  l3: false,
  sunEarth: true,
  earthMoon: true,
  rangeMin: 0.15,
  rangeMax: 0.6,
  planarLyapunov: { on: false, amplitude: 20_000_000 },
  verticalLyapunov: { on: false, amplitude: 30_000_000 },
  lissajous: { on: false, inPlane: 15_000_000, outOfPlane: 30_000_000 },
  dro: { on: false, amplitude: 60_000_000 },
};

const STORAGE_KEY = 'tepui.haloGuide';

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

// 保存データ・外部入力を安全な形に整える。範囲は 0..1 に丸め、min > max なら入れ替える。
export function normalizeHaloGuideSettings(settings: HaloGuideSettings): HaloGuideSettings {
  const lo = clamp01(settings.rangeMin);
  const hi = clamp01(settings.rangeMax);
  return { ...settings, rangeMin: Math.min(lo, hi), rangeMax: Math.max(lo, hi) };
}

// localStorage から設定を読み込む。壊れていれば既定値に戻る。
export function loadHaloGuideSettings(): HaloGuideSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_HALO_GUIDE_SETTINGS;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_HALO_GUIDE_SETTINGS;
    const merged = {
      ...DEFAULT_HALO_GUIDE_SETTINGS,
      ...(parsed as Partial<HaloGuideSettings>),
      planarLyapunov: { ...DEFAULT_HALO_GUIDE_SETTINGS.planarLyapunov, ...(parsed as { planarLyapunov?: object }).planarLyapunov },
      verticalLyapunov: { ...DEFAULT_HALO_GUIDE_SETTINGS.verticalLyapunov, ...(parsed as { verticalLyapunov?: object }).verticalLyapunov },
      lissajous: { ...DEFAULT_HALO_GUIDE_SETTINGS.lissajous, ...(parsed as { lissajous?: object }).lissajous },
      dro: { ...DEFAULT_HALO_GUIDE_SETTINGS.dro, ...(parsed as { dro?: object }).dro },
    };
    return normalizeHaloGuideSettings(merged);
  } catch {
    return DEFAULT_HALO_GUIDE_SETTINGS;
  }
}

// 設定を localStorage へ保存する。保存できない環境では黙って諦める(次回は既定値)。
export function saveHaloGuideSettings(settings: HaloGuideSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* localStorage 不可なら保存しない */
  }
}
