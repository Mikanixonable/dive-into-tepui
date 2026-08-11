// GameEntity ごとに1本、数値積分された点列を実線の折れ線として描く。予測モード(既定)は
// GameEntity.predictedTrajectory(未来、数値積分で伸びていく予測軌道)だけを描き、計画軌道
// (まだ実現していない要求)と対になる「実際に起きること」の線であるため破線にはしない。
// デバッグモードは ?debugLines=1 のときだけ有効になる自己完結の URL パラメータゲート付きで、
// actualTrajectory.history(過去)+ predictedTrajectory.history(未来、あれば)を1本に連結して描く。
import * as THREE from 'three/webgpu';
import { ReferenceFrame } from '../physics/frame';
import { KinematicState } from '../physics/kinematic-state';
import { Attractor } from '../physics/attractor';
import type { Ephemeris } from '../physics/ephemeris';
import { FloatingOrigin } from './floating-origin';
import { EMPTY_SAMPLES, TrajectoryLine } from './trajectory-line';
import { GameEntity } from './game-entity/game-entity';
import { EntityLineSet } from './entity-line-set';
import { LINE_RENDER_ORDER } from './const';

type Mode = 'predicted' | 'debug';

const MODE_COLOR: Record<Mode, number> = { predicted: 0xbfc9d4, debug: 0x40e0ff };
const MODE_OPACITY: Record<Mode, number> = { predicted: 0.55, debug: 0.6 };

// 過去列・未来列それぞれの直近の参照と、それらを連結した結果を紐付けて憶える。連結先の
// TrajectoryLine.syncGeometry は samples の参照同一性で再 bake を抑制するため、
// DynamicTrajectory.samplesOldestFirst() 自体が変わっていない毎フレームは spread で新しい
// 配列を作らずこのキャッシュを返す。debug モードでのみ使う。
type ConcatCache = {
  current: readonly KinematicState[];
  predicted: readonly KinematicState[];
  combined: readonly KinematicState[];
};

export class EntityTrajectoryLine {
  readonly enabled: boolean;
  private readonly mode: Mode;
  private readonly lines: EntityLineSet;
  private readonly targetSet = new Set<GameEntity>();
  private readonly concatCache = new Map<GameEntity, ConcatCache>();

  private constructor(scene: THREE.Scene, mode: Mode) {
    this.mode = mode;
    this.enabled = mode === 'predicted' || new URLSearchParams(location.search).get('debugLines') === '1';
    this.lines = new EntityLineSet(
      scene, () => new TrajectoryLine(MODE_COLOR[mode], MODE_OPACITY[mode], LINE_RENDER_ORDER.predicted),
    );
  }

  // GameEntity.predictedTrajectory(未来、数値積分で伸びていく予測軌道)だけを描く。計画軌道
  // (まだ実現していない要求)と対になる「実際に起きること」の線であるため破線にはしない。
  static predicted(scene: THREE.Scene): EntityTrajectoryLine {
    return new EntityTrajectoryLine(scene, 'predicted');
  }

  // actualTrajectory.history(過去)+ predictedTrajectory(未来、あれば)を1本に連結して描く。
  // ?debugLines=1 が指定されているときだけ有効になる自己完結の URL パラメータゲート付き。
  static debug(scene: THREE.Scene): EntityTrajectoryLine {
    return new EntityTrajectoryLine(scene, 'debug');
  }

  private samplesFor(entity: GameEntity): readonly KinematicState[] {
    if (this.mode === 'predicted') return entity.predictedTrajectory?.samplesOldestFirst() ?? EMPTY_SAMPLES;

    const currentSamples = entity.actualTrajectory.samplesOldestFirst();
    let predictedSamples = entity.predictedTrajectory?.samplesOldestFirst() ?? EMPTY_SAMPLES;
    if (currentSamples.length > 0 && predictedSamples.length > 0) {
      const lastCurrentTime = currentSamples[currentSamples.length - 1]!.t;
      const firstPredictedTime = predictedSamples[0]!.t;
      if (firstPredictedTime <= lastCurrentTime) predictedSamples = [];
    }
    const cached = this.concatCache.get(entity);
    const samples = cached && cached.current === currentSamples && cached.predicted === predictedSamples
      ? cached.combined
      : [...currentSamples, ...predictedSamples];
    this.concatCache.set(entity, { current: currentSamples, predicted: predictedSamples, combined: samples });
    return samples;
  }

  // targets: このフレームに線を描きたい対象の集合。frame は bake の座標系(予測モードでは
  // 計画軌道の折れ線と同じ座標系を渡すこと)、camera は解像度を決める画面上のサジッタを
  // 実距離へ換算するための描画カメラ。
  sync(
    targets: readonly GameEntity[], frame: ReferenceFrame, simTime: number, ephemeris: Ephemeris,
    fo: FloatingOrigin, camera: THREE.Camera, attractors: readonly Attractor[],
  ): void {
    if (!this.enabled) return;

    for (const entity of targets) {
      const line = this.lines.lineFor(entity);
      const samples = this.samplesFor(entity);
      line.syncGeometry(samples, frame, ephemeris, attractors);
      line.syncTransform(frame, simTime, ephemeris, fo, attractors);
      line.sync(camera);
      line.setVisible(true);
    }
    this.targetSet.clear();
    for (const entity of targets) this.targetSet.add(entity);
    this.lines.pruneTo(this.targetSet);
    if (this.mode === 'debug') {
      for (const entity of this.concatCache.keys()) {
        if (!this.targetSet.has(entity)) this.concatCache.delete(entity);
      }
    }
  }

  // entity の予測軌道線が、表示中の時間範囲 [simTime, simTime + horizon] を最後まで覆っているかを返す。
  // 解析楕円は「予測が間に合っていないあいだの代替表示」なので、その抑制可否はこの問いで決まる —
  // 天体貫入などで打ち切られた列はそれ以上伸びないので、覆えていなくても代替は要らない。
  coversHorizon(entity: GameEntity, simTime: number, horizon: number): boolean {
    const line = this.lines.peek(entity);
    if (!line || !line.visible) return false;
    if (entity.predictionTruncated) return true;
    const tip = entity.predictedTrajectory?.state.t;
    return tip !== undefined && tip >= simTime + horizon;
  }
}
