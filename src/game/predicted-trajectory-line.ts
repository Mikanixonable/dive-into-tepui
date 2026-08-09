// GameEntity.predictedTrajectory(未来、数値積分で伸びていく予測軌道)を実線の折れ線として描く。
// 計画軌道(まだ実現していない要求)と対になる「実際に起きること」の線であり、破線にはしない。
import * as THREE from 'three/webgpu';
import { ReferenceFrame } from '../physics/frame';
import { Attractor } from '../physics/attractor';
import type { Ephemeris } from '../physics/ephemeris';
import { FloatingOrigin } from './floating-origin';
import { SampledLine, ScaleAtFn } from '../render/sampled-line';
import { GameEntity } from './game-entity/game-entity';
import { EntityLineSet } from './entity-line-set';

const LINE_COLOR = 0xbfc9d4;
const LINE_OPACITY = 0.55;

export class PredictedTrajectoryLine {
  private readonly lines: EntityLineSet;
  // lineFor は未登録のエンティティに対しても線を新規作成してしまうため、hasLineFor が
  // 誤って登録を増やさないよう、直近の sync で実際に描画対象にした集合をここで覚えておく。
  private synced = new Set<GameEntity>();

  constructor(scene: THREE.Scene) {
    this.lines = new EntityLineSet(scene, () => new SampledLine(LINE_COLOR, LINE_OPACITY, 1));
  }

  // targets: このフレームに予測軌道線を描きたい対象の集合。frame は bake の座標系、scale は
  // 折れ線の細分密度を決める画面スケール。
  sync(
    targets: readonly GameEntity[], frame: ReferenceFrame, simTime: number, ephemeris: Ephemeris,
    fo: FloatingOrigin, scale: ScaleAtFn, attractors: readonly Attractor[],
  ): void {
    for (const entity of targets) {
      const line = this.lines.lineFor(entity);
      const samples = entity.predictedTrajectory?.samplesOldestFirst() ?? [];
      line.syncGeometry(samples, frame, ephemeris, scale, attractors);
      line.syncTransform(frame, simTime, ephemeris, fo, attractors);
      line.setVisible(true);
    }
    this.synced = new Set(targets);
    this.lines.pruneTo(this.synced);
  }

  // entity の予測軌道線が実際に描画されているかを返す(頂点数が2未満なら SampledLine 自身が非表示になる)。
  hasLineFor(entity: GameEntity): boolean {
    if (!this.synced.has(entity)) return false;
    return this.lines.lineFor(entity).visible;
  }
}
