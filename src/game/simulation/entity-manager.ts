// エンティティ配列の保持・追加・上限管理・寿命回収・描画同期。
import { Vec3 } from '../../physics/vec3';
import { FloatingOrigin } from '../floating-origin';
import * as C from '../const';
import { GameEntity } from '../game-entity/game-entity';
import { Ammo } from '../game-entity/ammo';
import { DebrisPiece } from '../game-entity/debris-piece';
import { Enemy } from '../game-entity/enemy';
import { Bullet } from '../game-entity/bullet';
import { CreativeShip } from '../game-entity/creative-ship';
import type { Player } from '../player/player';
import type { Stage } from '../stages/stage';

export class EntityManager {
  readonly enemies: Enemy[] = [];
  readonly bullets: Bullet[] = [];
  readonly casings: DebrisPiece[] = [];
  readonly debris: DebrisPiece[] = [];
  readonly ammos: Ammo[] = [];
  // クリエイティブモードで配置された宇宙船。アクティブ艦(Game.player)もここに含まれ続ける
  // ので、行動・積分・寿命判定の各所は自機として別扱いする対象と二重処理しないよう
  // activePlayer との同一性で除外する。
  readonly creativeShips: CreativeShip[] = [];

  // 敵を登録する。
  addEnemy(enemy: Enemy): void {
    this.enemies.push(enemy);
  }

  // クリエイティブ艦を登録する。
  addCreativeShip(ship: CreativeShip): void {
    this.creativeShips.push(ship);
  }

  // クリエイティブ艦を取り除き、メッシュを破棄する。
  removeCreativeShip(ship: CreativeShip): void {
    const i = this.creativeShips.indexOf(ship);
    if (i < 0) return;
    this.creativeShips.splice(i, 1);
    ship.dispose();
  }

  // 弾を登録する。上限を超えた分は古いものから破棄する。
  addBullet(bullet: Bullet): void {
    this.addCapped(this.bullets, bullet, C.MAX_BULLETS * 3);
  }

  // 破片を種別(薬莢/その他)ごとの配列へ登録する。上限を超えた分は古いものから破棄する。
  addDebris(piece: DebrisPiece): void {
    if (piece.kind === 'casing') this.addCapped(this.casings, piece, C.MAX_CASINGS);
    else this.addCapped(this.debris, piece, C.MAX_DEBRIS);
  }

  // 弾薬ピックアップを登録する。
  addAmmo(ammo: Ammo): void {
    this.ammos.push(ammo);
  }

  // 配列へ追加し、cap を超えたら先頭(最古)を1件破棄する。
  private addCapped<T extends GameEntity>(arr: T[], entity: T, cap: number): void {
    arr.push(entity);
    if (arr.length > cap) arr.shift()!.dispose();
  }

  // 保持する全エンティティを1つの配列にまとめて返す。
  all(): GameEntity[] {
    return [
      ...this.enemies,
      ...this.bullets,
      ...this.ammos,
      ...this.casings,
      ...this.debris,
      ...this.creativeShips,
    ];
  }

  // 各配列の寿命判定を行い、死亡したエンティティを破棄・除去する。activePlayer は
  // creativeShips のうち呼び出し側が既に自機として checkLoss 済みの艦(二重判定を避ける)。
  cleanup(dt: number, simTime: number, activeStage: Stage, playerPos: Vec3, activePlayer: Player | null = null): void {
    // 生存判定
    for (const e of this.enemies) e.checkLoss(dt, simTime, activeStage, playerPos);
    for (const b of this.bullets) b.checkLoss(dt, simTime, activeStage, playerPos);
    for (const cs of this.casings) cs.checkLoss(dt, simTime, activeStage, playerPos);
    for (const d of this.debris) d.checkLoss(dt, simTime, activeStage, playerPos);
    for (const ammo of this.ammos) ammo.checkLoss(dt, simTime, activeStage, playerPos);
    for (const ship of this.creativeShips) if (ship !== activePlayer) ship.checkLoss(dt, simTime, activeStage, playerPos);
    // 死亡分を配列から除去
    this.prune(this.enemies);
    this.prune(this.bullets);
    this.prune(this.casings);
    this.prune(this.debris);
    this.prune(this.ammos);
    this.prune(this.creativeShips);
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

  // 保持する全エンティティのメッシュを displayTime 時点の状態に同期する。activePlayer は
  // Player.syncPlayer で別途リッチに同期済みなので、ここでは重ねて同期しない。
  sync(fo: FloatingOrigin, displayTime: number, activePlayer: Player | null = null): void {
    for (const e of this.all()) {
      if (e === activePlayer) continue;
      e.sync(fo, displayTime);
    }
  }
}
