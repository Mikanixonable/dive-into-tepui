// 自機の展開式ラジエーター: 上下2枚それぞれの展開度・損耗度を持ち、
// 今フレームの放熱面積と太陽入射を答える。
import { Attitude } from '../../physics/attitude';
import { LOCAL_FORWARD, LOCAL_UP, qFromAxisAngle, qRotate } from '../../math/quat';
import { KinematicState, kinematicState } from '../../physics/kinematic-state';
import { add, cross, dot, rotateAxis, v3, Vec3 } from '../../math/vec3';
import {
  RADIATOR_DEPLOY_TILT,
  RADIATOR_HINGE,
  RADIATOR_SEGMENT_LENGTH,
} from '../../physics/player-shape';
import type { Contact } from '../dynamic/dynamic-entity/contact';
import type { RadiatorSaveData } from '../save/save-data';
import {
  DynamicMotion,
  type DynamicMotionBehavior,
  type DynamicReactionServices,
} from '../dynamic/dynamic-motion';

const RADIATOR_FOLD_COUNT = 6; // 蛇腹の折り数(1枚あたり)
export const RADIATOR_DEPLOY_TIME = 3.0; // 収納⇔全開にかかる時間 [s]
const RADIATOR_SOLAR_ABSORB = 0.15; // 日照面の太陽光吸収率

const RADIATOR_CONTACT_DEPLOY = 0.15; // これ以上展開していると被弾対象になる展開度

export type RadiatorSide = 'up' | 'down';

// 収納時(deploy=0)の折り角。展開軸から ±90° で交互に折ると隣り合う折り目の変位が
// 打ち消し合い、蛇腹全体が1セグメントぶんの位置へ畳まれる。
const STOW_TILT = Math.PI / 2;

// side の展開方向の符号。up は +X、down は -X へ伸びる。
function sideSign(side: RadiatorSide): number {
  return side === 'up' ? 1 : -1;
}

// theta(Y軸回転)だけ振れた、機体座標系 X 方向長さ x の変位。
function yRotatedOffset(theta: number, x: number): Vec3 {
  return rotateAxis(v3(x, 0, 0), LOCAL_UP, theta);
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

// 蛇腹1折りぶんの接触代理。艦の姿勢と展開度から一意に決まる剛体の取り付け。
class RadiatorFold extends DynamicMotion {
  // state は生成時点の実際の world 状態 — 仮の状態で始めると、最初に置き直した substep の
  // prevState がその仮位置になり、そこからの偽の区間を掃引してしまう。
  public constructor(
    side: RadiatorSide,
    owner: DynamicMotion,
    state: KinematicState,
    onContact: RadiatorContactReaction,
  ) {
    const behavior: DynamicMotionBehavior = {
      contactKind: 'radiator-fold',
      contactsWith: (_self, other) => other !== owner && other.attachedTo !== owner,
      onEntityContact: (_self, other, contact, context) => onContact(side, other, contact, context),
    };
    super(state, { mass: 5, radius: RADIATOR_SEGMENT_LENGTH / 2, collides: true, behavior });
    this.attachedTo = owner;
  }
}

interface RadiatorContactReaction {
  (
    side: RadiatorSide,
    other: DynamicMotion,
    contact: Contact,
    context: DynamicReactionServices,
  ): void;
}

class Panel {
  deployTarget: 0 | 1 = 0;
  deploy = 0;
}

export class RadiatorSystem {
  private readonly panels: Record<RadiatorSide, Panel> = { up: new Panel(), down: new Panel() };
  // side ごとの損耗率(0=無傷, 1=全損)。
  private wear: Record<RadiatorSide, number> = { up: 0, down: 0 };
  // side ごとの接触代理。折り数まで遅延生成し、以後は使い回す。
  private readonly foldProxies: Record<RadiatorSide, RadiatorFold[]> = { up: [], down: [] };

  // 艦本体へ接触代理を結び、接触後のゲーム上の反応を受け取る。saved があれば展開状態を復元する。
  public constructor(
    private readonly owner: DynamicMotion,
    private readonly onContact: RadiatorContactReaction,
    saved?: RadiatorSaveData,
  ) {
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

  // side の展開目標を明示的に設定する。HUD の「展開」「収納」ボタンから使う。
  setDeployed(side: RadiatorSide, deployed: boolean): void {
    const p = this.panels[side];
    const target: 0 | 1 = deployed ? 1 : 0;
    if (p.deployTarget !== target) p.deployTarget = target;
  }

  // 展開度を指示値へ RADIATOR_DEPLOY_TIME 秒かけて近づける。wear は放熱板パーツの残 HP から
  // 求めた side ごとの損耗率。
  update(dt: number, wear: Record<RadiatorSide, number>): void {
    this.wear = wear;
    const step = dt / RADIATOR_DEPLOY_TIME;
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

  // 偶数折り目/奇数折り目それぞれの、ヒンジ基準での累積回転角 [rad]。展開方向は side ごとに
  // 符号が付くので、回転角自体は side に依らず ±psi で揃う。
  private foldThetas(side: RadiatorSide): { even: number; odd: number } {
    const sign = sideSign(side);
    const psi = this.tilt(this.panels[side].deploy);
    return { even: sign * psi, odd: -sign * psi };
  }

  // 蛇腹の折り目に与える展開角。even は偶数番、odd は奇数番の折り目のもの [rad]。
  viewTilt(side: RadiatorSide): { readonly even: number; readonly odd: number } {
    return this.foldThetas(side);
  }

  // side の有効な放熱面積 [m^2]。totalCoolingRate は放熱板部品の面積の総和で、展開度と
  // 損耗度で目減りする。
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
    const foldQ = qFromAxisAngle(LOCAL_UP, theta);
    const shipNormal = qRotate(foldQ, LOCAL_FORWARD);
    return qRotate(att.q, shipNormal);
  }

  // 日照面が太陽光を受ける実効面積 [m^2](日照面の吸収率を織り込む)。sunDir は太陽方向の
  // 単位ベクトル(world)。
  solarAbsorbArea(sunDir: Vec3, att: Attitude, totalCoolingRate: number): number {
    return (['up', 'down'] as const).reduce((sum, side) => {
      const halfArea = this.panelArea(side, totalCoolingRate) / 2;
      const { even, odd } = this.foldThetas(side);
      const cosEven = Math.abs(dot(this.worldNormal(even, att), sunDir));
      const cosOdd = Math.abs(dot(this.worldNormal(odd, att), sunDir));
      return sum + RADIATOR_SOLAR_ABSORB * halfArea * (cosEven + cosOdd);
    }, 0);
  }

  // RADIATOR_CONTACT_DEPLOY 以上展開し、全損していない side の折りごとに接触代理を返す。
  // t は接触代理の KinematicState.t に使う現在時刻(swept 判定の区間を成す)。
  contactFolds(shipR: Vec3, shipV: Vec3, att: Attitude, t: number): RadiatorFold[] {
    const result: RadiatorFold[] = [];
    for (const side of ['up', 'down'] as const) {
      if (this.panels[side].deploy < RADIATOR_CONTACT_DEPLOY || this.wear[side] >= 1) continue;
      const proxies = this.foldProxies[side];
      const { even, odd } = this.foldThetas(side);
      // 折りの速度には、艦の角速度による接線速度も乗せる。
      for (let i = 0; i < RADIATOR_FOLD_COUNT; i++) {
        const bodyOffset = foldLocalPosition(side, i, even, odd);
        const worldPos = add(shipR, qRotate(att.q, bodyOffset));
        const worldVel = add(shipV, qRotate(att.q, cross(att.w, bodyOffset)));
        const world = kinematicState<'eci'>(t, worldPos, worldVel);
        const known = proxies[i];
        const fold = known ?? new RadiatorFold(side, this.owner, world, this.onContact);
        if (known === undefined) proxies.push(fold);
        else fold.state = world;
        result.push(fold);
      }
    }
    return result;
  }

  // side の蛇腹の一番先の折りの位置(world、shipR と同じ絶対座標系)。
  tipWorldPosition(side: RadiatorSide, shipR: Vec3, att: Attitude): Vec3 {
    const { even, odd } = this.foldThetas(side);
    return add(shipR, qRotate(att.q, foldLocalPosition(side, RADIATOR_FOLD_COUNT - 1, even, odd)));
  }

  deployOf(side: RadiatorSide): number { return this.panels[side].deploy; }
  wearOf(side: RadiatorSide): number { return this.wear[side]; }

  // 保存するのは side ごとの展開目標と展開度。
  serialize(): RadiatorSaveData {
    return {
      up: { deployTarget: this.panels.up.deployTarget, deploy: this.panels.up.deploy },
      down: { deployTarget: this.panels.down.deployTarget, deploy: this.panels.down.deploy },
    };
  }
}
