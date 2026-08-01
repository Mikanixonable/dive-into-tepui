// クリエイティブモード: 勝敗判定を発生させず、艦艇配置と軌道計画を自由に試すためのステージ。
import type * as THREE from 'three/webgpu';
import { Stage } from './stage';
import type { Player } from '../player/player';
import type { EntityManager } from '../simulation/entity-manager';
import type { SimSpeedManager } from '../sim-speed-manager';
import type { Hud } from '../hud/hud';
import type { Sfx } from '../../audio/sfx';
import type { EffectsSystem } from '../vfx/effects-system';
import type { MarkerManager } from '../marker/marker-manager';
import type { OrbitState } from '../../physics/orbital';
import * as C from '../const';
import { CreativeShip } from '../game-entity/creative-ship';

export class CreativeStage extends Stage {
  static readonly id = 'creative' as const;
  readonly selectLabel = 'CREATIVE';
  readonly selectSub = '軌道上に艦艇を自由に配置して眺める';
  readonly hiddenFromSelect = true;
  readonly selectKeys: string[] = [];
  readonly initialAmmo = { mags: 0, rounds: 0 };

  private _markerManager!: MarkerManager;

  briefingHtml(): string {
    return '<b>クリエイティブモード</b><br>マップから艦艇を配置して軌道を眺められる。';
  }

  // Stage.setup が受け取らない markerManager をここで補う。addShip が CreativeShip を
  // 組み立てるのに要る。
  setupCreative(markerManager: MarkerManager): void {
    this._markerManager = markerManager;
  }

  init(_player: Player, _entities: EntityManager): number {
    return 0;
  }

  // entities.creativeShips へ CreativeShip を1隻追加する。CREATIVE_MAX_SHIPS に達していれば
  // 追加せず null を返す。軌道要素を指定した配置 UI はここを呼ぶ。
  addShip(
    hud: Hud, sfx: Sfx, scene: THREE.Scene, fx: EffectsSystem,
    entities: EntityManager, name: string, initialState: OrbitState,
  ): CreativeShip | null {
    if (entities.creativeShips.length >= C.CREATIVE_MAX_SHIPS) return null;
    const ship = new CreativeShip(hud, sfx, scene, fx, this._markerManager, name, initialState);
    entities.addCreativeShip(ship);
    return ship;
  }

  // クリエイティブ艦を配置から取り除く。
  removeShip(entities: EntityManager, ship: CreativeShip): void {
    entities.removeCreativeShip(ship);
  }

  // 軌道計画への自動追従(followPlan)が ON の艦それぞれについて、次ノードの時刻へ達したかを
  // 見て、達していれば state をそのノードの絶対状態へ置き換えて消費する(有限推力のバーン模擬は
  // 行わない — ノードは既にバーン後の絶対状態のため、置き換えるだけで計画軌道と厳密に一致する)。
  update(_dt: number, _player: Player, entities: EntityManager, simTime: number, _simSpeed: SimSpeedManager): void {
    for (const ship of entities.creativeShips) this.advanceFollowPlan(ship, simTime);
  }

  private advanceFollowPlan(ship: CreativeShip, simTime: number): void {
    if (!ship.followPlan) return;
    let node = ship.plan.firstNode();
    while (node && node.t <= simTime) {
      ship.state = node;
      ship.plan.consumeFirstNode();
      node = ship.plan.firstNode();
    }
  }

  checkWin(): boolean {
    return false;
  }
}
