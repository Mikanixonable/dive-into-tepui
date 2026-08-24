// プレイヤーの射撃・弾薬(マガジン/リロード)状態。発砲・排莢・バレル交換の演出もここで組み立てる。
import * as THREE from 'three/webgpu';
import { qRotate, randomQuat } from '../../physics/attitude';
import { kinematicState } from '../../physics/kinematic-state';
import { R_EARTH_EQ } from '../../physics/solar-system';
import { randSym } from '../../physics/random';
import { add, addScaled, dot, lenSq, norm, randPerp, randVec, scale, v3, Vec3 } from '../../physics/vec3';
import type { Ephemeris } from '../../physics/ephemeris';
import * as C from '../const';
import { Input } from '../input/input';
import { KEY_MAPPING as K } from '../input/key-mapping';
import { Hud } from '../hud/hud';
import { WorldSfx } from '../../audio/sfx/world-sfx';
import { Ship } from '../game-entity/ship';
import { Bullet } from '../game-entity/bullet';
import type { EntityManager } from '../simulation/entity-manager';
import { MUZZLE_OFFSETS } from '../../render/ships';
import { EffectsSystem } from '../vfx/effects-system';
import type { Stage } from '../stages/stage';
import { Player } from './player';
import type { FireSaveData } from '../save-data';

export type ConsumeResult = 'empty' | 'normal' | 'mag-reload' | 'barrel-reload';

// 艦の初期積載(予備マガジン数・装填済み残弾数)。
export type AmmoLoad = { readonly mags: number; readonly rounds: number };

// スナップショットからの復元か、新規配置の初期積載か。どちらも省略すればフィールド初期化子の
// 既定積載で始まる。
export type FireInit =
  | { readonly saved: FireSaveData }
  | { readonly ammo?: AmmoLoad };

// 太陽グレアによる散布界の倍率。逆光(照準方向に太陽がある)ほど狙いが甘くなり、
// 順光では締まる。難易度調整のための経験則であって物理計算ではない。
// pos が地球の影(簡易円柱モデル)に入っていれば太陽光が届かないので倍率は 1。
function sunGlareSpreadScale(pos: Vec3, aimDir: Vec3, sunDir: Vec3): number {
  const along = dot(pos, sunDir);
  if (along < 0 && lenSq(addScaled(pos, sunDir, -along)) < R_EARTH_EQ * R_EARTH_EQ) return 1;

  const angle = (Math.acos(Math.max(-1, Math.min(1, dot(aimDir, sunDir)))) * 180) / Math.PI;
  if (angle <= 5) return 2;
  if (angle <= 30) return 1 + (30 - angle) / 25;
  if (angle >= 160) return 0.5;
  if (angle >= 130) return 1 - ((angle - 130) / 30) * 0.5;
  return 1;
}

export class PlayerFire {
  rounds = C.MAG_ROUNDS;
  mags = C.INITIAL_MAGS - 1;
  barrel = C.MAGS_PER_BARREL;

  cooldown = 0;
  wasFiring = false;
  wasEmptyClick = false;
  muzzleIdx = 0; // 縦二連砲口の交互発射用

  constructor(
    private readonly player: Player,
    private readonly _hud: Hud,
    private readonly _worldSfx: WorldSfx,
    private readonly _scene: THREE.Scene,
    private readonly _fx: EffectsSystem,
    init: FireInit = {},
  ) {
    if ('saved' in init) {
      this.mags = init.saved.mags;
      this.rounds = init.saved.rounds;
      this.barrel = init.saved.barrel;
      this.cooldown = init.saved.cooldown;
      this.muzzleIdx = init.saved.muzzleIdx;
    } else if (init.ammo) {
      this.mags = init.ammo.mags;
      this.rounds = init.ammo.rounds;
    }
  }

  get isFiring(): boolean { return this.wasFiring; }

  get left(): boolean { return this.rounds > 0 || this.mags > 0; }

  serialize(): FireSaveData {
    return {
      mags: this.mags,
      rounds: this.rounds,
      barrel: this.barrel,
      cooldown: this.cooldown,
      muzzleIdx: this.muzzleIdx,
    };
  }

  // 拾ったマガジン数を加算する。弾切れ中なら即座に1マガジンを装填する。
  onPickup(mags: number): void {
    this.mags += mags;
    if (this.rounds <= 0) { // 弾切れ状態だったならすぐにリロードする
      this.mags--;
      this.rounds = C.MAG_ROUNDS;
    }
  }

  // 発射状態を強制的に解除する。
  stopFiring(): void {
    this.wasFiring = false;
  }

  // 発射入力を1フレーム分処理する。トリガーが引かれ、ワープ速度・弾薬が許せば発射する。
  updateFireState(
    dt: number,
    input: Input,
    activeStage: Stage,
    entities: EntityManager,
    ephemeris: Ephemeris,
  ): void {
    this.tickReloadTimer(dt);

    const keyHeld = input.down(K.fire);
    if (!keyHeld) {
      // トリガーを離した時点で連射状態を畳む: wasFiring を立てたままにすると
      // fineAttitude(微調整出力)が恒久的に有効なままになり、次にトリガーを
      // 引いたときもスピンアップ演出(justStartedFiring)が起きなくなる。
      this.wasFiring = false;
      return;
    }

    if (this.player.totalFireRate <= 0) {
      if (!this.wasEmptyClick) {
        this._worldSfx.emptyClick();
        this._hud.hint('武装が損傷しており発射できない', 3000);
        this.wasEmptyClick = true;
      }
      return;
    }

    if (!this.left) {
      if (!this.wasEmptyClick) {
        this._worldSfx.emptyClick();
        this._hud.hint('弾薬切れ — 軌道上の補給 ▣ を回収せよ', 3000);
        this.wasEmptyClick = true;
      }
      return;
    }

    this.fireCycle(activeStage, entities, ephemeris);
  }

  // クールダウンタイマーを dt だけ減らす。
  private tickReloadTimer(dt: number): void {
    if (0 < this.cooldown)
      this.cooldown -= dt;
  }

  // クールダウン込みの発射サイクルを1回進める。スピンアップ中・クールダウン中は発射しない。
  private fireCycle(
    activeStage: Stage,
    entities: EntityManager,
    ephemeris: Ephemeris,
  ): void {
    const justStartedFiring = !this.wasFiring;
    this.wasFiring = true;
    this.wasEmptyClick = false;

    // 起動時のタイムラグ
    if (justStartedFiring) {
      this._worldSfx.spinUp();
      this.cooldown = C.SPINUP_TIME;
      return;
    }

    // 起動時及びクールダウン中は発射しない
    if (0 < this.cooldown) {
      return;
    }

    const result = this.consume();

    this.fireGun(activeStage, entities, ephemeris);
    switch (result) {
      case 'empty':
      case 'normal':
        this.cooldown = 1 / this.player.totalFireRate;
        return;
      case 'mag-reload':
        this.spawnEjectedMagazineFrame(this.player);
        this._worldSfx.magFeed();
        this.cooldown = 1 / this.player.totalFireRate;
        return;
      case 'barrel-reload':
        this.spawnEjectedMagazineFrame(this.player);
        this.cooldown = C.RELOAD_TIME;
        this.dropBarrel(this.player);
        this._worldSfx.playReload();
        return;
    }
  }

  // 1発の消費を試みる。マガジンを撃ち尽くしたら次のマガジンへ(mag-reload)、
  // バレル内の全マガジンを撃ち尽くしたらバレル交換(barrel-reload)を報告する。
  consume(): ConsumeResult {
    if (!this.left) return 'empty';

    // マガジンに弾が残っていれば1発消費するだけ
    this.rounds--;
    if (this.rounds > 0) return 'normal';
    if (this.mags <= 0) return 'normal'; // 最後の1発を撃ち切った(次回から empty)

    // マガジンを撃ち尽くしたので次のマガジンへ
    this.mags--;
    this.rounds = C.MAG_ROUNDS;
    this.barrel--;
    if (this.barrel > 0) return 'mag-reload';

    this.barrel = C.MAGS_PER_BARREL;
    return 'barrel-reload';
  }

  // 手動リロードを試みる。開始できたら true。
  manualReload(): boolean {
    if (this.cooldown > 0) return false;

    // 予備マガジンがあり、かつ装填中のマガジンに実際に補充の余地があるときだけリロードする
    const canReload = this.mags > 0 && this.rounds < C.MAG_ROUNDS;
    if (!canReload) return false;
    this.mags--;
    this.rounds = C.MAG_ROUNDS;
    this.barrel = C.MAGS_PER_BARREL;
    this.cooldown = C.RELOAD_TIME;
    this._worldSfx.playReload();
    this.dropBarrel(this.player);
    return true;
  }

  // ---------------------------------------------------------------- entity管理

  // 1発発射する: 弾丸・薬莢・マズルフラッシュを生成し、発射数を記録する。
  private fireGun(
    activeStage: Stage,
    entities: EntityManager,
    ephemeris: Ephemeris,
  ): void {
    const fwd = qRotate(this.player.att.q, v3(0, 0, 1));

    // 縦二連の砲口から交互に発射する
    const mo = MUZZLE_OFFSETS[this.muzzleIdx]!;
    this.muzzleIdx = (this.muzzleIdx + 1) % MUZZLE_OFFSETS.length;
    const muzzle = add(this.player.state.r, qRotate(this.player.att.q, v3(mo.x, mo.y, mo.z)));

    this.spawnBullet(this.player, muzzle, fwd, entities, ephemeris);
    // 反動(運動量保存の風味): 発射方向と逆に微小 Δv(瞬間的な速度変更なので時刻は据え置き)
    this.player.state = kinematicState(
      this.player.state.t,
      this.player.state.r,
      addScaled(this.player.state.v, fwd, -C.RECOIL_DV),
    );
    this.dropCasing(this.player, muzzle);
    this.spawnMuzzleFlash(this.player, muzzle, fwd);

    activeStage.scoreCounter.recordShot();
    this.player.absorbHeat(C.GUN_HEAT_PER_ROUND / C.PLAYER_MASS);
    this._worldSfx.fire();
  }

  // 弾丸: 機首方向 + 散布界
  private spawnBullet(
    ship: Ship, muzzle: Vec3, fwd: Vec3, entities: EntityManager, ephemeris: Ephemeris,
  ): void {
    const sunDir = ephemeris.sunDirFrom(ship.state.r, ship.state.t);
    const spreadScale = sunGlareSpreadScale(muzzle, fwd, sunDir);
    // 機首方向に散布角を加えた発射方向
    const spread = Math.abs(randSym(C.BULLET_SPREAD)) * spreadScale;
    const dir = norm(addScaled(fwd, randPerp(fwd), spread));
    const bullet = new Bullet(
      kinematicState(
        ship.state.t,
        addScaled(muzzle, fwd, 1.5),
        addScaled(ship.state.v, dir, ship.averageMuzzleVelocity),
      ),
      C.BULLET_LIFETIME,
      'player',
      'normal',
      ship.weaponDamage,
      this._worldSfx,
      this._scene,
      ship,
    );
    entities.addBullet(bullet);
  }

  // 薬莢: -X 側へ排出(+X 側はマガジンベルトの給弾があるため)。
  // 初速は抑えてゆっくり漂わせる一方、回転速度は個体ごとに大きくばらつかせる。
  private dropCasing(ship: Ship, muzzle: Vec3): void {
    // 機体姿勢基準の左右・上方向
    const right = qRotate(ship.att.q, v3(1, 0, 0));
    const up = qRotate(ship.att.q, v3(0, 1, 0));
    this._fx.spawnCasing(
      kinematicState(
        ship.state.t,
        add(muzzle, scale(right, -1.4)),
        add(
          ship.state.v,
          add(scale(right, -(0.5 + Math.random() * 0.3)), add(scale(up, randSym(0.2)), randVec(0.1))),
        ),
      ),
      {
        q: randomQuat(),
        w: v3(randSym(6.0), randSym(6.0), randSym(6.0)),
        inertia: v3(0.85, 0.3, 1.15), // 円筒: 長軸(y)が最小。x/z も非対称にしジャニベコフ効果を起こす
      },
      ship.state.t,
    );
  }

  // マズルフラッシュ: 発射した側の砲口の少し先に出す。
  private spawnMuzzleFlash(ship: Ship, muzzle: Vec3, fwd: Vec3): void {
    this._fx.spawnMuzzleFlash(kinematicState(ship.state.t, addScaled(muzzle, fwd, 1.2), ship.state.v));
  }

  // バレル交換時に円柱アイテムをデブリとして放出する。
  dropBarrel(ship: Ship): void {
    // 下方に少し勢いをつけて放出
    const down = qRotate(ship.att.q, v3(0, -1, 0));
    this._fx.spawnBarrel(
      kinematicState(
        ship.state.t,
        add(ship.state.r, qRotate(ship.att.q, v3(0, -1, 1.5))), // 機首下部あたりから
        add(ship.state.v, add(scale(down, 3.0), randVec(0.5))),
      ),
      {
        q: { x: ship.att.q.x, y: ship.att.q.y, z: ship.att.q.z, w: ship.att.q.w },
        w: v3(randSym(2), randSym(2), randSym(2)),
        inertia: v3(1, 0.2, 1), // 円柱
      },
    );
  }

  // マガジン1個を撃ち尽くした瞬間、-X 側(薬莢と同じ側)の位置から
  // 空になったマガジンの外枠(弾なし)をデブリとして放出する。
  private spawnEjectedMagazineFrame(ship: Ship): void {
    // 排出ポートの位置と初速
    const right = qRotate(ship.att.q, v3(1, 0, 0));
    const portWorld = add(ship.state.r, qRotate(ship.att.q, v3(-0.9, 0, 0)));
    this._fx.spawnMagazineFrame(
      kinematicState(
        ship.state.t,
        portWorld,
        add(ship.state.v, add(scale(right, -(0.5 + Math.random() * 0.3)), randVec(0.15))),
      ),
      {
        q: { x: ship.att.q.x, y: ship.att.q.y, z: ship.att.q.z, w: ship.att.q.w },
        w: v3(randSym(0.2), randSym(0.2), randSym(0.2)),
        inertia: v3(1, 1.2, 1.4),
      },
    );
  }
}
