// 軌道ガイド(表示パネルの軌道ガイドタブ)の設定値。参照として描く軌道の種類ごとに、表示の
// 可否・本数・族の範囲・色・進行方向マーカー・安定度の見せ方を持ち、localStorage へ永続化する。
// どの系にどの種類があるかは焼き込みカタログが持ち、ここは選択だけを持つ。
import type { CatalogSystemId } from '../../physics/orbit-catalog';

// 軌道の種類をまとめる群。系のトグルは群ごとに1組持つ。
export type GuideGroupId = 'collinear' | 'triangular' | 'secondary' | 'resonant';

export const GUIDE_GROUPS: readonly GuideGroupId[] = ['collinear', 'triangular', 'secondary', 'resonant'];

// 進行方向マーカーの出し方。
export type DirectionMarkerMode = 'none' | 'single' | 'many';

// 1種類あたりに描ける線の本数の上限。
export const MAX_LINES_PER_KIND = 40;
// ゼロ速度曲線を一度に描ける本数の上限。
export const MAX_ZERO_VELOCITY_CURVES = 20;

// 軌道の種類1つぶんの表示設定。
export interface GuideKindSettings {
  readonly on: boolean;
  // 族から描く本数。1 なら族ではなく範囲の下限にあたる1本だけを描く。
  readonly count: number;
  // 族に沿った表示範囲。0 が族の始端、1 が終端。
  readonly rangeMin: number;
  readonly rangeMax: number;
  // 族の下限側・上限側の色(0xRRGGBB)。本数が1なら下限側だけを使う。
  readonly colorStart: number;
  readonly colorEnd: number;
  // 始と終を入れ替える。
  readonly reversed: boolean;
  readonly opacity: number;
  readonly direction: DirectionMarkerMode;
  readonly animate: boolean;
  // 安定な軌道を太く描く。
  readonly showStability: boolean;
}

// リサジュー軌道だけは連続な族として焼き込まないので、振幅と位相を直に指定する。
export interface LissajousSettings {
  readonly on: boolean;
  readonly inPlane: number; // 無次元(L点局所γ単位に対する比)
  readonly outOfPlane: number; // 無次元(L点局所γ単位に対する比)
  readonly inPlanePhase: number; // [rad]
  readonly outOfPlanePhase: number; // [rad]
  readonly cycles: number;
  readonly l1: boolean;
  readonly l2: boolean;
  readonly l3: boolean;
  readonly colorStart: number;
  readonly opacity: number;
  readonly direction: DirectionMarkerMode;
  readonly animate: boolean;
}

// ゼロ速度曲線(ガイドタブ)。断面は系と面の組で選ぶ。
export interface ZeroVelocitySettings {
  readonly earthMoonXY: boolean;
  readonly earthMoonXZ: boolean;
  readonly sunEarthXY: boolean;
  readonly sunEarthXZ: boolean;
  // 1本だけ描くか、範囲を等分して多数描くか。
  readonly multiple: boolean;
  readonly jacobi: number;
  readonly jacobiMin: number;
  readonly jacobiMax: number;
  readonly count: number;
  readonly opacity: number;
}

export interface OrbitGuideSettings {
  readonly geostationary: boolean;
  // 群ごとの系トグル。焼き込みカタログに無い系は UI に出さない。
  readonly systems: Readonly<Record<GuideGroupId, Readonly<Partial<Record<CatalogSystemId, boolean>>>>>;
  // 焼き込みカタログの族 id → その種類の表示設定。カタログに無い族の設定は無視される。
  readonly kinds: Readonly<Record<string, GuideKindSettings>>;
  readonly lissajous: LissajousSettings;
  readonly zeroVelocity: ZeroVelocitySettings;
}

// 種類ごとの設定の既定値。色は群ごとの色相を呼び出し側が与える。
export function defaultKindSettings(colorStart: number, colorEnd: number): GuideKindSettings {
  return {
    on: false,
    count: 5,
    rangeMin: 0.15,
    rangeMax: 0.6,
    colorStart,
    colorEnd,
    reversed: false,
    opacity: 0.4,
    direction: 'none',
    animate: false,
    showStability: false,
  };
}

const DEFAULT_SYSTEMS: Readonly<Partial<Record<CatalogSystemId, boolean>>> = {
  'earth-moon': true,
  'sun-earth': false,
};

export const DEFAULT_ORBIT_GUIDE_SETTINGS: OrbitGuideSettings = {
  geostationary: true,
  systems: {
    collinear: DEFAULT_SYSTEMS,
    triangular: DEFAULT_SYSTEMS,
    secondary: DEFAULT_SYSTEMS,
    resonant: DEFAULT_SYSTEMS,
  },
  kinds: {},
  lissajous: {
    on: false,
    inPlane: 0.1,
    outOfPlane: 0.2,
    inPlanePhase: 0,
    outOfPlanePhase: 0,
    cycles: 4,
    l1: true,
    l2: true,
    l3: false,
    colorStart: 0xb08bc9,
    opacity: 0.4,
    direction: 'none',
    animate: false,
  },
  zeroVelocity: {
    earthMoonXY: false,
    earthMoonXZ: false,
    sunEarthXY: false,
    sunEarthXZ: false,
    multiple: false,
    jacobi: 3.18,
    jacobiMin: 3.0,
    jacobiMax: 3.2,
    count: 5,
    opacity: 0.35,
  },
};

const STORAGE_KEY = 'tepui.orbitGuide';

function clamp(value: number, lo: number, hi: number): number {
  return Number.isFinite(value) ? Math.min(hi, Math.max(lo, value)) : lo;
}

// 保存データ・外部入力を安全な形に整える。範囲の上下が入れ替わっていれば直し、本数は正の整数へ丸める。
export function normalizeOrbitGuideSettings(settings: OrbitGuideSettings): OrbitGuideSettings {
  const kinds: Record<string, GuideKindSettings> = {};
  for (const [id, kind] of Object.entries(settings.kinds)) {
    const lo = clamp(kind.rangeMin, 0, 1);
    const hi = clamp(kind.rangeMax, 0, 1);
    kinds[id] = {
      ...kind,
      count: Math.max(1, Math.round(clamp(kind.count, 1, MAX_LINES_PER_KIND))),
      rangeMin: Math.min(lo, hi),
      rangeMax: Math.max(lo, hi),
      opacity: clamp(kind.opacity, 0, 1),
    };
  }
  const zv = settings.zeroVelocity;
  return {
    ...settings,
    kinds,
    lissajous: {
      ...settings.lissajous,
      cycles: Math.max(1, Math.round(settings.lissajous.cycles)),
      // Richardson近似の妥当域(目安 0〜0.3)へクランプする。旧保存データはメートル単位
      // だったため、無次元比として読み直すとこの範囲を大きく外れて安全に丸められる。
      inPlane: clamp(settings.lissajous.inPlane, 0.01, 0.3),
      outOfPlane: clamp(settings.lissajous.outOfPlane, 0.01, 0.3),
    },
    zeroVelocity: {
      ...zv,
      jacobiMin: Math.min(zv.jacobiMin, zv.jacobiMax),
      jacobiMax: Math.max(zv.jacobiMin, zv.jacobiMax),
      count: Math.max(1, Math.round(clamp(zv.count, 1, MAX_ZERO_VELOCITY_CURVES))),
    },
  };
}

// localStorage から設定を読み込む。壊れていれば既定値に戻る。
export function loadOrbitGuideSettings(): OrbitGuideSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_ORBIT_GUIDE_SETTINGS;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_ORBIT_GUIDE_SETTINGS;
    const stored = parsed as Partial<OrbitGuideSettings>;
    return normalizeOrbitGuideSettings({
      ...DEFAULT_ORBIT_GUIDE_SETTINGS,
      ...stored,
      systems: { ...DEFAULT_ORBIT_GUIDE_SETTINGS.systems, ...stored.systems },
      kinds: { ...stored.kinds },
      lissajous: { ...DEFAULT_ORBIT_GUIDE_SETTINGS.lissajous, ...stored.lissajous },
      zeroVelocity: { ...DEFAULT_ORBIT_GUIDE_SETTINGS.zeroVelocity, ...stored.zeroVelocity },
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
