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

  // 描画色・不透明度・renderOrder を指定して線を用意する。
  constructor(color: number, opacity = 0.85, renderOrder = 2) {
    this.sampled = new SampledLine(color, opacity, renderOrder);
  }

  // シーンに追加する描画対象。
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
    // 起点の編集か、表示終端の窓の移動かを判定する
    const edited = this.key === null || state0 !== this.key.state0 || maxSamples !== this.key.maxSamples;
    const windowMoved = this.key === null || end !== this.key.end;
    if (force || edited || windowMoved) {
      const now = performance.now();
      const throttle = edited ? C.PREDICT_DIRTY_THROTTLE_MS : C.PREDICT_REFRESH_INTERVAL_MS;
      // スロットル間隔を超えていれば RK4 で再計算する
      if (force || now - this.lastComputeMs >= throttle) {
        this.samples = predictTrajectory(state0, Math.max(0, end - state0.t), ephemeris, maxSamples);
        this.key = { state0, end, maxSamples };
        this.lastComputeMs = now;
      }
    }
    // 計算済みサンプルをジオメトリと変換行列に反映する
    this.sampled.syncGeometry(this.samples, frame, ephemeris);
    this.sampled.syncTransform(frame, currentTime, ephemeris, fo);
  }

  // 直近に計算した予測サンプル列を返す。
  samplesRef(): readonly OrbitState[] {
    return this.samples;
  }

  // 線の表示/非表示を切り替える。
  setVisible(v: boolean): void {
    this.sampled.setVisible(v);
  }

  // 保持している描画リソースを破棄する。
  dispose(): void {
    this.sampled.dispose();
  }
}
