// GameEntity.predictedTrajectory(未来、数値積分で伸びていく予測軌道)を実線の折れ線として描く。
// 計画軌道(まだ実現していない要求)と対になる「実際に起きること」の線であり、破線にはしない。
import * as THREE from 'three/webgpu';
import { ReferenceFrame } from '../physics/frame';
import { Attractor } from '../physics/attractor';
import type { Ephemeris } from '../physics/ephemeris';
import { FloatingOrigin } from './floating-origin';
import { EMPTY_SAMPLES, SampledLine, ScaleAtFn } from '../render/sampled-line';
import { GameEntity } from './game-entity/game-entity';
import { EntityLineSet } from './entity-line-set';
import { LINE_RENDER_ORDER } from './const';

const LINE_COLOR = 0xbfc9d4;
const LINE_OPACITY = 0.55;

export class PredictedTrajectoryLine {
  private readonly lines: EntityLineSet;
  private readonly targetSet = new Set<GameEntity>();

  constructor(scene: THREE.Scene) {
    this.lines = new EntityLineSet(
      scene, () => new SampledLine(LINE_COLOR, LINE_OPACITY, LINE_RENDER_ORDER.predicted),
    );
  }

  // targets: このフレームに予測軌道線を描きたい対象の集合。frame は bake の座標系、scale は
  // 折れ線の細分密度を決める画面スケール。
  sync(
    targets: readonly GameEntity[], frame: ReferenceFrame, simTime: number, ephemeris: Ephemeris,
    fo: FloatingOrigin, scale: ScaleAtFn, attractors: readonly Attractor[],
  ): void {
    for (const entity of targets) {
      const line = this.lines.lineFor(entity);
      const samples = entity.predictedTrajectory?.samplesOldestFirst() ?? EMPTY_SAMPLES;
      line.syncGeometry(samples, frame, ephemeris, scale, attractors);
      line.syncTransform(frame, simTime, ephemeris, fo, attractors);
      line.setVisible(true);
    }
    this.targetSet.clear();
    for (const entity of targets) this.targetSet.add(entity);
    this.lines.pruneTo(this.targetSet);
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
