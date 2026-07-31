// エンティティ配列の保持・追加・上限管理・寿命回収・描画同期。
import { Vec3 } from '../../physics/vec3';
import { FloatingOrigin } from '../floating-origin';
import * as C from '../const';
import { GameEntity } from '../game-entity/game-entity';
import { Ammo } from '../game-entity/ammo';
import { DebrisPiece } from '../game-entity/debris-piece';
import { Enemy } from '../game-entity/enemy';
import { Bullet } from '../game-entity/bullet';
import type { Stage } from '../stages/stage';

export class EntityManager {
  readonly enemies: Enemy[] = [];
  readonly bullets: Bullet[] = [];
  readonly casings: DebrisPiece[] = [];
  readonly debris: DebrisPiece[] = [];
  readonly ammos: Ammo[] = [];

  addEnemy(enemy: Enemy): void {
    this.enemies.push(enemy);
  }

  addBullet(bullet: Bullet): void {
    this.addCapped(this.bullets, bullet, C.MAX_BULLETS * 3);
  }

  addDebris(piece: DebrisPiece): void {
    if (piece.kind === 'casing') this.addCapped(this.casings, piece, C.MAX_CASINGS);
    else this.addCapped(this.debris, piece, C.MAX_DEBRIS);
  }

  addAmmo(ammo: Ammo): void {
    this.ammos.push(ammo);
  }

  private addCapped<T extends GameEntity>(arr: T[], entity: T, cap: number): void {
    arr.push(entity);
    if (arr.length > cap) arr.shift()!.dispose();
  }

  all(): GameEntity[] {
    return [
      ...this.enemies,
      ...this.bullets,
      ...this.ammos,
      ...this.casings,
      ...this.debris
    ];
  }

  cleanup(dt: number, simTime: number, activeStage: Stage, playerPos: Vec3): void {
    for (const e of this.enemies) e.checkLoss(dt, simTime, activeStage, playerPos);
    for (const b of this.bullets) b.checkLoss(dt, simTime, activeStage, playerPos);
    for (const cs of this.casings) cs.checkLoss(dt, simTime, activeStage, playerPos);
    for (const d of this.debris) d.checkLoss(dt, simTime, activeStage, playerPos);
    for (const ammo of this.ammos) ammo.checkLoss(dt, simTime, activeStage, playerPos);
    this.prune(this.enemies);
    this.prune(this.bullets);
    this.prune(this.casings);
    this.prune(this.debris);
    this.prune(this.ammos);
  }

  // in-place フィルタ: 配列の参照はそのまま保つ。
  private prune<T extends GameEntity>(arr: T[]): void {
    let w = 0;
    for (const x of arr) {
      if (!x.alive) x.dispose();
      else arr[w++] = x;
    }
    arr.length = w;
  }

  sync(fo: FloatingOrigin, displayTime: number): void {
    this.all().forEach(e => e.sync(fo, displayTime));
  }
}
