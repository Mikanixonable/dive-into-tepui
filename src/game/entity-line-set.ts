// エンティティごとに1本の SampledLine を対応させ、対象集合から外れたエンティティの線を
// シーンから外して dispose する管理を担う。線の生成方法(色・不透明度・renderOrder)は
// 呼び出し側が factory で決め、このクラスはどのエンティティが線を持つかだけを管理する。
import * as THREE from 'three/webgpu';
import { GameEntity } from './game-entity/game-entity';
import { SampledLine } from '../render/sampled-line';

export class EntityLineSet {
  private readonly lines = new Map<GameEntity, SampledLine>();

  constructor(private readonly scene: THREE.Scene, private readonly factory: () => SampledLine) {}

  // entity の線を返す。まだ無ければ factory() で作りシーンへ登録する。
  lineFor(entity: GameEntity): SampledLine {
    let line = this.lines.get(entity);
    if (!line) {
      line = this.factory();
      this.scene.add(line.line);
      this.lines.set(entity, line);
    }
    return line;
  }

  // entity の線を、無ければ作らずに返す(有無や状態を問い合わせるだけの用途)。
  peek(entity: GameEntity): SampledLine | undefined {
    return this.lines.get(entity);
  }

  // alive に含まれないエンティティの線をシーンから外して dispose する(GPU リソースリークを防ぐ)。
  pruneTo(alive: ReadonlySet<GameEntity>): void {
    for (const [entity, line] of this.lines) {
      if (alive.has(entity)) continue;
      this.scene.remove(line.line);
      line.dispose();
      this.lines.delete(entity);
    }
  }
}
