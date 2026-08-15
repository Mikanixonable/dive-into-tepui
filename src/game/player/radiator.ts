// 自機の展開式ラジエーター: 上下2枚それぞれの展開度・損耗度を持ち、
// 今フレームの放熱面積と太陽入射を答える。機体温度そのものは知らない
// (温度の4乗則を持つのは ThermalSystem のみ)。
import * as THREE from 'three/webgpu';
import { Attitude, qFromAxisAngle, qRotate } from '../../physics/attitude';
import { kinematicState } from '../../physics/kinematic-state';
import { Vec3, add, cross, dot, v3 } from '../../physics/vec3';
import {
  RADIATOR_DEPLOY_TILT,
  RADIATOR_HINGE,
  RADIATOR_SEGMENT_LENGTH,
} from '../../render/ships';
import * as C from '../const';
import { GameEntity } from '../game-entity/game-entity';
import type { Attractor } from '../../physics/attractor';
import type { Contact } from '../simulation/contact';
import type { Stage } from '../stages/stage';
import type { Player } from './player';
import type { RadiatorSaveData } from '../save-data';

export type RadiatorSide = 'up' | 'down';

// 収納時(deploy=0)の折り角。展開軸から ±90° で交互に折ると、隣り合う折り目の
// 方向ベクトルが完全に打ち消し合い、4折りが同一の 2.3×2.3 の正方形へ重なる。
const STOW_TILT = Math.PI / 2;

// side の展開方向の符号。up は +X、down は -X へ伸びる。
function sideSign(side: RadiatorSide): number {
  return side === 'up' ? 1 : -1;
}

// theta(Y軸回転)だけ振れた、機体座標系 X 方向長さ x の変位。
function yRotatedOffset(theta: number, x: number): Vec3 {
  return v3(x * Math.cos(theta), 0, -x * Math.sin(theta));
}

// side の fold 番目の折りの中心位置(機体座標系)。RADIATOR_HINGE から蛇腹を辿り、
// 各折りの根本から半セグメント先(export-models.mjs の panel.position と同じ位置)を返す。
function foldLocalPosition(side: RadiatorSide, fold: number, even: number, odd: number): Vec3 {
  const sign = sideSign(side);
  let origin = v3(sign * RADIATOR_HINGE.x, RADIATOR_HINGE.y, RADIATOR_HINGE.z);
  for (let i = 0; i < fold; i++) {
    origin = add(origin, yRotatedOffset(i % 2 === 0 ? even : odd, sign * RADIATOR_SEGMENT_LENGTH));
  }
  return add(origin, yRotatedOffset(fold % 2 === 0 ? even : odd, sign * RADIATOR_SEGMENT_LENGTH / 2));
}

// 蛇腹1折りぶんの接触代理。艦の姿勢と展開度から一意に決まる剛体の取り付けなので、
// ベルトと違い Verlet 解法は要らず、毎フレーム RadiatorSystem.collisionFolds が置き直すだけでよい。
export class RadiatorFold extends GameEntity {
  // 位置は毎フレーム collisionFolds が置き直すので、ここでは原点で仮生成する。
  constructor(readonly side: RadiatorSide, readonly foldIndex: number, private readonly owner: Player) {
    super(kinematicState(0, v3(), v3()), new THREE.Object3D());
    this.mass = 5;
    this.radius = RADIATOR_SEGMENT_LENGTH / 2;
    this.collides = true;
    this.attachedTo = owner;
  }

  // 吊り元の艦、およびそれに取り付いた他の実体(放熱板の他の折り・ベルトの節点)とは接触しない。
  contactsWith(other: GameEntity | Attractor): boolean {
    if (other === this.owner) return false;
    return !(other instanceof GameEntity && other.attachedTo === this.owner);
  }

  // 帰結は owner の collideAtRadiator に委ねる。
  collideWith(other: GameEntity | Attractor, contact: Contact, activeStage: Stage): void {
    this.owner.collideAtRadiator(this.side, other, contact, activeStage);
  }
}

class Panel {
  deployTarget: 0 | 1 = 0;
  deploy = 0;
}

export class RadiatorSystem {
  private readonly panels: Record<RadiatorSide, Panel> = { up: new Panel(), down: new Panel() };
  // side ごとの損耗率(0=無傷, 1=全損)。放熱板パーツの残 HP から update() で受け取る。
  private wear: Record<RadiatorSide, number> = { up: 0, down: 0 };
  private readonly folds: Record<RadiatorSide, THREE.Object3D[]>;
  // side ごとの接触代理。折り数まで遅延生成し、以後は使い回す。
  private readonly foldProxies: Record<RadiatorSide, RadiatorFold[]> = { up: [], down: [] };

  // renderObject の上下それぞれのヒンジ Group から、折り目 Group を
  // RADIATOR_FOLD_COUNT 個解決して保持する。owner は接触代理が帰結を委ねる先の艦。
  public constructor(renderObject: THREE.Object3D, private readonly owner: Player, saved?: RadiatorSaveData) {
    const collect = (side: RadiatorSide, baseName: string): THREE.Object3D[] => {
      const namePrefix = baseName + (side === 'up' ? 'Up' : 'Down');
      const found = Array.from({ length: C.RADIATOR_FOLD_COUNT }, (_, i) =>
        renderObject.getObjectByName(`${namePrefix}Fold${i}`));
      if (found.some((f) => !f)) throw new Error(`${baseName} fold objects not found in ship model`);
      return found as THREE.Object3D[];
    };
    this.folds = { up: collect('up', 'radiator'), down: collect('down', 'radiator') };
    if (saved) {
      for (const side of ['up', 'down'] as const) {
        this.panels[side].deployTarget = saved[side].deployTarget;
        this.panels[side].deploy = saved[side].deploy;
      }
    }
  }

  // side の展開/収納を切り替える。
  toggle(side: RadiatorSide): void {
    const p = this.panels[side];
    p.deployTarget = p.deployTarget === 0 ? 1 : 0;
  }

  // 展開度を指示値へ RADIATOR_DEPLOY_TIME 秒かけて近づける。数値のみを動かす(THREE には触れない)。
  // wear は放熱板パーツの残 HP 由来の損耗率で、修理はドックでしか行えない。
  update(dt: number, wear: Record<RadiatorSide, number>): void {
    this.wear = wear;
    const step = dt / C.RADIATOR_DEPLOY_TIME;
    for (const side of ['up', 'down'] as const) {
      const p = this.panels[side];
      if (p.deploy < p.deployTarget) p.deploy = Math.min(p.deployTarget, p.deploy + step);
      else if (p.deploy > p.deployTarget) p.deploy = Math.max(p.deployTarget, p.deploy - step);
    }
  }

  // 展開度から折り角(展開軸からの傾き)を返す。deploy=0 で STOW_TILT、deploy=1 で
  // RADIATOR_DEPLOY_TILT へ線形補間する。
  private tilt(deploy: number): number {
    return STOW_TILT + (RADIATOR_DEPLOY_TILT - STOW_TILT) * deploy;
  }

  // 偶数折り目/奇数折り目それぞれの、ヒンジ基準での累積回転角。sync がメッシュへ書く
  // 相対回転と solarLoad が法線計算に使う絶対角を同一の psi から導く共有点。
  // 展開方向(モデル側の折り目オフセット)は side ごとに符号が付くので、回転角自体は
  // side に依らず ±psi で揃えられる。
  private foldThetas(side: RadiatorSide): { even: number; odd: number } {
    const sign = sideSign(side);
    const psi = this.tilt(this.panels[side].deploy);
    return { even: sign * psi, odd: -sign * psi };
  }

  // 各折り目 Group の rotation.y(親からの相対回転)を展開角へ同期し、全損したパネルの
  // 蛇腹を非表示にする。
  sync(): void {
    for (const side of ['up', 'down'] as const) {
      const { even, odd } = this.foldThetas(side);
      const folds = this.folds[side];
      const broken = this.wear[side] >= 1;
      for (let i = 0; i < folds.length; i++) {
        const fold = folds[i];
        const rotY = i === 0 ? even : (i % 2 === 1 ? odd - even : even - odd);

        if (fold) {
          fold.rotation.y = rotY;
          fold.visible = !broken;
        }
      }
    }
  }

  // side の有効な放熱面積 [m^2]。展開度と損耗度で目減りする。
  private panelArea(side: RadiatorSide, totalCoolingRate: number): number {
    if (this.wear[side] >= 1) return 0;
    return (totalCoolingRate / 2) * this.panels[side].deploy;
  }

  // 放熱に使える面積 [m^2]。
  radiatingArea(totalCoolingRate: number): number {
    return this.panelArea('up', totalCoolingRate) + this.panelArea('down', totalCoolingRate);
  }

  // theta で折れた放熱面の法線(world 座標、単位ベクトル)。
  private worldNormal(theta: number, att: Attitude): Vec3 {
    const foldQ = qFromAxisAngle(v3(0, 1, 0), theta);
    const shipNormal = qRotate(foldQ, v3(0, 0, 1));
    return qRotate(att.q, shipNormal);
  }

  // 日照面が受け取る太陽入射 [W]。sunlit は sunlitFactor の戻り値(0..1)、
  // sunDir は太陽方向の単位ベクトル(world)。蛇腹は偶数/奇数折りで法線が異なるため、
  // 面積を半分ずつ割り当てて2方向ぶんを合算する。
  solarLoad(sunlit: number, sunDir: Vec3, att: Attitude, totalCoolingRate: number): number {
    return (['up', 'down'] as const).reduce((sum, side) => {
      const halfArea = this.panelArea(side, totalCoolingRate) / 2;
      const { even, odd } = this.foldThetas(side);
      const cosEven = Math.abs(dot(this.worldNormal(even, att), sunDir));
      const cosOdd = Math.abs(dot(this.worldNormal(odd, att), sunDir));
      return sum + C.SOLAR_CONSTANT * C.RADIATOR_SOLAR_ABSORB * halfArea * (cosEven + cosOdd) * sunlit;
    }, 0);
  }

  // RADIATOR_CONTACT_DEPLOY 以上展開し、全損していない side の折りごとに接触代理を返す。
  // t は接触代理の KinematicState.t に使う現在時刻(swept 判定の区間を成す)。
  collisionFolds(shipR: Vec3, shipV: Vec3, att: Attitude, t: number): RadiatorFold[] {
    const result: RadiatorFold[] = [];
    for (const side of ['up', 'down'] as const) {
      if (this.panels[side].deploy < C.RADIATOR_CONTACT_DEPLOY || this.wear[side] >= 1) continue;
      const proxies = this.foldProxies[side];
      while (proxies.length < C.RADIATOR_FOLD_COUNT) proxies.push(new RadiatorFold(side, proxies.length, this.owner));
      const { even, odd } = this.foldThetas(side);
      // 各折りの機体座標系オフセットを、艦の位置・姿勢・角速度(回転による接線速度込み)で
      // world 座標へ変換する。
      for (const fold of proxies) {
        const bodyOffset = foldLocalPosition(side, fold.foldIndex, even, odd);
        const worldPos = add(shipR, qRotate(att.q, bodyOffset));
        const worldVel = add(shipV, qRotate(att.q, cross(att.w, bodyOffset)));
        fold.state = kinematicState(t, worldPos, worldVel);
        result.push(fold);
      }
    }
    return result;
  }

  // side の蛇腹の先端付近の world 座標を shipR 基準の Vec3 で返す。sync() 後の状態を前提にする。
  tipWorldPosition(side: RadiatorSide, shipR: Vec3, _att: Attitude): Vec3 {
    const fold = this.folds[side][this.folds[side].length - 1];
    if (!fold) return shipR;
    fold.updateWorldMatrix(true, false);
    const worldPos = new THREE.Vector3();
    fold.getWorldPosition(worldPos);
    return v3(shipR.x + worldPos.x, shipR.y + worldPos.y, shipR.z + worldPos.z);
  }

  // HUD 表示用。
  deployOf(side: RadiatorSide): number { return this.panels[side].deploy; }
  wearOf(side: RadiatorSide): number { return this.wear[side]; }

  // 損耗度(wear)は放熱板パーツの残 HP から導出される値なので含まない。
  serialize(): RadiatorSaveData {
    return {
      up: { deployTarget: this.panels.up.deployTarget, deploy: this.panels.up.deploy },
      down: { deployTarget: this.panels.down.deployTarget, deploy: this.panels.down.deploy },
    };
  }
}
