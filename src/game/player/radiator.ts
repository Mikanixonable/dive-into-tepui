// 自機の展開式ラジエーター: 上下2枚それぞれの展開度・損耗度を持ち、
// 今フレームの放熱面積と太陽入射を答える。機体温度そのものは知らない
// (温度の4乗則を持つのは ThermalSystem のみ)。
import * as THREE from 'three/webgpu';
import { Attitude, qFromAxisAngle, qInvert, qRotate } from '../../physics/attitude';
import { Vec3, dot, len, sub, v3 } from '../../physics/vec3';
import {
  RADIATOR_DEPLOY_TILT,
  RADIATOR_TIP_DISTANCE,
  radiatorFoldName,
} from '../../render/ships';
import * as C from '../const';

export type RadiatorSide = 'up' | 'down';

// 収納時(deploy=0)の折り角。展開軸から ±90° で交互に折ると、隣り合う折り目の
// 方向ベクトルが完全に打ち消し合い、4折りが同一の 2.3×2.3 の正方形へ重なる。
const STOW_TILT = Math.PI / 2;

// side の展開方向の符号。up は +X、down は -X へ伸びる。
function sideSign(side: RadiatorSide): number {
  return side === 'up' ? 1 : -1;
}

class Panel {
  deployTarget: 0 | 1 = 0;
  deploy = 0;
  wear = 0;
}

export class RadiatorSystem {
  private readonly panels: Record<RadiatorSide, Panel> = { up: new Panel(), down: new Panel() };
  private readonly folds: Record<RadiatorSide, THREE.Object3D[]>;

  // shipObj は自機メッシュ。上下それぞれ、ヒンジ Group の子孫から折り目 Group を
  // RADIATOR_FOLD_COUNT 個解決して保持する。
  constructor(shipObj: THREE.Object3D) {
    const collect = (side: RadiatorSide): THREE.Object3D[] => {
      const found = Array.from({ length: C.RADIATOR_FOLD_COUNT }, (_, i) =>
        shipObj.getObjectByName(radiatorFoldName(side, i)));
      if (found.some((f) => !f)) throw new Error('radiator fold objects not found in ship model');
      return found as THREE.Object3D[];
    };
    this.folds = { up: collect('up'), down: collect('down') };
  }

  // side の展開/収納を切り替える。
  toggle(side: RadiatorSide): void {
    const p = this.panels[side];
    p.deployTarget = p.deployTarget === 0 ? 1 : 0;
  }

  // 展開度を指示値へ RADIATOR_DEPLOY_TIME 秒かけて近づける。数値のみを動かす(THREE には触れない)。
  update(dt: number): void {
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
      const broken = this.panels[side].wear >= 1;
      for (let i = 0; i < folds.length; i++) {
        const fold = folds[i];
        if (!fold) continue;
        fold.rotation.y = i === 0 ? even : (i % 2 === 1 ? odd - even : even - odd);
        fold.visible = !broken;
      }
    }
  }

  // side の有効な放熱面積 [m^2]。展開度と損耗度で目減りする。
  private panelArea(side: RadiatorSide): number {
    const p = this.panels[side];
    return C.RADIATOR_PANEL_AREA * C.RADIATOR_EFFICIENCY_MULT * p.deploy * (1 - p.wear);
  }

  // 放熱に使える面積 [m^2]。
  radiatingArea(): number {
    return this.panelArea('up') + this.panelArea('down');
  }

  // theta で折れた放熱面の法線(world 座標、単位ベクトル)。
  private worldNormal(theta: number, att: Attitude): Vec3 {
    const foldQ = qFromAxisAngle(v3(0, 1, 0), theta);
    const bodyNormal = qRotate(foldQ, v3(0, 0, 1));
    return qRotate(att.q, bodyNormal);
  }

  // 日照面が受け取る太陽入射 [W]。sunlit は sunlitFactor の戻り値(0..1)、
  // sunDir は太陽方向の単位ベクトル(world)。蛇腹は偶数/奇数折りで法線が異なるため、
  // 面積を半分ずつ割り当てて2方向ぶんを合算する。
  solarLoad(sunlit: number, sunDir: Vec3, att: Attitude): number {
    return (['up', 'down'] as const).reduce((sum, side) => {
      const halfArea = this.panelArea(side) / 2;
      const { even, odd } = this.foldThetas(side);
      const cosEven = Math.abs(dot(this.worldNormal(even, att), sunDir));
      const cosOdd = Math.abs(dot(this.worldNormal(odd, att), sunDir));
      return sum + C.SOLAR_CONSTANT * C.RADIATOR_SOLAR_ABSORB * halfArea * (cosEven + cosOdd) * sunlit;
    }, 0);
  }

  // 展開度に応じて広がった被弾判定半径 [m]。全開でパネル先端の実距離まで届く。
  hitRadius(): number {
    const maxDeploy = Math.max(this.panels.up.deploy, this.panels.down.deploy);
    return C.PLAYER_RADIUS + (RADIATOR_TIP_DISTANCE - C.PLAYER_RADIUS) * maxDeploy;
  }

  // 被弾位置から上下どちらのパネルへの命中かを判定し、損耗度を増やす(回復はしない)。
  // このフレームで新たに全損に達したら、その side を返す(既に全損していたら null)。
  damageFromHit(hitR: Vec3, shipR: Vec3, att: Attitude): RadiatorSide | null {
    const worldOffset = sub(hitR, shipR);
    const bodyOffset = qRotate(qInvert(att.q), worldOffset);
    if (len(bodyOffset) <= C.PLAYER_HULL_RADIUS) return null;

    const side: RadiatorSide = bodyOffset.x >= 0 ? 'up' : 'down';
    const p = this.panels[side];
    if (p.deploy < C.RADIATOR_HITTABLE_DEPLOY) return null;
    if (p.wear >= 1) return null;
    p.wear = Math.min(1, p.wear + C.RADIATOR_HIT_WEAR_PER_HIT);
    return p.wear >= 1 ? side : null;
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
  wearOf(side: RadiatorSide): number { return this.panels[side].wear; }
}
