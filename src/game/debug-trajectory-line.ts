// GameEntity.actualTrajectory.history(過去)と .predictedTrajectory.history(未来、あれば)を1本の折れ線として
// 描くデバッグ表示(better_predict.md Step 5)。「どのエンティティに、どう線を描くか」の表示仕様は
// まだ決まっていないため、エンティティ自身に線を持たせず(Enemy.orbitLine のような所有にすると
// 「全個体が常に自分の線を持つ」という仕様上の決定を先に固定してしまう)、描画側のこのモジュールが
// 「線を描く対象の集合」を毎フレーム引数で受け取る形にしてある。対象の変更・撤去はどちらも軽微で、
// エンティティごとの線の生成・破棄自体は EntityLineSet に委ねる。
//
// ?debugLines=1 のときだけ有効(PerfMeter の ?perf=1 と同じ、URL パラメータで自己完結する
// デバッグ表示のパターン)。無効時は SampledLine を1本も作らない。
import * as THREE from 'three/webgpu';
import { ReferenceFrame } from '../physics/frame';
import { KinematicState } from '../physics/kinematic-state';
import type { Ephemeris } from '../physics/ephemeris';
import { FloatingOrigin } from './floating-origin';
import { SampledLine, ScaleAtFn } from '../render/sampled-line';
import { GameEntity } from './game-entity/game-entity';
import { EntityLineSet } from './entity-line-set';

const LINE_COLOR = 0x40e0ff;

// 過去列・未来列それぞれの直近の参照と、それらを連結した結果を紐付けて憶える。連結先の
// SampledLine.syncGeometry は samples の参照同一性で再 bake を抑制するため、
// DynamicTrajectory.samplesOldestFirst() 自体が変わっていない毎フレームは spread で新しい
// 配列を作らずこのキャッシュを返す。
type ConcatCache = {
  current: readonly KinematicState[];
  predicted: readonly KinematicState[];
  combined: readonly KinematicState[];
};

export class DebugTrajectoryLine {
  readonly enabled: boolean;
  private readonly lines: EntityLineSet;
  private readonly concatCache = new Map<GameEntity, ConcatCache>();

  // ?debugLines=1 の指定を読み取り enabled を確定する。
  constructor(scene: THREE.Scene) {
    this.enabled = new URLSearchParams(location.search).get('debugLines') === '1';
    this.lines = new EntityLineSet(scene, () => new SampledLine(LINE_COLOR, 0.6, 1));
  }

  // targets: このフレームに線を描きたい対象の集合(呼び出し側が決める。既定は自機+ターゲット)。
  // frame は plan/plan-display.ts の PlanDisplay.planFrame と同じ値を渡す(bake の座標系)。
  // scale は折れ線の細分密度を決める画面スケール。
  sync(
    targets: readonly GameEntity[], frame: ReferenceFrame, simTime: number, ephemeris: Ephemeris,
    fo: FloatingOrigin, scale: ScaleAtFn,
  ): void {
    if (!this.enabled) return;

    for (const entity of targets) {
      const line = this.lines.lineFor(entity);
      // 過去列 → 現在状態 → 未来列(あれば)の順に連結する。sampleInterval を actualTrajectory/predictedTrajectory で
      // 共有しているため、現在時刻の点で密度が揃って連続する。
      const currentSamples = entity.actualTrajectory.samplesOldestFirst();
      let predictedSamples = entity.predictedTrajectory?.samplesOldestFirst() ?? [];
      if (currentSamples.length > 0 && predictedSamples.length > 0) {
        const lastCurrentTime = currentSamples[currentSamples.length - 1]!.t;
        const firstPredictedTime = predictedSamples[0]!.t;
        if (firstPredictedTime <= lastCurrentTime) {
          predictedSamples = [];
        }
      }
      const cached = this.concatCache.get(entity);
      const samples = cached && cached.current === currentSamples && cached.predicted === predictedSamples
        ? cached.combined
        : [...currentSamples, ...predictedSamples];
      this.concatCache.set(entity, { current: currentSamples, predicted: predictedSamples, combined: samples });
      line.syncGeometry(samples, frame, ephemeris, scale);
      line.syncTransform(frame, simTime, ephemeris, fo);
      line.setVisible(true);
    }
    const alive = new Set(targets);
    this.lines.pruneTo(alive);
    for (const entity of this.concatCache.keys()) {
      if (!alive.has(entity)) this.concatCache.delete(entity);
    }
  }
}
