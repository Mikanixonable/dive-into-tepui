// プレイヤーの射撃・弾薬(マガジン/リロード)状態。発砲・排莢・バレル交換の
// 演出もここで組み立てる(effects-system.ts のスポーン関数を直接呼び、命中数とは
// 独立な「発射数」だけ ScoreCounter.recordShot() で集計する)。未使用弾のベルト
// (表示メッシュ + たわみ物理)は belt.ts の Belt が持つ — Player が直接所有する
// (PlayerFire はベルトの状態を参照しない)。
import * as THREE from 'three/webgpu';
import { qRotate, randomQuat } from '../../physics/attitude';
import { add, addScaled, clone, norm, randPerp, randSym, randVec, scale, v3, Vec3 } from '../../physics/vec3';
import * as C from '../const';
import { Input } from '../input';
import { Hud } from '../../hud/hud';
import { Sfx } from '../../audio/sfx';
import { Casing, DebrisPiece, Ship } from '../orbit-entity/entities';
import { Bullet } from '../orbit-entity/bullet';
import { MUZZLE_OFFSETS } from '../../render/ships';
import { EffectsCtx, spawnFlash } from '../effects-system';
import { ScoreCounter } from '../stages/stage-utils/score-counter';

// fireGun / dropBarrel / spawnEjectedMagazineFrame が必要とする、Game 側の
// 現在状態のスナップショット。fx はエフェクトのスポーンに必要な最小の受け皿
// (effects-system.ts の EffectsCtx)。
export interface FireCtx {
  simTime: number;
  zoomActive: boolean;
  fx: EffectsCtx;
  addBullet(bullet: Bullet): void;
  addCasing(casing: Casing): void;
  addDebris(piece: DebrisPiece): void;
}

export class PlayerFire {
  fireCooldown = 0;
  wasFiring = false;
  wasEmptyClick = false;
  roundsInMag = C.MAG_ROUNDS;
  magsLeft = C.INITIAL_MAGS - 1;
  magsLeftInBarrel = C.MAGS_PER_BARREL;
  reloadTimer = 0;
  muzzleIdx = 0; // 縦二連砲口の交互発射用

  constructor(
    private readonly _hud: Hud,
    private readonly _sfx: Sfx,
    private readonly _scene: THREE.Scene,
  ) { }

  get isFiring(): boolean { return this.wasFiring; }

  initAmmo(magsLeft: number, roundsInMag: number): void {
    this.magsLeft = magsLeft;
    this.roundsInMag = roundsInMag;
    this.magsLeftInBarrel = C.MAGS_PER_BARREL;
    this.reloadTimer = 0;
    this.wasEmptyClick = false;
    this.fireCooldown = 0;
    this.wasFiring = false;
  }

  onPickup(mags: number): void {
    this.magsLeft += mags;
    if (this.roundsInMag > 0) return;
    this.magsLeft--;
    this.roundsInMag = C.MAG_ROUNDS;
  }

  stopFiring(): void {
    this.wasFiring = false;
  }

  manualReload(): boolean {
    const canReload =
      this.reloadTimer <= 0 &&
      (this.roundsInMag < C.MAG_ROUNDS || this.magsLeftInBarrel < C.MAGS_PER_BARREL) &&
      this.magsLeft > 0;
    if (!canReload) return false;
    this.magsLeft--;
    this.roundsInMag = C.MAG_ROUNDS;
    this.magsLeftInBarrel = C.MAGS_PER_BARREL;
    this.reloadTimer = C.RELOAD_TIME;
    this._sfx.playReload();
    return true;
  }

  private hasAmmo(): boolean {
    return this.roundsInMag > 0 || this.magsLeft > 0;
  }

  // 発砲入力を処理し、発射・排莢・リロードを行う。戻り値は「このフレームで発砲を
  // 新規開始したか」— fineAttitude の有効化は移動系(PlayerThrottle)の責務なので、
  // 呼び出し元(Player)へ判定だけ返す。canFire(ワープ倍率・生死を合成した
  // 「発射可能か」)は Player が一元的に判定して渡す — ここではワープ値そのものは
  // 扱わない。マップモード中はそもそも呼ばれない(Player.behaveMapMode → tickMapMode
  // 参照)。ship は発射位置・反動・排莢の基準になる自機の位置・姿勢(Player 自身)。
  updateFireState(
    dt: number,
    input: Input,
    alive: boolean,
    canFire: boolean,
    ship: Ship,
    scoreCounter: ScoreCounter,
    fireCtx: FireCtx,
  ): boolean {
    const keyHeld = input.down('Space') || input.mouseFiring;
    if (keyHeld && alive && !canFire) {
      this._hud.hint(`射撃・推進はワープ ×${C.MAX_PHYS_SIM_SPEED} 以下でのみ可能`);
    }
    const hasAmmo = this.hasAmmo();
    if (keyHeld && alive && !hasAmmo && !this.wasEmptyClick) {
      this._sfx.emptyClick();
      this._hud.hint('弾薬切れ — 軌道上の補給 ▣ を回収せよ', 3000);
    }
    this.wasEmptyClick = keyHeld && !hasAmmo;

    if (this.tickReloadTimer(dt)) {
      this.wasFiring = false;
      return false;
    }

    const wantFire = keyHeld && hasAmmo && canFire;
    const justStartedFiring = wantFire && !this.wasFiring;
    this.wasFiring = wantFire;
    if (!wantFire) return justStartedFiring;

    this.fireCycle(dt, justStartedFiring, fireCtx, ship, scoreCounter);
    return justStartedFiring;
  }

  // マップモード中: 発射入力は無効だが、装填(リロード)だけは戦闘可否に関わらず
  // 実時間で進行する(時間ワープ中でも装填サイクルは現実時間で完了する)。
  tickMapMode(dt: number): void {
    this.tickReloadTimer(dt);
    this.wasFiring = false;
    this.wasEmptyClick = false;
  }

  private tickReloadTimer(dt: number): boolean {
    if (this.reloadTimer <= 0) return false;
    this.reloadTimer -= dt;
    return true;
  }

  // CoolDown 周期での連射管理: 発射開始時のスピンアップと、周期が満ちるごとの
  // fireGun 呼び出しのみを扱う(発射可否の判定は updateFireState、1発の演出・
  // 弾薬消費は fireGun の責務)。
  private fireCycle(dt: number, justStartedFiring: boolean, ctx: FireCtx, ship: Ship, scoreCounter: ScoreCounter): void {
    if (justStartedFiring) {
      this._sfx.spinUp();
      this.fireCooldown = C.SPINUP_TIME;
    }
    this.fireCooldown -= dt;
    if (this.fireCooldown > 0) return;
    this.fireCooldown = C.FIRE_INTERVAL;
    this.fireGun(ctx, ship, scoreCounter);
  }

  // ---------------------------------------------------------------- weapons

  // 1発発射する: 弾丸・薬莢・マズルフラッシュを生成し、命中数とは独立な発射数を
  // 記録したのち、弾薬(マガジン/バレル)を消費する。
  private fireGun(ctx: FireCtx, ship: Ship, scoreCounter: ScoreCounter): void {
    const fwd = qRotate(ship.att.q, v3(0, 0, 1));

    // 縦二連の砲口から交互に発射する
    const mo = MUZZLE_OFFSETS[this.muzzleIdx]!;
    this.muzzleIdx = (this.muzzleIdx + 1) % MUZZLE_OFFSETS.length;
    const muzzle = add(ship.state.r, qRotate(ship.att.q, v3(mo.x, mo.y, mo.z)));

    this.spawnBullet(ctx, ship, muzzle, fwd);
    // 反動(運動量保存の風味): 発射方向と逆に微小 Δv
    ship.state.v = addScaled(ship.state.v, fwd, -C.RECOIL_DV);
    this.dropCasing(ctx, ship, muzzle);
    this.spawnMuzzleFlash(ctx, ship, muzzle, fwd);

    scoreCounter.recordShot();
    this._sfx.fire();

    this.consumeRound(ctx, ship);
  }

  // 弾丸: 機首方向 + 散布界
  private spawnBullet(ctx: FireCtx, ship: Ship, muzzle: Vec3, fwd: Vec3): void {
    const dir = norm(addScaled(fwd, randPerp(fwd), Math.abs(randSym(C.BULLET_SPREAD))));
    const bullet = new Bullet(
      {
        r: addScaled(clone(muzzle), fwd, 1.5),
        v: addScaled(clone(ship.state.v), dir, C.MUZZLE_SPEED),
      },
      ctx.simTime,
      C.BULLET_LIFETIME,
      'player',
      'normal',
      this._scene,
    );
    ctx.addBullet(bullet);
  }

  // 薬莢: 機体右側(-X)へ排出(左側(+X)はマガジンベルトの給弾があるため)。
  // 初速・回転とも抑え、ゆっくり漂いながら緩やかに回転する見た目にする。
  private dropCasing(ctx: FireCtx, ship: Ship, muzzle: Vec3): void {
    const right = qRotate(ship.att.q, v3(1, 0, 0));
    const up = qRotate(ship.att.q, v3(0, 1, 0));
    const casing = new Casing(
      {
        r: add(muzzle, scale(right, -1.4)),
        v: add(
          ship.state.v,
          add(scale(right, -(0.5 + Math.random() * 0.3)), add(scale(up, randSym(0.2)), randVec(0.1))),
        ),
      },
      {
        q: randomQuat(),
        w: v3(randSym(2.5), randSym(2.5), randSym(2.5)),
        inertia: v3(1, 0.3, 1), // 円筒: 長軸まわりが小さい
      },
      ctx.simTime,
      this._scene,
    );
    ctx.addCasing(casing);
  }

  // マズルフラッシュ: 発射した側の砲口に出す
  // (ズーム中は画面のちらつきを抑えるため大幅減光、完全には消さない)
  private spawnMuzzleFlash(ctx: FireCtx, ship: Ship, muzzle: Vec3, fwd: Vec3): void {
    spawnFlash(
      this._scene,
      ctx.fx,
      addScaled(muzzle, fwd, 1.2),
      ship.state.v,
      2.2,
      6,
      0.07,
      0xfff0b8,
      ctx.zoomActive ? C.ZOOM_MUZZLE_FLASH_SCALE : 1,
      true, // マズルフラッシュ: PIP 描画時のみ非表示化の対象
    );
  }

  // 1発分の弾薬を消費する。マガジンを撃ち尽くした場合は外枠をデブリとして排出し、
  // バレルの残りマガジン数(magsLeftInBarrel)が尽きたらバレル交換(リロード)を発生させる。
  private consumeRound(ctx: FireCtx, ship: Ship): void {
    this.roundsInMag--;
    if (this.roundsInMag > 0 || this.magsLeft <= 0) return;
    this.magsLeft--;
    this.roundsInMag = C.MAG_ROUNDS;
    this.magsLeftInBarrel--;
    this.spawnEjectedMagazineFrame(ctx, ship);
    if (this.magsLeftInBarrel > 0) {
      this._sfx.magFeed();
      return;
    }
    this.magsLeftInBarrel = C.MAGS_PER_BARREL;
    this.reloadTimer = C.RELOAD_TIME;
    this.dropBarrel(ctx, ship);
    this._sfx.playReload();
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
      { kind: 'barrel' },
      {
        q: { x: ship.att.q.x, y: ship.att.q.y, z: ship.att.q.z, w: ship.att.q.w },
        w: v3(randSym(2), randSym(2), randSym(2)),
        inertia: v3(1, 0.2, 1), // 円柱
      },
      0.8,
      this._scene,
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
      { kind: 'magazineFrame' },
      {
        q: { x: ship.att.q.x, y: ship.att.q.y, z: ship.att.q.z, w: ship.att.q.w },
        w: v3(randSym(0.2), randSym(0.2), randSym(0.2)),
        inertia: v3(1, 1.2, 1.4),
      },
      C.EJECTED_MAG_PHYS_RADIUS,
      this._scene,
    );
    ctx.addDebris(piece);
  }
}
