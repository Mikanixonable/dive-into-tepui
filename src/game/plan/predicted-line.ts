// 指定期間の数値予測軌道を1本の折れ線として描く arc 単位のユニット。
// 入力変化を検出してスロットル付きで RK4 再計算し、描画は SampledLine へ委譲する。
import * as THREE from 'three/webgpu';
import { OrbitState } from '../../physics/orbital';
import { predictTrajectory } from '../../physics/predict';
import { Frame } from '../../physics/frame';
import type { Ephemeris } from '../../physics/ephemeris';
import { FloatingOrigin } from '../floating-origin';
import { SampledLine } from '../../render/sampled-line';
import * as C from '../const';

type ComputeKey = { state0: OrbitState; end: number; maxSamples: number };

export class PredictedLine {
  private readonly sampled: SampledLine;
  private samples: OrbitState[] = [];
  private key: ComputeKey | null = null;
  private lastComputeMs = -Infinity;

  constructor(color: number, opacity = 0.85, renderOrder = 2) {
    this.sampled = new SampledLine(color, opacity, renderOrder);
  }

  get object3d(): THREE.Object3D {
    return this.sampled.line;
  }

  // force=true でスロットルを無視して即再計算する(窓の滑りと区別できない非連続な end 変化時)。
  update(
    state0: OrbitState,
    end: number,
    ephemeris: Ephemeris,
    frame: Frame,
    currentTime: number,
    fo: FloatingOrigin,
    maxSamples = C.PREDICT_MAX_SAMPLES,
    force = false,
  ): void {
    const edited = this.key === null || state0 !== this.key.state0 || maxSamples !== this.key.maxSamples;
    const windowMoved = this.key === null || end !== this.key.end;
    if (force || edited || windowMoved) {
      const now = performance.now();
      const throttle = edited ? C.PREDICT_DIRTY_THROTTLE_MS : C.PREDICT_REFRESH_INTERVAL_MS;
      if (force || now - this.lastComputeMs >= throttle) {
        this.samples = predictTrajectory(state0, Math.max(0, end - state0.t), ephemeris, maxSamples);
        this.key = { state0, end, maxSamples };
        this.lastComputeMs = now;
      }
    }
    this.sampled.syncGeometry(this.samples, frame, ephemeris);
    this.sampled.syncTransform(frame, currentTime, ephemeris, fo);
  }

  samplesRef(): readonly OrbitState[] {
    return this.samples;
  }

  setVisible(v: boolean): void {
    this.sampled.setVisible(v);
  }

  dispose(): void {
    this.sampled.dispose();
  }
}
