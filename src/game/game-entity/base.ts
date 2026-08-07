import * as THREE from 'three/webgpu';
import { GameEntity } from './game-entity';
import { OrbitState } from '../../physics/orbital';
import { Attitude } from '../../physics/attitude';
import type { AnyPart, Part } from './parts';
import type { Player } from '../player/player';

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
}
