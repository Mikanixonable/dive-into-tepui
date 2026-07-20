
import * as THREE from 'three';
import * as C from '../const';
import { Ship } from '../../game/entities';
import { Attitude } from '../../physics/attitude';
import { OrbitState } from '../../physics/orbital';
import { OrbitLine } from '../../render/orbitline';

export class Enemy extends Ship {
  accent: number; // マーカー色・集団識別。全敵が保持する
  waveId?: number; // stage00 のウェーブ敵のみ。生存ウェーブ集計に使う
  // 軌道線: 生成元(addEnemy)が生成直後に必ず設定する(scene への add も呼び出し側が行う)。
  orbitLine!: OrbitLine;

  // 実行時状態(遅延初期化)。未設定 = まだその状態に入っていない
  lastTargetedSim?: number; // 最後にロックオンされた時刻。LEAD マーカー表示の履歴
  lastFireSim?: number; // 最後に発砲判定した時刻。初回は発砲タイミングをずらすため遅延初期化
  burstLeft?: number; // バースト射撃の残弾
  burstDelay?: number; // 次のバースト弾までの残り時間

  constructor(
    name: string,
    state: OrbitState,
    obj: THREE.Object3D,
    att: Attitude,
    hp: number,
    accent: number,
    waveId?: number,
    scene?: THREE.Scene,
  ) {
    super(name, state, obj, att, C.ENEMY_RADIUS, hp, scene);
    this.accent = accent;
    this.waveId = waveId;
    this.mass = 10000;
    this.collideRadius = C.ENEMY_RADIUS;
    this.obj.scale.setScalar(C.ENEMY_SCALE);
  }

  dispose(): void {
    super.dispose();
    this.scene?.remove(this.orbitLine.line);
  }
}
