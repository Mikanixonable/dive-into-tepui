// エンティティ配列の保持・追加・上限管理・寿命回収・描画同期。
import { Vec3 } from '../../physics/vec3';
import { Attractor } from '../../physics/attractor';
import { FloatingOrigin } from '../floating-origin';
import * as C from '../const';
import { GameEntity } from '../game-entity/game-entity';
import { Ammo } from '../game-entity/ammo';
import { DebrisPiece } from '../game-entity/debris-piece';
import { Enemy } from '../game-entity/enemy';
import { Bullet } from '../game-entity/bullet';
import type { Player } from '../player/player';
import type { Stage } from '../stages/stage';
import type { CombatTarget } from '../targeter';

export class EntityManager {
  readonly enemies: Enemy[] = [];
  readonly bullets: Bullet[] = [];
  readonly casings: DebrisPiece[] = [];
  readonly debris: DebrisPiece[] = [];
  readonly ammos: Ammo[] = [];
  // 自機。操作対象(Game.player)もこの配列の1隻で、積分・衝突・寿命判定・予測では
  // 他の艦と対等に扱う。ステージモードでは1隻だけが入る。
  readonly players: Player[] = [];

  // 敵を登録する。
  addEnemy(enemy: Enemy): void {
    this.enemies.push(enemy);
  }

  // 自機を登録する。
  addPlayer(player: Player): void {
    this.players.push(player);
  }

  // 自機を取り除き、メッシュを破棄する。
  removePlayer(player: Player): void {
    const i = this.players.indexOf(player);
    if (i < 0) return;
    this.players.splice(i, 1);
    player.dispose();
  }

  // ターゲットとなり得るエンティティの一覧を取得する。
  getCombatTargets(excludePlayer: Player | null): CombatTarget[] {
    const players = excludePlayer ? this.players.filter(p => p !== excludePlayer) : this.players;
    return [...this.enemies, ...players];
  }

  // name で名指しされた自機を返す。見つからなければ null。
  findPlayer(id: string): Player | null {
    return this.players.find((p) => p.id === id) ?? null;
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

  // 自機以外の保持エンティティを1つの配列にまとめて返す。
  private otherEntities(): GameEntity[] {
    return [
      ...this.enemies,
      ...this.bullets,
      ...this.ammos,
      ...this.casings,
      ...this.debris,
    ];
  }

  // 保持する全エンティティを1つの配列にまとめて返す。
  all(): GameEntity[] {
    return [...this.otherEntities(), ...this.players];
  }

  // 全エンティティの寿命判定を行い、死亡したものを破棄・除去する。喪失した自機は撃墜演出と
  // 追従カメラの基準として残り続けるので、配列からは除かない。
  cleanup(dt: number, simTime: number, activeStage: Stage, playerPos: Vec3, bodies: readonly Attractor[]): void {
    for (const e of this.all()) e.checkLoss(dt, simTime, activeStage, playerPos, bodies);
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

  // 自機以外のメッシュを displayTime 時点の状態に同期する。自機はエフェクト・ベルト・
  // 軌道線まで持つので Player.syncPlayer が担当する。
  sync(fo: FloatingOrigin, displayTime: number): void {
    for (const e of this.otherEntities()) e.sync(fo, displayTime);
  }
}
