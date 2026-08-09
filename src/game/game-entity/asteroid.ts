// 重力を及ぼし、かつ重力の影響を受ける個別の小天体。GameEntity の通常の積分経路にそのまま乗る。
// game/celestial/point-field.ts・point-field-view.ts の表示専用点群(重力・ピック・フォーカスの
// 対象にならない)とは別物。
import * as THREE from 'three/webgpu';
import { KinematicState } from '../../physics/kinematic-state';
import { buildAsteroidMesh } from '../../render/ships';
import * as C from '../const';
import { GameEntity } from './game-entity';
import { EntityIdAllocator } from './entity-id';

const idAllocator = new EntityIdAllocator('asteroid-');

export class Asteroid extends GameEntity {
  protected readonly historyDuration = C.SHIP_HISTORY_DURATION;

  // mass [kg] は剛体接触の換算質量と重力定数 mu を兼ねる。radius は物理半径 [m]。
  constructor(state: KinematicState, mass: number, radius: number, scene?: THREE.Scene, id?: string) {
    super(state, buildAsteroidMesh(radius), scene, undefined, idAllocator.next(id));
    this.setGravitatingMass(mass);
    this.radius = radius;
    this.collides = true;
  }
}
