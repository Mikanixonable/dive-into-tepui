// プレイヤーの射撃・弾薬(マガジン/リロード)状態と、それに連動するマガジンベルト
// (未使用弾のベルト、Verlet 物理 + 表示メッシュは belt.ts の BeltPhysics)。
// 発砲・排莢・バレル交換の演出もここで組み立てる(combat.ts は game.ts を import
// しないため、combat.ts へ発注する形は取らず、effects-system.ts のスポーン関数を
// 直接呼び、命中数とは独立な「発射数」だけ CombatSystem.recordShot() で集計する)。
import * as THREE from 'three/webgpu';
import { Attitude, qRotate, randomQuat } from '../../physics/attitude';
import { Vec3, add, addScaled, clone, norm, randPerp, randSym, randVec, scale, v3 } from '../../physics/vec3';
import * as C from '../const';
import { Input } from '../input';
import { Hud } from '../../hud/hud';
import { Sfx } from '../../audio/sfx';
import { BeltPhysics } from './belt-physics';
import { Bullet, Casing, DebrisPiece, Ship } from '../entities';
import {
  MAG_BELT_PITCH,
  MUZZLE_OFFSETS,
  buildBarrelMesh,
  buildBulletMesh,
  buildCasingMesh,
  buildMagazineFrame,
  buildMagazineMesh,
} from '../../render/ships';
import { EffectsCtx, spawnFlash } from '../effects-system';
import { CombatSystem } from '../combat/combat';

type AmmoEvent = 'none' | 'mag' | 'reload';

// fireGun / dropBarrel / spawnEjectedMagazineFrame が必要とする、Game 側の
// 現在状態のスナップショット。fx はエフェクトのスポーンに必要な最小の受け皿
// (effects-system.ts の EffectsCtx)。
export interface FireCtx {
  simTime: number;
  scene: THREE.Scene;
  zoomActive: boolean;
  fx: EffectsCtx;
  addBullet(bullet: Bullet): void;
  addCasing(casing: Casing): void;
  addDebris(piece: DebrisPiece): void;
}

export class PlayerFire {
  private fireCooldown = 0;
  private wasFiring = false;
  private wasEmptyClick = false;
  private roundsInMagValue = C.MAG_ROUNDS;
  private magsLeftValue = C.INITIAL_MAGS - 1;
  private magsConsumedSinceReloadValue = 0;
  private reloadTimerValue = 0;
  private muzzleIdx = 0; // 縦二連砲口の交互発射用

  // マガジンベルト(未使用の実弾入りマガジン): 機体左面(+X)に垂直に連結する。
  // 先頭リンクは機体に半分取り込まれた位置に置く(給弾中もベルトごと取り込まれて
  // いる見た目)。弾を撃ち尽くすたびに機体反対側(-X)からフレームだけの空マガジンが
  // デブリとして放出される(spawnEjectedMagazineFrame 参照)。
  private readonly beltGroup = new THREE.Group();
  private readonly beltLinks: THREE.Group[] = [];
  readonly belt: BeltPhysics;
  private beltFeed = 0;

  constructor(
    private readonly hud: Hud,
    private readonly sfx: Sfx,
    playerObj: THREE.Object3D,
  ) {
    for (let i = 0; i < C.BELT_MAX_VISIBLE; i++) {
      const link = buildMagazineMesh();
      link.position.x = 0.9 + i * MAG_BELT_PITCH;
      this.beltGroup.add(link);
      this.beltLinks.push(link);
    }
    playerObj.add(this.beltGroup);
    this.belt = new BeltPhysics(this.beltLinks);
  }

  get roundsInMag(): number { return this.roundsInMagValue; }
  get magsLeft(): number { return this.magsLeftValue; }
  get magsConsumedSinceReload(): number { return this.magsConsumedSinceReloadValue; }
  get reloadTimer(): number { return this.reloadTimerValue; }
  get isFiring(): boolean { return this.wasFiring; }

  initAmmo(magsLeft: number, roundsInMag: number): void {
    this.magsLeftValue = magsLeft;
    this.roundsInMagValue = roundsInMag;
    this.magsConsumedSinceReloadValue = 0;
    this.reloadTimerValue = 0;
    this.wasEmptyClick = false;
    this.fireCooldown = 0;
    this.wasFiring = false;
  }

  onPickup(mags: number): void {
    this.magsLeftValue += mags;
    if (this.roundsInMagValue > 0) return;
    this.magsLeftValue--;
    this.roundsInMagValue = C.MAG_ROUNDS;
  }

  stopFiring(): void {
    this.wasFiring = false;
  }

  manualReload(): boolean {
    const canReload =
      this.reloadTimerValue <= 0 &&
      (this.roundsInMagValue < C.MAG_ROUNDS || this.magsConsumedSinceReloadValue > 0) &&
      this.magsLeftValue > 0;
    if (!canReload) return false;
    this.magsLeftValue--;
    this.roundsInMagValue = C.MAG_ROUNDS;
    this.magsConsumedSinceReloadValue = 0;
    this.reloadTimerValue = C.RELOAD_TIME;
    this.sfx.playReload();
    return true;
  }

  private hasAmmo(): boolean {
    return this.roundsInMagValue > 0 || this.magsLeftValue > 0;
  }

  // 発砲入力を処理し、発射・排莢・リロードを行う。戻り値は「このフレームで発砲を
  // 新規開始したか」— fineAttitude の有効化は移動系(PlayerThrottle)の責務なので、
  // 呼び出し元(Player)へ判定だけ返す。canAct(ワープ倍率・生死・マップモードを合成
  // した「行動可能か」)は Player が一元的に判定して渡す — ここではワープ値そのものは
  // 扱わない。ship は発射位置・反動・排莢の基準になる自機の位置・姿勢(Player 自身)。
  updateFireState(
    dt: number,
    input: Input,
    alive: boolean,
    mapMode: boolean,
    canAct: boolean,
    ship: Ship,
    combat: CombatSystem,
    fireCtx: FireCtx,
  ): boolean {
    const keyHeld = !mapMode && (input.down('Space') || input.mouseFiring);
    // keyHeld は !mapMode を含意するため、alive にもかかわらず canAct が偽なのは
    // ワープ倍率超過が原因と判定できる。
    if (keyHeld && alive && !canAct) {
      this.hud.hint(`射撃・推進はワープ ×${C.MAX_PHYS_SIM_SPEED} 以下でのみ可能`);
    }
    const hasAmmo = this.hasAmmo();
    if (keyHeld && alive && !hasAmmo && !this.wasEmptyClick) {
      this.sfx.emptyClick();
      this.hud.hint('弾薬切れ — 軌道上の補給マガジン ▣ を回収せよ', 3000);
    }
    this.wasEmptyClick = keyHeld && !hasAmmo;

    // リロードは戦闘可否(マップモード/ワープ/生死)に関わらず実時間で進行する
    // (時間ワープ中でも装填サイクルは現実時間で完了する)。
    if (this.reloadTimerValue > 0) {
      this.reloadTimerValue -= dt;
      this.wasFiring = false;
      return false;
    }

    const wantFire = keyHeld && hasAmmo && canAct;
    const justStartedFiring = wantFire && !this.wasFiring;
    this.wasFiring = wantFire;
    if (!wantFire) return justStartedFiring;

    if (justStartedFiring) {
      this.sfx.spinUp();
      this.fireCooldown = C.SPINUP_TIME;
    }
    this.fireCooldown -= dt;
    if (this.fireCooldown > 0) return justStartedFiring;
    this.fireCooldown = C.FIRE_INTERVAL;

    this.fireGun(fireCtx, ship, combat);
    const ammoEvent = this.consumeRound();
    if (ammoEvent === 'mag') {
      this.spawnEjectedMagazineFrame(fireCtx, ship);
      this.sfx.magFeed();
    } else if (ammoEvent === 'reload') {
      this.spawnEjectedMagazineFrame(fireCtx, ship);
      this.dropBarrel(fireCtx, ship);
      this.sfx.playReload();
    }
    return justStartedFiring;
  }

  private consumeRound(): AmmoEvent {
    this.roundsInMagValue--;
    if (this.roundsInMagValue > 0 || this.magsLeftValue <= 0) return 'none';
    this.magsLeftValue--;
    this.roundsInMagValue = C.MAG_ROUNDS;
    this.magsConsumedSinceReloadValue++;
    if (this.magsConsumedSinceReloadValue < 3) return 'mag';
    this.magsConsumedSinceReloadValue = 0;
    this.reloadTimerValue = C.RELOAD_TIME;
    return 'reload';
  }

  // ---------------------------------------------------------------- weapons

  private fireGun(ctx: FireCtx, ship: Ship, combat: CombatSystem): void {
    const fwd = qRotate(ship.att.q, v3(0, 0, 1));
    const right = qRotate(ship.att.q, v3(1, 0, 0));
    const up = qRotate(ship.att.q, v3(0, 1, 0));

    // 縦二連の砲口から交互に発射する
    const mo = MUZZLE_OFFSETS[this.muzzleIdx]!;
    this.muzzleIdx = (this.muzzleIdx + 1) % MUZZLE_OFFSETS.length;
    const muzzle = add(ship.state.r, qRotate(ship.att.q, v3(mo.x, mo.y, mo.z)));

    // 弾丸: 機首方向 + 散布界
    const dir = norm(addScaled(fwd, randPerp(fwd), Math.abs(randSym(C.BULLET_SPREAD))));
    const bullet = new Bullet(
      {
        r: addScaled(clone(muzzle), fwd, 1.5),
        v: addScaled(clone(ship.state.v), dir, C.MUZZLE_SPEED),
      },
      buildBulletMesh(),
      ctx.simTime,
      ctx.scene,
    );
    ctx.addBullet(bullet);

    // 反動(運動量保存の風味): 発射方向と逆に微小 Δv
    ship.state.v = addScaled(ship.state.v, fwd, -C.RECOIL_DV);

    // 薬莢: 機体右側(-X)へ排出(左側(+X)はマガジンベルトの給弾があるため)。
    // 初速・回転とも抑え、ゆっくり漂いながら緩やかに回転する見た目にする。
    const casing = new Casing(
      {
        r: add(muzzle, scale(right, -1.4)),
        v: add(
          ship.state.v,
          add(scale(right, -(0.5 + Math.random() * 0.3)), add(scale(up, randSym(0.2)), randVec(0.1))),
        ),
      },
      buildCasingMesh(),
      {
        q: randomQuat(),
        w: v3(randSym(2.5), randSym(2.5), randSym(2.5)),
        inertia: v3(1, 0.3, 1), // 円筒: 長軸まわりが小さい
      },
      ctx.simTime,
      ctx.scene,
    );
    ctx.addCasing(casing);

    // マズルフラッシュ: 発射した側の砲口に出す
    // (ズーム中は画面のちらつきを抑えるため大幅減光、完全には消さない)
    spawnFlash(
      ctx.fx,
      addScaled(clone(muzzle), fwd, 1.2),
      clone(ship.state.v),
      2.2,
      6,
      0.07,
      0xfff0b8,
      ctx.zoomActive ? C.ZOOM_MUZZLE_FLASH_SCALE : 1,
      true, // マズルフラッシュ: PIP 描画時のみ非表示化の対象
    );

    combat.recordShot();
    this.sfx.fire();
  }

  // リロード時(バレル交換)に円柱アイテムをデブリとして放出する。手動リロード
  // ([R]キー、player.ts の handleEdgePress)からも直接呼ばれるため public。
  dropBarrel(ctx: FireCtx, ship: Ship): void {
    // 下方に少し勢いをつけて放出
    const down = qRotate(ship.att.q, v3(0, -1, 0));
    const piece = new DebrisPiece(
      {
        r: add(ship.state.r, qRotate(ship.att.q, v3(0, -1, 1.5))), // 機首下部あたりから
        v: add(ship.state.v, add(scale(down, 3.0), randVec(0.5))),
      },
      buildBarrelMesh(),
      {
        q: { x: ship.att.q.x, y: ship.att.q.y, z: ship.att.q.z, w: ship.att.q.w },
        w: v3(randSym(2), randSym(2), randSym(2)),
        inertia: v3(1, 0.2, 1), // 円柱
      },
      0.8,
      ctx.scene,
    );
    ctx.addDebris(piece);
  }

  // マガジン1個を撃ち尽くした瞬間、機体右側(-X、薬莢と同じ側)の位置から
  // 空になったマガジンの外枠(弾なし)をデブリとして放出する。
  private spawnEjectedMagazineFrame(ctx: FireCtx, ship: Ship): void {
    const right = qRotate(ship.att.q, v3(1, 0, 0));
    const portWorld = add(ship.state.r, qRotate(ship.att.q, v3(-0.9, 0, 0)));
    const piece = new DebrisPiece(
      {
        r: portWorld,
        v: add(ship.state.v, add(scale(right, -(0.5 + Math.random() * 0.3)), randVec(0.15))),
      },
      buildMagazineFrame(),
      {
        q: { x: ship.att.q.x, y: ship.att.q.y, z: ship.att.q.z, w: ship.att.q.w },
        w: v3(randSym(0.2), randSym(0.2), randSym(0.2)),
        inertia: v3(1, 1.2, 1.4),
      },
      C.EJECTED_MAG_PHYS_RADIUS,
      ctx.scene,
    );
    ctx.addDebris(piece);
  }

  // ---------------------------------------------------------------- belt

  // マガジンベルトの毎フレーム更新(たわみ物理 + 表示メッシュ)。給弾量
  // (beltCount/beltFeed)は自身が持つ弾薬状態から直接導出する。
  updateBelt(dt: number, att: Attitude, thrustAccelVec: Vec3, alive: boolean): void {
    const beltCount = Math.min(this.magsLeftValue, C.BELT_MAX_VISIBLE);
    const targetFeed = 1 - this.roundsInMagValue / C.MAG_ROUNDS;
    if (targetFeed < this.beltFeed - 0.5) {
      this.belt.shiftBeltNodes();
      this.beltFeed = targetFeed;
    } else {
      this.beltFeed += (targetFeed - this.beltFeed) * Math.min(1, dt * 12);
    }
    this.belt.updateBeltPhysics(dt, beltCount, att, thrustAccelVec, this.beltFeed, alive);
  }
}
