// 重力を及ぼし、かつ重力の影響を受ける個別の小天体。GameEntity の通常の積分経路にそのまま乗る。
// game/celestial/point-field.ts・point-field-view.ts の表示専用点群(重力・ピック・フォーカスの
// 対象にならない)とは別物。
import * as THREE from 'three/webgpu';
import { KinematicState } from '../../physics/kinematic-state';
import { Attitude, qRotate } from '../../physics/attitude';
import { v3 } from '../../physics/vec3';
import { buildAsteroidMesh } from '../../render/ships';
import * as C from '../const';
import { GameEntity } from './game-entity';
import { EntityIdAllocator } from './entity-id';

const idAllocator = new EntityIdAllocator('asteroid-');

export class Asteroid extends GameEntity {
  protected readonly baseHistoryDuration = C.SHIP_HISTORY_DURATION;
  protected readonly predictedAsPlanCollider = true;

  // mass [kg] は剛体接触の換算質量と重力定数 mu を兼ねる。radius は物理半径 [m]。
  // j2/c22 は既定 0(質点)。非零なら自転極(モデル +Y)・長軸(モデル +Z)を姿勢から組んだ
  // degree2 を持つ — 小惑星は姿勢が変化しないので構築時に1度だけ組む。
  constructor(
    state: KinematicState, mass: number, radius: number,
    scene?: THREE.Scene, att?: Attitude, id?: string, j2 = 0, c22 = 0,
  ) {
    super(state, buildAsteroidMesh(radius), scene, att, idAllocator.next(id));
    this.setGravitatingMass(mass);
    this.radius = radius;
    this.collides = true;
    if (j2 !== 0 || c22 !== 0) {
      this.degree2 = {
        j2,
        refRadius: radius,
        pole: qRotate(this.att.q, v3(0, 1, 0)),
        tesseral: c22 === 0 ? null : { c22, longAxis: qRotate(this.att.q, v3(0, 0, 1)) },
      };
    }
  }
}
