// 自機の展開式ラジエーター: 上下2枚それぞれの展開度・健全度を持ち、
// 今フレームの放熱面積と太陽入射を答える。機体温度そのものは知らない
// (温度の4乗則を持つのは ThermalSystem のみ)。
import * as THREE from 'three/webgpu';
import { Attitude, qFromAxisAngle, qInvert, qRotate } from '../../physics/attitude';
import { Vec3, dot, len, sub, v3 } from '../../physics/vec3';
import { RADIATOR_OBJECT_NAMES, RADIATOR_TIP_DISTANCE } from '../../render/ships';
import * as C from '../const';

export type RadiatorSide = 'up' | 'down';

// ヒンジローカルの面法線(収納時、rotation.x = 0 での向き)。
const LOCAL_NORMAL: Record<RadiatorSide, Vec3> = {
  up: v3(0, 1, 0),
  down: v3(0, -1, 0),
};

class Panel {
  deployTarget: 0 | 1 = 0;
  deploy = 0;
  integrity = 1;
}

export class RadiatorSystem {
  private readonly panels: Record<RadiatorSide, Panel> = { up: new Panel(), down: new Panel() };
  private readonly hinges: Record<RadiatorSide, THREE.Object3D>;

  constructor(shipObj: THREE.Object3D) {
    const up = shipObj.getObjectByName(RADIATOR_OBJECT_NAMES.up);
    const down = shipObj.getObjectByName(RADIATOR_OBJECT_NAMES.down);
    if (!up || !down) throw new Error('radiator hinge objects not found in ship model');
    this.hinges = { up, down };
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

  // side のヒンジ角(rotation.x)を返す。sync がメッシュへ書く角度と solarLoad が法線計算に
  // 使う角度を同一にするための共有点。up/down で符号が逆(全開時に互いに反対の Y へ立ち上がる)。
  private hingeAngle(side: RadiatorSide): number {
    const sign = side === 'up' ? 1 : -1;
    return sign * (Math.PI / 2) * this.panels[side].deploy;
  }

  // ヒンジ Group の rotation.x を展開角へ同期する。
  sync(): void {
    for (const side of ['up', 'down'] as const) {
      this.hinges[side].rotation.x = this.hingeAngle(side);
    }
  }

  // side の有効な放熱面積 [m^2]。展開度と健全度で目減りする。
  private panelArea(side: RadiatorSide): number {
    const p = this.panels[side];
    return C.RADIATOR_PANEL_AREA * p.deploy * p.integrity;
  }

  // 放熱に使える面積 [m^2]。
  radiatingArea(): number {
    return this.panelArea('up') + this.panelArea('down');
  }

  // side の面法線(world 座標、単位ベクトル)。
  private worldNormal(side: RadiatorSide, att: Attitude): Vec3 {
    const hingeQ = qFromAxisAngle(v3(1, 0, 0), this.hingeAngle(side));
    const bodyNormal = qRotate(hingeQ, LOCAL_NORMAL[side]);
    return qRotate(att.q, bodyNormal);
  }

  // 日照面が受け取る太陽入射 [W]。sunlit は sunlitFactor の戻り値(0..1)、
  // sunDir は太陽方向の単位ベクトル(world)。
  solarLoad(sunlit: number, sunDir: Vec3, att: Attitude): number {
    return (['up', 'down'] as const).reduce((sum, side) => {
      const area = this.panelArea(side);
      const normal = this.worldNormal(side, att);
      const cosIncidence = Math.abs(dot(normal, sunDir));
      return sum + C.SOLAR_CONSTANT * C.RADIATOR_SOLAR_ABSORB * area * cosIncidence * sunlit;
    }, 0);
  }

  // 展開度に応じて広がった被弾判定半径 [m]。全開でパネル先端の実距離まで届く。
  hitRadius(): number {
    const maxDeploy = Math.max(this.panels.up.deploy, this.panels.down.deploy);
    return C.PLAYER_RADIUS + (RADIATOR_TIP_DISTANCE - C.PLAYER_RADIUS) * maxDeploy;
  }

  // 被弾位置から上下どちらのパネルへの命中かを判定し、健全度を減らす(回復はしない)。
  damageFromHit(hitR: Vec3, shipR: Vec3, att: Attitude): void {
    const worldOffset = sub(hitR, shipR);
    const bodyOffset = qRotate(qInvert(att.q), worldOffset);
    if (len(bodyOffset) <= C.PLAYER_HULL_RADIUS) return;

    const side: RadiatorSide = bodyOffset.y >= 0 ? 'up' : 'down';
    const p = this.panels[side];
    if (p.deploy < C.RADIATOR_HITTABLE_DEPLOY) return;
    p.integrity = Math.max(0, p.integrity - C.RADIATOR_HIT_INTEGRITY_LOSS);
  }

  // HUD 表示用。
  deployOf(side: RadiatorSide): number { return this.panels[side].deploy; }
  integrityOf(side: RadiatorSide): number { return this.panels[side].integrity; }
}
