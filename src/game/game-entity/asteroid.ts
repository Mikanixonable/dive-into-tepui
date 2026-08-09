// 重力を及ぼし、かつ重力の影響を受ける個別の小天体。GameEntity の通常の積分経路にそのまま乗る。
// game/celestial/asteroid-belt.ts・asteroid-field.ts の表示専用点群(重力・ピック・フォーカスの
// 対象にならない)とは別物。
import * as THREE from 'three/webgpu';
import { KinematicState } from '../../physics/kinematic-state';
import { GRAVITATIONAL_CONSTANT } from '../../physics/solar-system';
import { buildAsteroidMesh } from '../../render/ships';
import * as C from '../const';
import { GameEntity } from './game-entity';
import { EntityIdAllocator } from './entity-id';

const idAllocator = new EntityIdAllocator('asteroid-');

export class Asteroid extends GameEntity {
  protected readonly historyDuration = C.SHIP_HISTORY_DURATION;

  // mass [kg] 1つから mass(剛体接触の換算質量)と mu(= G・mass、重力定数 GM)の両方を導く —
  // 別々に受け取ると重力の強さと衝突の重さが食い違う。radius は物理半径 [m]。
  constructor(state: KinematicState, mass: number, radius: number, scene?: THREE.Scene, id?: string) {
    super(state, buildAsteroidMesh(radius), scene, undefined, idAllocator.next(id));
    this.mass = mass;
    this.mu = GRAVITATIONAL_CONSTANT * mass;
    this.radius = radius;
    this.collides = true;
  }
}
