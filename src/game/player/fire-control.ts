// プレイヤーの艦の機関砲を撃つ。トリガーと各砲の連射の時計を進め、フレームの間に来た発射を
// それぞれの時刻どおりに起こし、射撃で生じる実体と出来事を作る。弾薬は各武装モジュールが持つ。
import type * as THREE from 'three/webgpu';
import type { CelestialBodies } from '../celestial/celestial-bodies';
import { LOCAL_FORWARD, qMul, qRotate, randomQuat } from '../../math/quat';
import { kinematicState } from '../../physics/kinematic-state';
import { randSym } from '../../math/random';
import type { Vec3 } from '../../math/vec3';
import { add, addScaled, norm, randPerp, randVec, scale, sub, v3 } from '../../math/vec3';

import type { PilotControls } from '../dynamic/entity/pilot-controls';
import { Bullet } from '../dynamic/entity/bullet';
import type { EntityRegistry } from '../dynamic/entity-registry';
import type { StageOutcome } from '../stages/stage-outcome';
import type { ModularShip } from '../ship/modular-ship';
import type { WeaponPorts } from '../ship/ship-capabilities';
import type { WeaponInstance } from '../ship/ship-module-instance';
import { DebrisPiece } from '../dynamic/entity/debris-piece';
import { CASING_COLLISION_BOUND_RADIUS } from '../dynamic/entity/casing-collision';
import { sunGlareSpreadScale } from '../sun-glare-spread';
import { GunCycle, type GunShotRecord, type SerializedGunCycle } from './gun-cycle';
import {
  ammoTotals, consumeRound, hasAmmo, loadAmmo, supplyMagazines, swapMagazine,
  type AmmoLoad, type AmmoTotals, type GunAmmo,
} from './gun-magazine';

const EJECTED_MAG_PHYS_RADIUS = 1.4;
// 空マガジン外枠がリンク排出口へ出るスライド。内側へ潜った位置から面の外まで [m]・[s]。
const MAG_FRAME_SLIDE_DEPTH = 0.55;
const MAG_FRAME_SLIDE_TIME = 0.3;

const GUN_HEAT_PER_ROUND = 5.5e5; // 1発あたりに外殻へ入る熱量 [J]

const SPINUP_TIME = 0.15; // トリガーを引いてから各砲が撃ち始めるまでの起動遅延 [sim s]
const BULLET_SPREAD = 0.002; // 散布界 [rad]
const BULLET_MUZZLE_OFFSET = 1.5; // 弾が現れる、砲口から前方への距離 [m]

const BULLET_LIFETIME = 240; // 保険としての寿命 [sim s]

const RELOAD_TIME = 1.0; // 手動リロード(マガジン交換)のあいだ撃たない時間 [sim s]

// トリガーと各砲の時計の直列化した形。
export interface SerializedFireControl {
  readonly triggerHeld?: boolean;
  readonly dryReported?: boolean;
  readonly guns?: readonly SerializedGunCycle[];
}

// 撃てる砲1門の、このフレームの諸元。弾薬は撃つたびに艦の構成から読み直す。
interface ArmedGun {
  readonly id: string;
  readonly ports: WeaponPorts;
  readonly cycle: GunCycle;
  readonly interval: number; // 連射間隔 [sim s]
  readonly muzzleVelocity: number; // [m/s]
  readonly damage: number; // [HP]
}

export class FireControl {
  // player が撃つ。発砲で出る実体と出来事は registry へ積む。cycles は武装モジュール id ごとの連射の
  // 時計(撤去・全損した砲の時計は捨てる)、triggerHeld はトリガーを引いて撃ち始めているか、
  // dryReported は撃てないまま引いたことを次に撃ち始めるまでに知らせ済みか。
  private constructor(
    private readonly player: ModularShip,
    private readonly registry: EntityRegistry,
    private readonly scene: THREE.Scene,
    private readonly cycles: Map<string, GunCycle>,
    private triggerHeld: boolean,
    private dryReported: boolean,
  ) {}

  // 撃っていない状態で始める。
  public static create(player: ModularShip, registry: EntityRegistry, scene: THREE.Scene): FireControl {
    return new FireControl(player, registry, scene, new Map(), false, false);
  }

  // トリガーと各砲の時計の記録から復元する。壊れた項目は撃っていない状態の値で補う。
  public static deserialize(
    serialized: SerializedFireControl, player: ModularShip, registry: EntityRegistry, scene: THREE.Scene,
  ): FireControl {
    const cycles = new Map<string, GunCycle>();
    for (const gun of Array.isArray(serialized.guns) ? serialized.guns : []) {
      if (typeof gun.moduleId === 'string') cycles.set(gun.moduleId, GunCycle.deserialize(gun));
    }
    return new FireControl(
      player, registry, scene, cycles, serialized.triggerHeld === true, serialized.dryReported === true,
    );
  }

  // 健全な砲の写しを、艦の部品の並び順で。弾薬はそれぞれのモジュールが持つ。
  public get guns(): readonly WeaponInstance[] { return this.player.capabilities.modules('weapon', true); }
  // 健全な砲を合わせた弾薬。
  public get ammo(): AmmoTotals { return ammoTotals(this.guns); }
  public get isFiring(): boolean { return this.triggerHeld; }

  // 給弾ベルトがつながる砲(並び順で先頭の健全な砲)。砲が無ければ null。
  public get beltGun(): WeaponInstance | null { return this.guns[0] ?? null; }

  // リロード中の砲のうち、終わるまでの最も長い残り [s]。
  public get reloadRemaining(): number {
    const now = this.player.motion.state.t;
    let remaining = 0;
    for (const gun of this.guns) {
      remaining = Math.max(remaining, this.cycles.get(gun.id)?.reloadRemaining(now) ?? 0);
    }
    return remaining;
  }

  // 健全な砲の、砲口ごとの直近の発射。
  public get recentShotRecords(): readonly GunShotRecord[] {
    return this.guns.flatMap((gun) => [...this.cycles.get(gun.id)?.recentShots ?? []]);
  }

  // トリガーと各砲の時計を直列化する。弾薬はモジュールの記録に載る。
  public serialize(): SerializedFireControl {
    return {
      triggerHeld: this.triggerHeld,
      dryReported: this.dryReported,
      guns: [...this.cycles.values()].map((cycle) => cycle.serialize()),
    };
  }

  // 補給の mags 本を健全な砲へ配る。
  public onPickup(mags: number): void {
    const guns = this.guns;
    supplyMagazines(guns, mags);
    for (const gun of guns) this.player.capabilities.assembly.setAmmo(gun.id, gun);
  }

  // 健全な各砲の弾薬を load で置き換える。
  public loadAll(load: AmmoLoad): void {
    for (const gun of this.guns) this.changeAmmo(gun.id, (ammo) => loadAmmo(ammo, load));
  }

  // トリガーを離した状態にし、各砲の連射をやめる。次に引いたときは起動遅延から始まる。
  public stopFiring(): void {
    this.triggerHeld = false;
    for (const cycle of this.cycles.values()) cycle.stop();
  }

  // 発射の操作量を simDt [sim s] ぶん処理する。トリガーが引かれ、撃てる砲があれば、区間
  // [now, now + simDt) に来る全砲の発射を時刻の順に起こす。
  public updateFireState(
    simDt: number,
    controls: PilotControls,
    activeStage: StageOutcome,
    celestialBodies: CelestialBodies,
  ): void {
    const guns = this.armedGuns();
    if (!controls.firing) {
      this.stopFiring();
      return;
    }
    // 撃てる砲が無ければ連射をやめ、撃てなかったことを次に撃ち始めるまでに1度だけ知らせる。
    if (guns.length === 0 || !guns.some((gun) => hasAmmo(this.ammoOf(gun.id)))) {
      this.stopFiring();
      if (!this.dryReported) {
        this.registry.events.record({ kind: 'gunDryFired' });
        this.registry.events.record({ kind: guns.length === 0 ? 'gunDisabled' : 'gunOutOfAmmo' });
        this.dryReported = true;
      }
      return;
    }
    const now = this.player.motion.state.t;
    if (!this.triggerHeld) {
      this.triggerHeld = true;
      this.dryReported = false;
      this.registry.events.record({ kind: 'gunSpunUp' });
    }
    this.spinUpIdleGuns(guns, now);
    this.fireDue(guns, now, now + simDt, activeStage, celestialBodies);
  }

  // 手動リロードを試みる。健全な砲のうち、リロード中でなく予備があり装填中のマガジンに補充の余地が
  // ある砲がそれぞれマガジンを替え、捨てたマガジンの外枠をその砲のリンク排出口から出す。1門でも
  // 替えたら true。
  public manualReload(): boolean {
    const now = this.player.motion.state.t;
    // 砲ごとに替え、替えた砲だけがリロードの時間に入る。
    let reloaded = false;
    for (const gun of this.armedGuns()) {
      if (gun.cycle.reloading(now) || !this.changeAmmo(gun.id, swapMagazine)) continue;
      gun.cycle.beginReload(now, RELOAD_TIME);
      this.spawnEjectedMagazineFrame(gun.ports);
      reloaded = true;
    }
    if (reloaded) this.registry.events.record({ kind: 'gunReloaded' });
    return reloaded;
  }

  // ---------------------------------------------------------------- 連射の時計

  // 健全な砲のこのフレームの諸元。時計の無い砲には新しく持たせ、いなくなった砲の時計は捨てる。
  private armedGuns(): ArmedGun[] {
    const assembly = this.player.capabilities.assembly;
    const instances = this.guns;
    const ports = this.player.capabilities.weaponPorts();
    const guns: ArmedGun[] = [];
    // 連射の諸元はモジュール定義から、砲口と排出口は艦の構成から引く。
    for (const instance of instances) {
      const abilities = assembly.definition(instance.id)?.abilities;
      const port = ports.find((p) => p.moduleId === instance.id);
      const fireRate = abilities?.fireRate ?? 0;
      if (port === undefined || port.muzzles.length === 0 || !(fireRate > 0)) continue;
      let cycle = this.cycles.get(instance.id);
      if (cycle === undefined) {
        cycle = new GunCycle(instance.id);
        this.cycles.set(instance.id, cycle);
      }
      guns.push({
        id: instance.id, ports: port, cycle, interval: 1 / fireRate,
        muzzleVelocity: abilities?.muzzleVelocity ?? 0, damage: abilities?.weaponDamage ?? 0,
      });
    }
    for (const id of this.cycles.keys()) {
      if (!instances.some((instance) => instance.id === id)) this.cycles.delete(id);
    }
    return guns;
  }

  // 連射していない砲を、時刻 now から起動遅延を経て撃ち始めさせる。k 番目の砲は連射間隔を砲の数で
  // 等分した k 個ぶん遅らせ、艦全体の発射を等間隔に並べる。
  private spinUpIdleGuns(guns: readonly ArmedGun[], now: number): void {
    guns.forEach((gun, k) => {
      if (gun.cycle.nextShotAt === null) gun.cycle.start(now + SPINUP_TIME + (k * gun.interval) / guns.length);
    });
  }

  // 区間 [now, end) に来る全砲の発射を、時刻の早い順に起こす。弾の無い砲・リロード中の砲は、その発射を
  // 撃たずに拍だけ進める。
  private fireDue(
    guns: readonly ArmedGun[], now: number, end: number,
    activeStage: StageOutcome, celestialBodies: CelestialBodies,
  ): void {
    for (;;) {
      // 区間の中で次に撃つ砲を探す。無ければ区間の発射は出尽くした。
      let next: ArmedGun | null = null;
      let at = end;
      for (const gun of guns) {
        const shotAt = gun.cycle.nextShotAt;
        if (shotAt !== null && shotAt < at) {
          next = gun;
          at = shotAt;
        }
      }
      if (next === null) return;
      if (!next.cycle.reloading(at) && hasAmmo(this.ammoOf(next.id))) {
        this.fireGun(next, now, at, activeStage, celestialBodies);
      }
      next.cycle.advance(next.interval);
    }
  }

  // 砲 id の弾薬の写し。
  private ammoOf(id: string): GunAmmo {
    const gun = this.player.capabilities.assembly.module(id);
    return gun?.kind === 'weapon' ? { rounds: gun.rounds, mags: gun.mags } : { rounds: 0, mags: 0 };
  }

  // 砲 id の弾薬を change で変え、艦の構成へ書き戻す。change の戻り値を返す。
  private changeAmmo<T>(id: string, change: (ammo: GunAmmo) => T): T {
    const ammo = this.ammoOf(id);
    const result = change(ammo);
    this.player.capabilities.assembly.setAmmo(id, ammo);
    return result;
  }

  // ---------------------------------------------------------------- 発射

  // 砲 gun の1発を時刻 at [sim s] に撃ち、弾・薬莢・反動・熱・出来事・射撃記録を残す。艦の状態は区間の
  // 始まり now のものしか無いので、at の砲口は艦の速度で直線に進めた位置とする(1フレーム以内の
  // 加速と回転の寄与は、砲口の位置で数 mm に収まる)。
  private fireGun(
    gun: ArmedGun, now: number, at: number, activeStage: StageOutcome, celestialBodies: CelestialBodies,
  ): void {
    const ship = this.player.motion;
    const muzzleIndex = gun.cycle.takeMuzzle(gun.ports.muzzles.length);
    const consumption = this.changeAmmo(gun.id, consumeRound);
    // 弾はモジュールの前方へ出す。
    const fwd = this.worldDir(gun.ports.rotation, LOCAL_FORWARD);
    const muzzleNow = ship.assemblyToEci(gun.ports.muzzles[muzzleIndex]!);
    const muzzleAt = addScaled(muzzleNow, ship.state.v, at - now);

    const bullet = this.spawnBullet(gun, muzzleNow, muzzleAt, fwd, now, at, celestialBodies);
    // 発射した弾の運動量と逆向きの力積を、同じ散布方向で砲口へ加える。
    ship.applyImpulseAtPoint(scale(sub(ship.state.v, bullet.motion.state.v), bullet.motion.mass), muzzleNow);
    this.dropCasing(gun.ports);
    activeStage.recordShot();
    ship.absorbHeat(GUN_HEAT_PER_ROUND / Math.max(ship.mass, 1e-9));
    this.registry.events.record({
      kind: 'gunFired', muzzleState: kinematicState<'eci'>(at, muzzleAt, ship.state.v),
    });
    gun.cycle.recordShot({
      moduleId: gun.id, muzzleIndex, firedAt: at,
      cycleDuration: gun.interval * gun.ports.muzzles.length,
    });
    // マガジンを撃ち尽くして次を装填したら、空の外枠を排出する。
    if (consumption === 'mag-reload') {
      this.spawnEjectedMagazineFrame(gun.ports);
      this.registry.events.record({ kind: 'gunMagazineFed' });
    }
  }

  // モジュール姿勢 moduleRot の局所方向 dir を ECI 方向へ写す。
  private worldDir(moduleRot: WeaponPorts['rotation'], dir: Vec3): Vec3 {
    return qRotate(this.player.motion.att.q, qRotate(moduleRot, dir));
  }

  // 時刻 at に砲口 muzzleAt から撃つ弾: 機首方向 + 散布界。運動状態は、撃たれる前の弾を区間の始まり
  // now まで直線に巻き戻した状態で置く(その間は砲身の中にあり、自艦との接触猶予の内にある)。
  private spawnBullet(
    gun: ArmedGun, muzzleNow: Vec3, muzzleAt: Vec3, fwd: Vec3, now: number, at: number,
    celestialBodies: CelestialBodies,
  ): Bullet {
    const ship = this.player.motion;
    // 散布界は撃った時刻の砲口で、逆光の倍率を掛けて決める。
    const spreadScale = sunGlareSpreadScale(muzzleAt, fwd, celestialBodies, at);
    const spread = Math.abs(randSym(BULLET_SPREAD)) * spreadScale;
    const dir = norm(addScaled(fwd, randPerp(fwd), spread));
    const bullet = Bullet.create(
      kinematicState<'eci'>(
        now,
        addScaled(addScaled(muzzleNow, fwd, BULLET_MUZZLE_OFFSET), dir, -gun.muzzleVelocity * (at - now)),
        addScaled(ship.state.v, dir, gun.muzzleVelocity),
      ),
      BULLET_LIFETIME,
      'player',
      'normal',
      gun.damage,
      this.registry.idAllocators,
      at,
    );
    this.registry.add(bullet);
    return bullet;
  }

  // 薬莢を排莢口(-X)から排出し、位置・向き・速度を個体ごとに散らす。
  private dropCasing(weapon: WeaponPorts): void {
    const ship = this.player;
    // モジュール姿勢基準の排莢方向と上方向
    const eject = this.worldDir(weapon.rotation, v3(-1, 0, 0));
    const up = this.worldDir(weapon.rotation, v3(0, 1, 0));
    this.registry.add(DebrisPiece.create(
      kinematicState<'eci'>(
        ship.motion.state.t,
        this.player.motion.assemblyToEci(weapon.ejectionPort),
        add(
          ship.motion.state.v,
          add(scale(eject, 0.5 + Math.random() * 0.3), add(scale(up, randSym(0.2)), randVec(0.1))),
        ),
      ),
      { kind: 'casing', bornSim: ship.motion.state.t },
      {
        q: randomQuat(),
        w: v3(randSym(6.0), randSym(6.0), randSym(6.0)),
        inertia: v3(0.85, 0.3, 1.15), // 円筒: 長軸(y)が最小。x/z も非対称にしジャニベコフ効果を起こす
      },
      this.registry.idAllocators, CASING_COLLISION_BOUND_RADIUS, this.scene,
    ));
  }

  // 空マガジン外枠をリンク排出口(-X)から排出し、排出口までの経路を経て自由飛行へ移す。
  private spawnEjectedMagazineFrame(weapon: WeaponPorts): void {
    const ship = this.player;
    // 経路の終端にばらつきを持たせ、外枠ごとの排出方向を変える。
    const inward = qRotate(weapon.rotation, v3(1, 0, 0));
    const inner = add(weapon.linkExitPort, scale(inward, MAG_FRAME_SLIDE_DEPTH));
    const outer = add(
      add(weapon.linkExitPort, scale(inward, -MAG_FRAME_SLIDE_DEPTH)),
      qRotate(weapon.rotation, randVec(0.12)),
    );
    const slideSpeed = (MAG_FRAME_SLIDE_DEPTH * 2) / MAG_FRAME_SLIDE_TIME;
    const eject = this.worldDir(weapon.rotation, v3(-1, 0, 0));
    const t = ship.motion.state.t;
    this.registry.add(DebrisPiece.create(
      kinematicState<'eci'>(
        t,
        this.player.motion.assemblyToEci(inner),
        add(ship.motion.state.v, scale(eject, slideSpeed)),
      ),
      {
        kind: 'magazineFrame',
        slide: {
          bornSim: t,
          duration: MAG_FRAME_SLIDE_TIME,
          r0: ship.motion.state.r,
          q0: ship.motion.att.q,
          v0: ship.motion.state.v,
          from: sub(inner, ship.motion.centerOffset),
          to: sub(outer, ship.motion.centerOffset),
        },
      },
      {
        q: qMul(ship.motion.att.q, weapon.rotation),
        w: v3(randSym(0.2), randSym(0.2), randSym(0.2)),
        inertia: v3(1, 1.2, 1.4),
      },
      this.registry.idAllocators, EJECTED_MAG_PHYS_RADIUS, this.scene,
    ));
  }
}
