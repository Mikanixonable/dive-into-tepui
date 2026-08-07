import * as THREE from 'three/webgpu';
import { GameEntity } from './game-entity';
import { OrbitState, orbitState } from '../../physics/orbital';
import { Attitude } from '../../physics/attitude';
import { v3 } from '../../physics/vec3';
import type { AnyPart, Part } from './parts';
import { restorePart } from './parts';
import { Player } from '../player/player';
import type { Hud } from '../hud/hud';
import type { Sfx } from '../../audio/sfx';
import type { EffectsSystem } from '../vfx/effects-system';
import type { MarkerManager } from '../marker/marker-manager';
import type { BaseSaveData } from '../save-data';

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
  public baseState: BaseState = {
    money: 100000,
    inventory: [],
    dockedShips: []
  };

  constructor(state: OrbitState, scene: THREE.Scene, att?: Attitude) {
    // 基地の仮モデル: 白くて大きい球体 (後で適切なモデルに差し替え可能)
    const geo = new THREE.SphereGeometry(100, 32, 32);
    const mat = new THREE.MeshLambertMaterial({
      color: 0xaaccff,
      emissive: 0x112244,
    });
    const obj = new THREE.Mesh(geo, mat);
    
    super(state, obj, scene, att);
    this.mass = 1e6;
    this.collideRadius = 100;
    this.id = `base-${_baseIdCounter++}`;
  }

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
    const state = orbitState(simTime, v3(data.r.x, data.r.y, data.r.z), v3(data.v.x, data.v.y, data.v.z));
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
