import * as THREE from 'three/webgpu';
import { GameEntity } from './game-entity';
import { KinematicState, kinematicState } from '../../physics/kinematic-state';
import { Attitude } from '../../physics/attitude';
import { v3 } from '../../physics/vec3';
import type { AnyPart, Part } from './parts';
import { restorePart } from './parts';
import { Player } from '../player/player';
import { buildBaseModel } from '../../render/ships';
import type { Hud } from '../hud/hud';
import type { Sfx } from '../../audio/sfx';
import type { EffectsSystem } from '../vfx/effects-system';
import type { MarkerManager } from '../marker/marker-manager';
import type { BaseSaveData } from '../save-data';
import { Attractor, strongestAttractor } from '../../physics/attractor';
import type { FloatingOrigin } from '../floating-origin';
import { OrbitLine } from '../../render/orbit-line';
import * as C from '../const';

// 収容中の艦のエントリ。parts は player.parts と同一参照(修理は艦へ直接反映される)。
// hp/maxHp は艦一覧タブ表示用の集計値で、修理のたびに書き戻す。
export interface DockedShipEntry {
  readonly id: string;
  readonly name: string;
  hp: number;
  maxHp: number;
  readonly parts: Part[];
  readonly player: Player;
}

export interface BaseState {
  money: number;
  inventory: AnyPart[];
  dockedShips: DockedShipEntry[];
}

let _baseIdCounter = 0;

export class Base extends GameEntity {
  readonly id: string;
  readonly orbitLine: OrbitLine;
  public baseState: BaseState = {
    money: 100000,
    inventory: [],
    dockedShips: []
  };

  constructor(state: KinematicState, scene: THREE.Scene, att?: Attitude) {
    super(state, buildBaseModel(), scene, att);
    this.mass = 1e6;
    this.collideRadius = 100;
    this.id = `base-${_baseIdCounter++}`;
    this.orbitLine = new OrbitLine(C.COLOR_BASE_ORBIT_LINE, 0.35);
    scene.add(this.orbitLine.line);
  }

  dispose(): void {
    super.dispose();
    this.scene?.remove(this.orbitLine.line);
    this.orbitLine.dispose();
  }

  // マップ表示中だけ軌道楕円を出す(敵の背景軌道線と同じ判断: 戦闘ビューは近距離を見るための
  // 視点なので、拠点ほど遠い周回全体を示す線は不要)。
  syncOrbitLine(show: boolean, fo: FloatingOrigin, bodies: readonly Attractor[]): void {
    const center = strongestAttractor(this.state.r, bodies);
    this.orbitLine.sync(show ? this.orbitalElementsAround(center) : null, fo);
  }

  // セーブデータへ変換する。格納艦は player.serialize() に委ねる。
  serialize(): BaseSaveData {
    return {
      id: this.id,
      r: { ...this.state.r },
      v: { ...this.state.v },
      money: this.baseState.money,
      inventory: this.baseState.inventory.map(p => ({ ...p })),
      dockedShips: this.baseState.dockedShips.map(entry => entry.player.serialize()),
    };
  }

  // 格納艦は Player を作り直して非アクティブ状態(alive=false・非表示)へ戻し、
  // DockedShipEntry を張り直す。entities.players へは追加しない(格納中の艦の定義)。
  static restore(
    data: BaseSaveData, simTime: number, scene: THREE.Scene,
    hud: Hud, sfx: Sfx, fx: EffectsSystem, markerManager: MarkerManager,
  ): Base {
    const state = kinematicState(simTime, v3(data.r.x, data.r.y, data.r.z), v3(data.v.x, data.v.y, data.v.z));
    const base = new Base(state, scene);
    base.baseState.money = data.money;
    base.baseState.inventory = data.inventory.map(restorePart);
    base.baseState.dockedShips = data.dockedShips.map((shipData) => {
      const player = Player.restore(shipData, simTime, hud, sfx, scene, fx, markerManager);
      player.alive = false;
      player.obj.visible = false;
      return {
        id: player.id,
        name: player.displayName,
        hp: player.hp,
        maxHp: player.maxHp,
        parts: player.parts,
        player,
      };
    });
    return base;
  }
}
