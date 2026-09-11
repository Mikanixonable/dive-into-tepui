// 個体1体ぶんの残基変形を進める。投影サイズから LOD を選び、OU 過程を標本化して、その
// フレームのモード係数を確定させる。
import {
  mix32,
  ProteinBrownianSampler,
  proteinBrownianSeedFor,
  UINT32_SCALE,
} from './protein-brownian-motion';
import { projectProteinResidues } from './protein-motion-modes';
import { LODS_FINE_TO_COARSE } from './protein-display';
import type { ProteinMotionLod, ProteinPhase } from './protein-display';
import type { ProteinRenderMotion } from './protein-render-definition';

type ProteinMotionBand = ProteinRenderMotion['modes'][number]['band'];

export const PROTEIN_MOTION_LOD_MODE_COUNTS: Readonly<Record<ProteinMotionLod, number>> = {
  near: 24,
  medium: 12,
  far: 4,
  marker: 0,
};

/** 表示専用の phase gain。物理的な ANM 振幅は変えない。 */
export const PROTEIN_MOTION_PHASE_GAINS: Readonly<Record<ProteinPhase, number>> = {
  intact: 1,
  exposed: 1,
  dissociated: 1,
  critical: 1.5,
};

// LOD ごとの最小投影直径 [px]。
const LOD_MIN_PROJECTED_PX: Readonly<Record<ProteinMotionLod, number>> = {
  near: 160, medium: 40, far: 8, marker: 0,
};
// 閾値ちょうどで毎フレーム LOD が往復しないための不感帯。
const LOD_HYSTERESIS_RATIO = 0.15;

/**
 * 画面投影直径 [px] から次の LOD を選ぶ。`previous` を跨いだヒステリシスを掛けるため、
 * より細かい LOD へ上げるには自身の閾値を +15% 上回る必要があり、より粗い LOD へ下げるには
 * 現在の LOD の閾値を -15% 下回る必要がある。大きな距離の飛び(seek 直後など)では複数段
 * まとめて遷移する。
 */
export function proteinMotionLodForProjectedSize(diameterPx: number, previous: ProteinMotionLod): ProteinMotionLod {
  // NaN は 0(marker側)へ、+Infinity(視点が無く LOD を判断できない呼び出し)は近距離側へ倒す。
  const safeDiameter = diameterPx >= 0 ? diameterPx : 0;
  let index = LODS_FINE_TO_COARSE.indexOf(previous);
  if (index < 0) index = 0;
  for (;;) {
    const currentMin = LOD_MIN_PROJECTED_PX[LODS_FINE_TO_COARSE[index]!];
    if (index < LODS_FINE_TO_COARSE.length - 1 && safeDiameter < currentMin * (1 - LOD_HYSTERESIS_RATIO)) {
      index += 1;
      continue;
    }
    if (index > 0) {
      const finerMin = LOD_MIN_PROJECTED_PX[LODS_FINE_TO_COARSE[index - 1]!];
      if (safeDiameter >= finerMin * (1 + LOD_HYSTERESIS_RATIO)) {
        index -= 1;
        continue;
      }
    }
    return LODS_FINE_TO_COARSE[index]!;
  }
}

const MAX_MOTION_MODES = PROTEIN_MOTION_LOD_MODE_COUNTS.near;
const MEDIUM_UPDATE_HZ = 30;
const FAR_UPDATE_HZ = 15;
/** LOD 切替時、旧 LOD の変位から新 LOD の変位へ表示上ブレンドする時間 [s]。 */
export const PROTEIN_MOTION_LOD_FADE_DURATION_SEC = 0.25;

function finiteNonNegative(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** 粗い LOD の更新境界をずらすための、安定した [0, 1) の位相。 */
export function proteinMotionUpdatePhaseFor(enemyId: string): number {
  const seed = proteinBrownianSeedFor(enemyId);
  return mix32(seed ^ 0xa511e9b3) / UINT32_SCALE;
}

function safeDisplayTime(time: number): number {
  if (!Number.isFinite(time) || time <= 0) return 0;
  return Math.min(time, Number.MAX_SAFE_INTEGER / 1_000_000);
}

function updateHzFor(lod: ProteinMotionLod): number {
  switch (lod) {
    case 'medium': return MEDIUM_UPDATE_HZ;
    case 'far': return FAR_UPDATE_HZ;
    case 'near': return Number.POSITIVE_INFINITY;
    case 'marker': return 0;
  }
}

function modeCountFor(lod: ProteinMotionLod, availableModes: number): number {
  return Math.min(PROTEIN_MOTION_LOD_MODE_COUNTS[lod], availableModes);
}

function gainForBand(
  band: ProteinMotionBand,
  collectiveGain: number,
  localGain: number,
): number {
  return band === 'collective' ? collectiveGain : localGain;
}

/**
 * OU 過程からモードごとの振幅を取り出し、求められたときだけ、指定された残基の小集合について
 * xyz 変位へ投影する。Three.js や原子・リボン・表面の binding のことは意図的に何も知らない。
 */
export class ProteinMotionController {
  public readonly enemyId: string;
  public readonly residueCount: number;
  public readonly modeCount: number;
  public readonly updatePhase: number;
  public readonly collectiveGain: number;
  public readonly localGain: number;

  private readonly modes: readonly ProteinRenderMotion['modes'][number][];
  private readonly sampler: ProteinBrownianSampler;
  private readonly modeCoefficientsBuffer: Float64Array;
  private readonly effectiveCoefficientsBuffer: Float32Array;
  private readonly rawCoefficientsBuffer: Float32Array;
  private readonly fadeFromCoefficientsBuffer: Float32Array;
  private readonly modeGains: Float64Array;
  private currentLod: ProteinMotionLod = 'near';
  private currentModeCount = 0;
  private lastRawSampleTime = Number.NaN;
  private lastSampleTime = Number.NaN;
  private currentPhase: ProteinPhase = 'intact';
  private fading = false;
  private fadeStartTime = 0;

  // asset の固定モードと個体固有 seed から、再利用する計算バッファを初期化する。
  public constructor(
    private readonly asset: ProteinRenderMotion,
    enemyId: string,
  ) {
    if (!Number.isInteger(asset.residueCount) || asset.residueCount < 0) {
      throw new RangeError('Protein motion residueCount must be a non-negative integer');
    }
    if (asset.modes.length > MAX_MOTION_MODES) {
      throw new RangeError(`Protein motion supports at most ${MAX_MOTION_MODES} modes`);
    }

    this.enemyId = enemyId;
    this.residueCount = asset.residueCount;
    this.modeCount = asset.modes.length;
    this.currentModeCount = Math.min(MAX_MOTION_MODES, this.modeCount);
    this.modes = asset.modes;
    this.updatePhase = proteinMotionUpdatePhaseFor(enemyId);
    this.collectiveGain = finiteNonNegative(asset.display.collectiveGain, 1);
    this.localGain = finiteNonNegative(asset.display.localGain, 1);
    // OU sampler と係数バッファは個体の寿命中再利用し、毎フレームの割り当てを避ける。
    this.sampler = new ProteinBrownianSampler(
      this.modes.map((mode) => ({
        relaxationRate: mode.displayRelaxationRate,
        rmsAmplitude: mode.physicalRmsAngstrom ?? mode.displayRmsAngstrom!,
      })),
      asset.display.sampleHz,
      proteinBrownianSeedFor(enemyId),
    );
    this.modeCoefficientsBuffer = new Float64Array(this.modeCount);
    this.effectiveCoefficientsBuffer = new Float32Array(this.modeCount);
    this.rawCoefficientsBuffer = new Float32Array(this.modeCount);
    this.fadeFromCoefficientsBuffer = new Float32Array(this.modeCount);
    // band 別 gain は asset だけで決まるため、構築時に焼いておく。
    this.modeGains = new Float64Array(this.modeCount);
    for (let modeIndex = 0; modeIndex < this.modeCount; modeIndex += 1) {
      const mode = this.modes[modeIndex]!;
      this.modeGains[modeIndex] = gainForBand(mode.band, this.collectiveGain, this.localGain);
    }
  }

  /** この係数バッファは、このコントローラーの生存期間中ずっと同じインスタンスを指す。 */
  public get modeCoefficients(): Float64Array {
    return this.modeCoefficientsBuffer;
  }

  /**
   * gain・phase gain・LOD によるモード数の打ち切り・LOD 切替の fade を折り込んだモード係数
   * (打ち切られたモードは 0)。GPU の compute pass はこれと asset のモード変位を掛けて残基変位を
   * 作る。`projectResidues` は同じことを CPU 側で、残基の小集合についてだけ行う。
   */
  public get effectiveModeCoefficients(): Float32Array {
    return this.effectiveCoefficientsBuffer;
  }

  /**
   * いまのモード係数を、列挙された残基についてだけ `target`(残基あたり vec4)へ投影する。
   * 列挙されなかった残基の要素は書き換えない。範囲外・非整数の残基インデックスは無視する。
   */
  public projectResidues(residues: readonly number[], target: Float32Array): void {
    projectProteinResidues(this.asset, this.effectiveCoefficientsBuffer, residues, target);
  }

  public get activeModeCount(): number {
    return this.currentModeCount;
  }

  /** いまのモード係数が表している、量子化済みの表示時刻。 */
  public get sampleTime(): number {
    return this.lastSampleTime;
  }

  /**
   * 表示時刻・LOD・構造フェーズでモード係数を確定させ、`effectiveModeCoefficients` へ書く。
   * LOD が変わったときは、それまでの係数から新しい係数へ表示時刻で
   * `PROTEIN_MOTION_LOD_FADE_DURATION_SEC` かけて混ぜる — 変位は係数の線形結合なので、
   * これは変位そのものを混ぜるのと同じ結果になる。切替中も毎フレーム `sampleAt` を呼ぶだけでよい。
   */
  public sampleAt(
    time: number,
    lod: ProteinMotionLod,
    phase: ProteinPhase = this.currentPhase,
  ): void {
    // LOD・量子化時刻・phase のいずれかが変わったときだけ、生の係数を求め直す。
    const output = this.effectiveCoefficientsBuffer;
    const nextModeCount = modeCountFor(lod, this.modeCount);
    const rawSampleTime = nextModeCount === 0 ? 0 : this.sampleTimeFor(time, lod);
    const safeTime = safeDisplayTime(time);
    const inputsChanged = lod !== this.currentLod || nextModeCount !== this.currentModeCount
      || rawSampleTime !== this.lastRawSampleTime || phase !== this.currentPhase;

    if (!inputsChanged && !this.fading) return;

    if (inputsChanged) {
      if (lod !== this.currentLod) {
        this.fadeFromCoefficientsBuffer.set(output);
        this.fading = true;
        this.fadeStartTime = safeTime;
      }
      this.currentLod = lod;
      this.currentModeCount = nextModeCount;
      this.currentPhase = phase;
      this.lastRawSampleTime = rawSampleTime;
      this.computeCoefficients(this.rawCoefficientsBuffer, rawSampleTime, nextModeCount, phase);
    }

    // LOD 遷移中だけ旧係数からの補間を続け、完了後は生の係数をそのまま返す。
    if (!this.fading) {
      output.set(this.rawCoefficientsBuffer);
      this.lastSampleTime = rawSampleTime;
      return;
    }

    const fadeT = Math.min(1, Math.max(0, (safeTime - this.fadeStartTime) / PROTEIN_MOTION_LOD_FADE_DURATION_SEC));
    for (let index = 0; index < output.length; index += 1) {
      const from = this.fadeFromCoefficientsBuffer[index]!;
      output[index] = from + (this.rawCoefficientsBuffer[index]! - from) * fadeT;
    }
    this.lastSampleTime = safeTime;
    if (fadeT >= 1) this.fading = false;
  }

  /** OU 過程を標本化し、gain・phase gain・LOD によるモード数の打ち切りを掛けて `target` へ書く。 */
  private computeCoefficients(target: Float32Array, sampleTime: number, activeModeCount: number, phase: ProteinPhase): void {
    target.fill(0);
    if (activeModeCount === 0) return;
    this.sampler.sampleAt(sampleTime, this.modeCoefficientsBuffer);
    const phaseGain = PROTEIN_MOTION_PHASE_GAINS[phase];
    for (let modeIndex = 0; modeIndex < activeModeCount; modeIndex += 1) {
      target[modeIndex] = this.modeCoefficientsBuffer[modeIndex]! * this.modeGains[modeIndex]! * phaseGain;
    }
  }

  private sampleTimeFor(time: number, lod: ProteinMotionLod): number {
    const safeTime = safeDisplayTime(time);
    const updateHz = updateHzFor(lod);
    if (!Number.isFinite(updateHz)) return safeTime;
    // 絶対時刻を量子化することで、粗い更新をフレームレートに依存させない。
    // enemy の phase が量子化の境界をずらし、sampler の seed が各 enemy の軌跡を独立させる。
    return Math.floor(safeTime * updateHz + this.updatePhase) / updateHz;
  }
}
