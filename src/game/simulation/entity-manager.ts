// エンティティ配列の保持・追加・上限管理・寿命回収・描画同期。実シミュレーション(軌道積分・
// 弾命中・剛体接触・慣性姿勢積分)は Simulator の責務で、Simulator はここが持つ配列への参照を
// 受け取って回す。Game が所有し、各所(Stage・Enemy.behave・HitSystem・Targeter・Logistics・
// EffectsSystem・NanWatchdog)へ参照共有される唯一の窓口。
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
  // casings/debris は DebrisPiece の kind によって振り分けられる別々の上限プール
  // (薬莢は撃破デブリより大量・頻繁に出るため、上限を分けて管理する)。
  readonly casings: DebrisPiece[] = [];
  readonly debris: DebrisPiece[] = [];
  readonly ammos: Ammo[] = [];

  // 配列への追加はここを通す。上限管理があるのは大量・頻繁に出る bullets/casings/debris
  // (addCapped 経由)だけで、enemies/ammos は無制限。scene への登録は entity 自身の
  // コンストラクタが既に済ませている。破壊は alive = false にすれば cleanup が回収するので、
  // 削除関数は持たない。

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

  // 上限超過時は最古の個体をシーンから外す(弾・薬莢のジオメトリは共有なので破棄しない)
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

  // 不要になったものを除去する。simTime/playerPos は checkLoss(弾の「自機から離れすぎたら
  // 消す」判定など)へそのまま渡すだけで、simTime 自体の保持は Simulator の責務。
  cleanup(dt: number, simTime: number, activeStage: Stage, playerPos: Vec3): void {
    for (const e of this.enemies) e.checkLoss(dt, simTime, activeStage, playerPos);
    for (const b of this.bullets) b.checkLoss(dt, simTime, activeStage, playerPos);
    for (const cs of this.casings) cs.checkLoss(dt, simTime, activeStage, playerPos);
    for (const d of this.debris) d.checkLoss(dt, simTime, activeStage, playerPos);
    for (const ammo of this.ammos) ammo.checkLoss(dt, simTime, activeStage, playerPos);
    // alive=false になったものを配列から除去して scene から片付ける(dispose)。
    this.prune(this.enemies);
    this.prune(this.bullets);
    this.prune(this.casings);
    this.prune(this.debris);
    this.prune(this.ammos);
  }

  // in-place フィルタ: 配列の参照はそのまま保つ(ctx スナップショット越しの参照を無効化しない)
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
