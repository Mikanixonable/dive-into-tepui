// 自機の展開式ラジエーター: 上下2枚それぞれの展開度・損耗度を持ち、
// 今フレームの放熱面積と太陽入射を答える。
import type { Attitude } from '../../physics/attitude';
import { LOCAL_FORWARD, LOCAL_UP, qFromAxisAngle, qRotate } from '../../math/quat';
import { kinematicState } from '../../physics/kinematic-state';
import { add, cross, dot, rotateAxis, v3, type Vec3 } from '../../math/vec3';
import {
  RADIATOR_DEPLOY_TILT,
  RADIATOR_FOLD_COUNT,
  RADIATOR_HINGE,
  RADIATOR_SEGMENT_LENGTH,
} from '../../physics/player-shape';
import type { Contact } from '../dynamic/dynamic-entity/contact';
import { ContactProxy } from '../dynamic/contact-proxy';
import type {
  DynamicReactionServices, EntityContactParticipant,
} from '../dynamic/dynamic-simulation-participant';
import { DeployablePanelState, type SerializedDeployablePanelState } from './deployable-panel-state';

export const RADIATOR_DEPLOY_TIME = 3.0; // 収納⇔全開にかかる時間 [s]
const RADIATOR_SOLAR_ABSORB = 0.15; // 日照面の太陽光吸収率

const RADIATOR_CONTACT_DEPLOY = 0.15; // これ以上展開していると被弾対象になる展開度
const RADIATOR_FOLD_MASS = 5; // 接触で押し合うときの、蛇腹1折りの質量 [kg]

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
// 各折りの根本から半セグメント先を返す。
function foldLocalPosition(side: RadiatorSide, fold: number, even: number, odd: number): Vec3 {
  const sign = sideSign(side);
  let origin = v3(sign * RADIATOR_HINGE.x, RADIATOR_HINGE.y, RADIATOR_HINGE.z);
  for (let i = 0; i < fold; i++) {
    origin = add(origin, yRotatedOffset(i % 2 === 0 ? even : odd, sign * RADIATOR_SEGMENT_LENGTH));
  }
  return add(origin, yRotatedOffset(fold % 2 === 0 ? even : odd, sign * RADIATOR_SEGMENT_LENGTH / 2));
}

// 折りへの接触を艦側のゲーム上の反応へ渡す口。side は当たった放熱板。
type RadiatorContactReaction = (
  side: RadiatorSide,
  other: EntityContactParticipant,
  contact: Contact,
  services: DynamicReactionServices,
) => void;

export interface SerializedRadiatorSystem {
  readonly up: SerializedDeployablePanelState;
  readonly down: SerializedDeployablePanelState;
}

export class RadiatorSystem {
  private readonly panels: Record<RadiatorSide, DeployablePanelState>;
  // side ごとの損耗率(0=無傷, 1=全損)。放熱板部品の残 HP から求め直すキャッシュ。
  private wear: Record<RadiatorSide, number> = { up: 0, down: 0 };
  // side ごとの蛇腹1折りぶんの接触代理。折り数まで遅延生成し、以後は使い回す。
  private readonly foldProxies: Record<RadiatorSide, ContactProxy[]> = { up: [], down: [] };
  // 直近の placeContactFolds で接触に加えた折りの代理(キャッシュ)。
  private activeFolds: readonly ContactProxy[] = [];

  // 艦本体へ接触代理を結び、接触後のゲーム上の反応を受け取る。up・down は各側の展開状態で、
  // 省いた側は収納から始める。
  public constructor(
    private readonly owner: EntityContactParticipant,
    private readonly onContact: RadiatorContactReaction,
    up = new DeployablePanelState(0, 0),
    down = new DeployablePanelState(0, 0),
  ) {
    this.panels = { up, down };
  }

  // side の展開/収納を切り替える。
  public toggle(side: RadiatorSide): void {
    const p = this.panels[side];
    p.toggle();
  }

  // side の展開目標を明示的に設定する。
  public setDeployed(side: RadiatorSide, deployed: boolean): void {
    const p = this.panels[side];
    p.setTarget(deployed);
  }

  // 展開度を指示値へ RADIATOR_DEPLOY_TIME 秒かけて近づける。wear は放熱板パーツの残 HP から
  // 求めた side ごとの損耗率。
  public update(dt: number, wear: Record<RadiatorSide, number>): void {
    this.wear = wear;
    for (const side of ['up', 'down'] as const) {
      this.panels[side].update(dt, RADIATOR_DEPLOY_TIME);
    }
  }

  // 展開度 deploy(0..1)での折り角(展開軸からの傾き)[rad]。
  private tilt(deploy: number): number {
    return STOW_TILT + (RADIATOR_DEPLOY_TILT - STOW_TILT) * deploy;
  }

  // side の偶数・奇数の折り目それぞれの、ヒンジ基準での回転角 [rad]。
  public foldThetas(side: RadiatorSide): { even: number; odd: number } {
    const sign = sideSign(side);
    const psi = this.tilt(this.panels[side].value);
    return { even: sign * psi, odd: -sign * psi };
  }

  // side の有効な放熱面積 [m^2]。totalCoolingRate は放熱板部品の面積の総和。全損した側は 0。
  private panelArea(side: RadiatorSide, totalCoolingRate: number): number {
    if (this.wear[side] >= 1) return 0;
    return (totalCoolingRate / 2) * this.panels[side].value;
  }

  // 放熱に使える面積 [m^2]。
  public radiatingArea(totalCoolingRate: number): number {
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
  public solarAbsorbArea(sunDir: Vec3, att: Attitude, totalCoolingRate: number): number {
    return (['up', 'down'] as const).reduce((sum, side) => {
      const halfArea = this.panelArea(side, totalCoolingRate) / 2;
      const { even, odd } = this.foldThetas(side);
      const cosEven = Math.abs(dot(this.worldNormal(even, att), sunDir));
      const cosOdd = Math.abs(dot(this.worldNormal(odd, att), sunDir));
      return sum + RADIATOR_SOLAR_ABSORB * halfArea * (cosEven + cosOdd);
    }, 0);
  }

  // 直近の placeContactFolds で置いた折りの接触代理。
  public get contactFolds(): readonly ContactProxy[] { return this.activeFolds; }

  // RADIATOR_CONTACT_DEPLOY 以上展開し、全損していない side の折りごとに接触代理を置き直す。
  // shipR・shipV は艦の ECI 位置・速度、t は現在時刻。
  public placeContactFolds(shipR: Vec3, shipV: Vec3, att: Attitude, t: number): void {
    const result: ContactProxy[] = [];
    for (const side of ['up', 'down'] as const) {
      if (this.panels[side].value < RADIATOR_CONTACT_DEPLOY || this.wear[side] >= 1) continue;
      const proxies = this.foldProxies[side];
      const { even, odd } = this.foldThetas(side);
      // 折りの速度には、艦の角速度による接線速度も乗せる。
      for (let i = 0; i < RADIATOR_FOLD_COUNT; i++) {
        const bodyOffset = foldLocalPosition(side, i, even, odd);
        const worldPos = add(shipR, qRotate(att.q, bodyOffset));
        const worldVel = add(shipV, qRotate(att.q, cross(att.w, bodyOffset)));
        const world = kinematicState<'eci'>(t, worldPos, worldVel);
        const known = proxies[i];
        const fold = known ?? new ContactProxy(
          this.owner, 'radiator-fold', RADIATOR_FOLD_MASS, RADIATOR_SEGMENT_LENGTH / 2, world,
          (other, contact, services) => this.onContact(side, other, contact, services),
        );
        if (known === undefined) proxies.push(fold);
        else fold.reset(world);
        result.push(fold);
      }
    }
    this.activeFolds = result;
  }

  // side の蛇腹の一番先の折りの位置(world、shipR と同じ絶対座標系)。
  public tipWorldPosition(side: RadiatorSide, shipR: Vec3, att: Attitude): Vec3 {
    const { even, odd } = this.foldThetas(side);
    return add(shipR, qRotate(att.q, foldLocalPosition(side, RADIATOR_FOLD_COUNT - 1, even, odd)));
  }

  public deployOf(side: RadiatorSide): number { return this.panels[side].value; }
  public wearOf(side: RadiatorSide): number { return this.wear[side]; }

  // side ごとの展開目標と展開度の直列化。
  public serialize(): SerializedRadiatorSystem {
    return { up: this.panels.up.serialize(), down: this.panels.down.serialize() };
  }
}
