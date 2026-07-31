// プレイヤーの射撃・弾薬(マガジン/リロード)状態。発砲・排莢・バレル交換の
// 演出もここで組み立てる(effects-system.ts のスポーン関数を直接呼び、命中数とは
// 独立な「発射数」だけ ScoreCounter.recordShot() で集計する)。未使用弾のベルト
// (表示メッシュ + たわみ物理)は belt.ts の Belt が持ち、Player が直接所有する。
import * as THREE from 'three/webgpu';
import { qRotate, randomQuat } from '../../physics/attitude';
import { orbitState } from '../../physics/orbital';
import { add, addScaled, norm, randPerp, randSym, randVec, scale, v3, Vec3 } from '../../physics/vec3';
import * as C from '../const';
import { Input } from '../input/input';
import { KEY_MAPPING as K } from '../input/key-mapping';
import { Hud } from '../hud/hud';
import { Sfx } from '../../audio/sfx';
import { Ship } from '../game-entity/ship';
import { Bullet } from '../game-entity/bullet';
import { MUZZLE_OFFSETS } from '../../render/ships';
import { EffectsSystem } from '../vfx/effects-system';
import { ScoreCounter } from '../stages/stage-utils/score-counter';
import { SimSpeedManager } from '../sim-speed-manager';
import { Player } from './player';

export type ConsumeResult = 'empty' | 'normal' | 'mag-reload' | 'barrel-reload';

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
    private readonly _sfx: Sfx,
    private readonly _scene: THREE.Scene,
    private readonly _fx: EffectsSystem,
  ) { }

  get isFiring(): boolean { return this.wasFiring; }

  get left(): boolean { return this.rounds > 0 || this.mags > 0; }

  initAmmo(mags: number, rounds: number): void {
    this.mags = mags;
    this.rounds = rounds;
    this.barrel = C.MAGS_PER_BARREL;
    this.cooldown = 0;
    this.wasEmptyClick = false;
    this.wasFiring = false;
  }

  onPickup(mags: number): void {
    this.mags += mags;
    if (this.rounds <= 0) { // 弾切れ状態だったならすぐにリロードする
      this.mags--;
      this.rounds = C.MAG_ROUNDS;
    }
  }

  stopFiring(): void {
    this.wasFiring = false;
  }

  // 発砲入力を処理し、発射・排莢・リロードを行う。fineAttitude の有効化は移動系
  // (PlayerThrottle)の責務なので、ここでは扱わない。ワープ倍率による発射可否は
  // 受け取った simSpeed(SimSpeedManager)の canPlayerFire を自分で見て判定する。
  // マップモード中は Player.behave の editMode 分岐が tickMapMode を呼んで
  // こちらは呼ばれない。ship は発射位置・反動・排莢の基準になる自機の位置・姿勢
  // (Player 自身)。
  updateFireState(
    dt: number,
    input: Input,
    scoreCounter: ScoreCounter,
    simTime: number,
    simSpeed: SimSpeedManager,
    zoomActive: boolean,
    addBullet: (bullet: Bullet) => void,
  ): void {
    this.tickReloadTimer(dt);

    const keyHeld = input.down(K.fire) || input.mouseFiring;
    if (!keyHeld) {
      // トリガーを離した時点で連射状態を畳む: wasFiring を立てたままにすると
      // fineAttitude(微調整出力)が恒久的に有効なままになり、次にトリガーを
      // 引いたときもスピンアップ演出(justStartedFiring)が起きなくなる。
      this.wasFiring = false;
      return;
    }

    if (!simSpeed.canPlayerFire) {
      this._hud.hint(`射撃・推進はワープ ×${C.MAX_PHYS_SIM_SPEED} 以下でのみ可能`);
      return;
    }

    if (!this.left) {
      if (!this.wasEmptyClick) {
        this._sfx.emptyClick();
        this._hud.hint('弾薬切れ — 軌道上の補給 ▣ を回収せよ', 3000);
        this.wasEmptyClick = true;
      }
      return;
    }

    this.fireCycle(scoreCounter, simTime, zoomActive, addBullet);
  }

  // マップモード中: 発射入力は無効だが、装填(リロード)だけは戦闘可否に関わらず
  // 実時間で進行する(時間ワープ中でも装填サイクルは現実時間で完了する)。
  tickMapMode(dt: number): void {
    this.tickReloadTimer(dt);
    this.wasFiring = false;
    this.wasEmptyClick = false;
  }

  private tickReloadTimer(dt: number): void {
    if (0 < this.cooldown)
      this.cooldown -= dt;
  }

  // CoolDown 周期での連射管理: 発射開始時のスピンアップと、周期が満ちるごとの
  // fireGun 呼び出しのみを扱う(発射可否の判定は updateFireState、1発の演出・
  // 弾薬消費は fireGun の責務)。
  private fireCycle(
    scoreCounter: ScoreCounter,
    simTime: number,
    zoomActive: boolean,
    addBullet: (bullet: Bullet) => void,
  ): void {
    const justStartedFiring = !this.wasFiring;
    this.wasFiring = true;
    this.wasEmptyClick = false;

    // 起動時のタイムラグ
    if (justStartedFiring) {
      this._sfx.spinUp();
      this.cooldown = C.SPINUP_TIME;
      return;
    }

    // 起動時及びクールダウン中は発射しない
    if (0 < this.cooldown) {
      return;
    }

    const result = this.consume();

    this.fireGun(scoreCounter, simTime, zoomActive, addBullet);
    switch (result) {
      case 'empty':
      case 'normal':
        this.cooldown = C.FIRE_INTERVAL;
        return;
      case 'mag-reload':
        this.spawnEjectedMagazineFrame(this.player);
        this._sfx.magFeed();
        this.cooldown = C.FIRE_INTERVAL;
        return;
      case 'barrel-reload':
        this.spawnEjectedMagazineFrame(this.player);
        this.cooldown = C.RELOAD_TIME;
        this.dropBarrel(this.player);
        this._sfx.playReload();
        return;
    }
  }

  // 1発の消費を試みる。マガジンを撃ち尽くしたら次のマガジンへ(mag-reload)、
  // バレル内の全マガジンを撃ち尽くしたらバレル交換(barrel-reload)を報告する。
  consume(): ConsumeResult {
    if (!this.left) return 'empty';

    this.rounds--;
    if (this.rounds > 0) return 'normal';
    if (this.mags <= 0) return 'normal'; // 最後の1発を撃ち切った(次回から empty)

    this.mags--;
    this.rounds = C.MAG_ROUNDS;
    this.barrel--;
    if (this.barrel > 0) return 'mag-reload';

    this.barrel = C.MAGS_PER_BARREL;
    return 'barrel-reload';
  }

  manualReload(): boolean {
    if (this.cooldown > 0) return false;

    const canReload = this.mags > 0 && (this.rounds < C.MAG_ROUNDS || this.barrel < C.MAGS_PER_BARREL);
    if (!canReload) return false;
    this.mags--;
    this.rounds = C.MAG_ROUNDS;
    this.barrel = C.MAGS_PER_BARREL;
    this.cooldown = C.RELOAD_TIME;
    this._sfx.playReload();
    this.dropBarrel(this.player);
    return true;
  }

  // ---------------------------------------------------------------- entity管理

  // 1発発射する: 弾丸・薬莢・マズルフラッシュを生成し、命中数とは独立な発射数を
  // 記録する。弾薬(マガジン/バレル)の消費は呼び出し元 fireCycle が consume() で
  // これより先に済ませている。
  private fireGun(
    scoreCounter: ScoreCounter,
    simTime: number,
    zoomActive: boolean,
    addBullet: (bullet: Bullet) => void,
  ): void {
    const fwd = qRotate(this.player.att.q, v3(0, 0, 1));

    // 縦二連の砲口から交互に発射する
    const mo = MUZZLE_OFFSETS[this.muzzleIdx]!;
    this.muzzleIdx = (this.muzzleIdx + 1) % MUZZLE_OFFSETS.length;
    const muzzle = add(this.player.state.r, qRotate(this.player.att.q, v3(mo.x, mo.y, mo.z)));

    this.spawnBullet(this.player, muzzle, fwd, simTime, addBullet);
    // 反動(運動量保存の風味): 発射方向と逆に微小 Δv(瞬間的な速度変更なので時刻は据え置き)
    this.player.state = orbitState(
      this.player.state.t,
      this.player.state.r,
      addScaled(this.player.state.v, fwd, -C.RECOIL_DV),
    );
    this.dropCasing(this.player, muzzle, simTime);
    this.spawnMuzzleFlash(this.player, muzzle, fwd, zoomActive);

    scoreCounter.recordShot();
    this._sfx.fire();
  }

  // 弾丸: 機首方向 + 散布界
  private spawnBullet(ship: Ship, muzzle: Vec3, fwd: Vec3, simTime: number, addBullet: (bullet: Bullet) => void): void {
    const dir = norm(addScaled(fwd, randPerp(fwd), Math.abs(randSym(C.BULLET_SPREAD))));
    const bullet = new Bullet(
      orbitState(
        simTime,
        addScaled(muzzle, fwd, 1.5),
        addScaled(ship.state.v, dir, C.MUZZLE_SPEED),
      ),
      C.BULLET_LIFETIME,
      'player',
      'normal',
      this._scene,
    );
    addBullet(bullet);
  }

  // 薬莢: -X 側へ排出(+X 側はマガジンベルトの給弾があるため)。
  // 初速・回転とも抑え、ゆっくり漂いながら緩やかに回転する見た目にする。
  private dropCasing(ship: Ship, muzzle: Vec3, simTime: number): void {
    const right = qRotate(ship.att.q, v3(1, 0, 0));
    const up = qRotate(ship.att.q, v3(0, 1, 0));
    this._fx.spawnCasing(
      orbitState(
        simTime,
        add(muzzle, scale(right, -1.4)),
        add(
          ship.state.v,
          add(scale(right, -(0.5 + Math.random() * 0.3)), add(scale(up, randSym(0.2)), randVec(0.1))),
        ),
      ),
      {
        q: randomQuat(),
        w: v3(randSym(2.5), randSym(2.5), randSym(2.5)),
        inertia: v3(1, 0.3, 1), // 円筒: 長軸まわりが小さい
      },
      simTime,
    );
  }

  // マズルフラッシュ: 発射した側の砲口に出す
  // (ズーム中は画面のちらつきを抑えるため大幅減光、完全には消さない)
  private spawnMuzzleFlash(ship: Ship, muzzle: Vec3, fwd: Vec3, zoomActive: boolean): void {
    this._fx.spawnFlash(
      addScaled(muzzle, fwd, 1.2),
      ship.state.v,
      2.2,
      6,
      0.07,
      0xfff0b8,
      zoomActive ? C.ZOOM_MUZZLE_FLASH_SCALE : 1,
    );
  }

  // リロード時(バレル交換)に円柱アイテムをデブリとして放出する。手動リロード
  // ([R]キー、player.ts の handleEdgePress)からも直接呼ばれるため public。
  dropBarrel(ship: Ship): void {
    // 下方に少し勢いをつけて放出
    const down = qRotate(ship.att.q, v3(0, -1, 0));
    this._fx.spawnBarrel(
      orbitState(
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
    const right = qRotate(ship.att.q, v3(1, 0, 0));
    const portWorld = add(ship.state.r, qRotate(ship.att.q, v3(-0.9, 0, 0)));
    this._fx.spawnMagazineFrame(
      orbitState(
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
