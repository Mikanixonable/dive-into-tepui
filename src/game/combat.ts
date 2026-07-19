// 武器(発射・敵AI)と被弾・撃破まわりの処理。
// game.ts を import しない — 依存は CombatCtx 引数・コンストラクタ注入のみ。
import * as THREE from 'three/webgpu';
import { qRotate, randomQuat } from '../physics/attitude';
import {
  Vec3,
  add,
  addScaled,
  clone,
  dot,
  len,
  lenSq,
  norm,
  rotateAxis,
  scale,
  sub,
  v3,
} from '../physics/vec3';
import * as C from './const';
import { Bullet, Casing, DebrisPiece, FlashEffect, PlasmaBullet, Ship } from './entities';
import { Hud } from './hud';
import { Sfx } from './audio';
import { ACCENT } from './theme';
import {
  MUZZLE_OFFSETS,
  buildBarrelMesh,
  buildBulletMesh,
  buildCasingMesh,
  buildDebrisMesh,
  buildFlashMesh,
  buildMagazineFrame,
  buildPlasmaMesh,
} from '../render/ships';

function randSym(amp: number): number {
  return (Math.random() * 2 - 1) * amp;
}

function randVec(amp: number): Vec3 {
  return v3(randSym(amp), randSym(amp), randSym(amp));
}

// fwd に直交するランダム単位ベクトル(散布界用)。game.ts の randPerp と同一実装。
function randPerp(fwd: Vec3): Vec3 {
  for (; ;) {
    const r = randVec(1);
    const p = sub(r, scale(fwd, dot(r, fwd)));
    if (lenSq(p) > 1e-6) return norm(p);
  }
}

// fireGun / firePlasma / checkBulletHits / destroyShip 等が必要とする、Game 側の
// 現在状態のスナップショット(毎フレーム/毎呼び出しで渡す)。enemies / bullets /
// plasmaBullets / casings / debris / effects / boardMarks / scene は参照渡しで
// ミューテートする(game.ts 側の配列・シーンをそのまま操作する)。
// roundsInMag / magsLeft / magsConsumedSinceReload / reloadTimer は fireGun 内で
// 書き換えられる値渡しのスナップショットで、呼び出し側(game.ts)が戻り値を
// 自身のフィールドへ書き戻す。
export interface CombatCtx {
  simTime: number;
  player: Ship;
  enemies: Ship[];
  target: Ship | null;
  stage: number;
  zoomActive: boolean;
  scene: THREE.Scene;
  glowTex: THREE.Texture;
  bullets: Bullet[];
  plasmaBullets: PlasmaBullet[];
  casings: Casing[];
  debris: DebrisPiece[];
  effects: FlashEffect[];
  boardMarks: { off: Vec3; age: number }[];
  lostReason: string;
  roundsInMag: number;
  magsLeft: number;
  magsConsumedSinceReload: number;
  reloadTimer: number;
  setLostReason(reason: string): void;
  setPhase(phase: 'playing' | 'won' | 'lost' | 'timeup'): void;
}

export class CombatSystem {
  // --- 弾薬・マガジン ---
  private muzzleIdx = 0; // 縦二連砲口の交互発射用

  shots = 0;
  hits = 0;
  kills = 0;

  constructor(
    private readonly hud: Hud,
    private readonly sfx: Sfx,
  ) {}

  // ------------------------------------------------------------ weapons

  fireGun(ctx: CombatCtx): void {
    const p = ctx.player;
    const fwd = qRotate(p.att.q, v3(0, 0, 1));
    const right = qRotate(p.att.q, v3(1, 0, 0));
    const up = qRotate(p.att.q, v3(0, 1, 0));

    // 縦二連の砲口から交互に発射する
    const mo = MUZZLE_OFFSETS[this.muzzleIdx]!;
    this.muzzleIdx = (this.muzzleIdx + 1) % MUZZLE_OFFSETS.length;
    const muzzle = add(p.state.r, qRotate(p.att.q, v3(mo.x, mo.y, mo.z)));

    // 弾丸: 機首方向 + 散布界
    const dir = norm(addScaled(fwd, randPerp(fwd), Math.abs(randSym(C.BULLET_SPREAD))));
    const bullet: Bullet = {
      state: {
        r: addScaled(clone(muzzle), fwd, 1.5),
        v: addScaled(clone(p.state.v), dir, C.MUZZLE_SPEED),
      },
      prevR: v3(),
      bornSim: ctx.simTime,
      obj: buildBulletMesh(),
      alive: true,
    };
    bullet.prevR = clone(bullet.state.r);
    ctx.bullets.push(bullet);
    ctx.scene.add(bullet.obj);
    if (ctx.bullets.length > C.MAX_BULLETS) {
      const old = ctx.bullets.shift()!;
      ctx.scene.remove(old.obj);
    }

    // 反動(運動量保存の風味): 発射方向と逆に微小 Δv
    p.state.v = addScaled(p.state.v, fwd, -C.RECOIL_DV);

    // 薬莢: 機体右側(-X)へ排出(左側(+X)はマガジンベルトの給弾があるため)。
    // 初速・回転とも抑え、ゆっくり漂いながら緩やかに回転する見た目にする。
    const casing: Casing = {
      state: {
        r: add(muzzle, scale(right, -1.4)),
        v: add(
          p.state.v,
          add(scale(right, -(0.5 + Math.random() * 0.3)), add(scale(up, randSym(0.2)), randVec(0.1))),
        ),
      },
      att: {
        q: randomQuat(),
        w: v3(randSym(2.5), randSym(2.5), randSym(2.5)),
        inertia: v3(1, 0.3, 1), // 円筒: 長軸まわりが小さい
      },
      bornSim: ctx.simTime,
      obj: buildCasingMesh(),
    };
    ctx.casings.push(casing);
    ctx.scene.add(casing.obj);
    if (ctx.casings.length > C.MAX_CASINGS) {
      const old = ctx.casings.shift()!;
      ctx.scene.remove(old.obj);
    }

    // マズルフラッシュ: 発射した側の砲口に出す
    // (ズーム中は画面のちらつきを抑えるため大幅減光、完全には消さない)
    this.spawnFlash(
      ctx,
      addScaled(clone(muzzle), fwd, 1.2),
      clone(p.state.v),
      2.2,
      6,
      0.07,
      0xfff0b8,
      ctx.zoomActive ? C.ZOOM_MUZZLE_FLASH_SCALE : 1,
      true, // マズルフラッシュ: PIP 描画時のみ非表示化の対象
    );

    this.shots++;
    this.sfx.fire();

    // 弾薬消費: マガジン撃ち尽くした瞬間
    ctx.roundsInMag--;
    if (ctx.roundsInMag <= 0 && ctx.magsLeft > 0) {
      ctx.magsLeft--;
      ctx.roundsInMag = C.MAG_ROUNDS;
      ctx.magsConsumedSinceReload++;
      this.spawnEjectedMagazineFrame(ctx);

      // マガジン3つ消費でバレル交換リロード
      if (ctx.magsConsumedSinceReload >= 3) {
        ctx.magsConsumedSinceReload = 0;
        ctx.reloadTimer = C.RELOAD_TIME; // クールダウン
        this.sfx.playReload();
        this.dropBarrel(ctx);
      } else {
        // 通常の給弾(マガジン連結のみ)
        this.sfx.magFeed();
      }
    }
  }

  // リロード時(バレル交換)に円柱アイテムをデブリとして放出する
  dropBarrel(ctx: CombatCtx): void {
    const p = ctx.player;
    // 下方に少し勢いをつけて放出
    const down = qRotate(p.att.q, v3(0, -1, 0));
    const piece: DebrisPiece = {
      state: {
        r: add(p.state.r, qRotate(p.att.q, v3(0, -1, 1.5))), // 機首下部あたりから
        v: add(p.state.v, add(scale(down, 3.0), randVec(0.5))),
      },
      att: {
        q: { x: p.att.q.x, y: p.att.q.y, z: p.att.q.z, w: p.att.q.w },
        w: v3(randSym(2), randSym(2), randSym(2)),
        inertia: v3(1, 0.2, 1), // 円柱
      },
      obj: buildBarrelMesh(),
      collideRadius: 0.8,
    };
    ctx.debris.push(piece);
    ctx.scene.add(piece.obj);
    while (ctx.debris.length > C.MAX_DEBRIS) {
      const old = ctx.debris.shift()!;
      this.removeDebrisObj(ctx, old);
    }
  }

  // マガジン1個を撃ち尽くした瞬間、機体右側(-X、薬莢と同じ側)の位置から
  // 空になったマガジンの外枠(弾なし)をデブリとして放出する。
  spawnEjectedMagazineFrame(ctx: CombatCtx): void {
    const p = ctx.player;
    const right = qRotate(p.att.q, v3(1, 0, 0));
    const portWorld = add(p.state.r, qRotate(p.att.q, v3(-0.9, 0, 0)));
    const piece: DebrisPiece = {
      state: {
        r: portWorld,
        v: add(p.state.v, add(scale(right, -(0.5 + Math.random() * 0.3)), randVec(0.15))),
      },
      att: {
        q: { x: p.att.q.x, y: p.att.q.y, z: p.att.q.z, w: p.att.q.w },
        w: v3(randSym(0.2), randSym(0.2), randSym(0.2)),
        inertia: v3(1, 1.2, 1.4),
      },
      obj: buildMagazineFrame(),
      collideRadius: C.EJECTED_MAG_PHYS_RADIUS,
    };
    ctx.debris.push(piece);
    ctx.scene.add(piece.obj);
    while (ctx.debris.length > C.MAX_DEBRIS) {
      const old = ctx.debris.shift()!;
      this.removeDebrisObj(ctx, old);
    }
  }

  // ---------------------------------------------------------- enemy AI

  updateEnemyAI(dt: number, ctx: CombatCtx): void {
    if (!ctx.player.alive) return;

    // 集団(色)ごとの攻撃中(バースト中)の機体数をカウント
    const attackingCounts = new Map<number, number>();
    for (const e of ctx.enemies) {
      if (e.alive && e.burstLeft && e.burstLeft > 0) {
        const key = e.accent ?? 0;
        attackingCounts.set(key, (attackingCounts.get(key) || 0) + 1);
      }
    }

    for (const e of ctx.enemies) {
      if (!e.alive) continue;
      const dist = len(sub(ctx.player.state.r, e.state.r));
      if (dist < C.STAGE00_MAX_RANGE && dist > C.ENEMY_AI_MIN_RANGE) {
        if (e.burstLeft && e.burstLeft > 0) {
          e.burstDelay = (e.burstDelay ?? 0) - dt;
          if (e.burstDelay <= 0) {
            this.firePlasma(e, ctx);
            e.burstLeft--;
            e.burstDelay = C.ENEMY_BURST_INTERVAL;
          }
        } else {
          if (e.lastFireSim === undefined) e.lastFireSim = ctx.simTime - Math.random() * C.ENEMY_FIRE_INTERVAL;
          if (ctx.simTime - e.lastFireSim > C.ENEMY_FIRE_INTERVAL) {
            e.lastFireSim = ctx.simTime;
            const key = e.accent ?? 0;
            const countInGroup = attackingCounts.get(key) || 0;
            // 同一集団内で同時に攻撃するのは最大3機まで
            if (countInGroup < C.ENEMY_MAX_ATTACKERS_PER_GROUP && Math.random() < C.ENEMY_ATTACK_CHANCE) {
              const counts = C.ENEMY_BURST_COUNTS;
              e.burstLeft = counts[Math.floor(Math.random() * counts.length)]! - 1;
              e.burstDelay = C.ENEMY_BURST_INTERVAL;
              attackingCounts.set(key, countInGroup + 1);
              this.firePlasma(e, ctx);
            }
          }
        }
      }
    }
  }

  firePlasma(enemy: Ship, ctx: CombatCtx): void {
    const r = enemy.state.r;
    const v = enemy.state.v;
    const toPlayer = sub(ctx.player.state.r, r);
    const pV = ctx.player.state.v;
    const eV = enemy.state.v;
    const relV = sub(pV, eV);

    // 正確な見越し時間を計算
    let timeToHit = this.solveLeadTime(toPlayer, relV, C.PLASMA_BULLET_SPEED);
    if (timeToHit === null || timeToHit < 0) {
      timeToHit = len(toPlayer) / C.PLASMA_BULLET_SPEED; // フォールバック
    }

    const predictedRelPos = add(toPlayer, scale(relV, timeToHit));
    const aimDir = norm(predictedRelPos);

    // 散布界を非常に小さくして、正確に狙う
    const perp = randPerp(aimDir);
    const spreadAng = (Math.random() * C.PLASMA_SPREAD_DEG * Math.PI) / 180;
    const actualAim = rotateAxis(aimDir, perp, spreadAng);

    const bV = add(v, scale(actualAim, C.PLASMA_BULLET_SPEED));

    const pb: PlasmaBullet = {
      state: { r: clone(r), v: bV },
      prevR: clone(r),
      bornSim: ctx.simTime,
      obj: buildPlasmaMesh(enemy.accent ?? 0xffa0ff),
      alive: true,
    };
    pb.obj.position.set(r.x, r.y, r.z);
    // 進行方向に向ける
    const mz = new THREE.Matrix4().lookAt(
      new THREE.Vector3(),
      new THREE.Vector3(actualAim.x, actualAim.y, actualAim.z),
      new THREE.Vector3(0, 1, 0)
    );
    pb.obj.quaternion.setFromRotationMatrix(mz);

    ctx.plasmaBullets.push(pb);
    ctx.scene.add(pb.obj);
    if (ctx.plasmaBullets.length > C.MAX_BULLETS * 2) {
      const old = ctx.plasmaBullets.shift()!;
      ctx.scene.remove(old.obj);
    }
  }

  // ---------------------------------------------------------- hits / damage

  // ターゲット位置に「自機の方を向いた的(標的面)」があると見なし、
  // 発射弾がその面を自機側から通過した点をターゲット相対で記録する。
  // 次弾の照準修正の目安になるマーカーとして一定時間表示する。
  checkBoardCrossings(ctx: CombatCtx): void {
    const tgt = ctx.target;
    if (!tgt || !tgt.alive) return;
    const n = norm(sub(tgt.state.r, ctx.player.state.r)); // 的の法線 = 視線方向
    if (lenSq(n) < 0.5) return;

    for (const b of ctx.bullets) {
      if (!b.alive) continue;
      const d0 = dot(sub(b.prevR, tgt.state.r), n);
      const d1 = dot(sub(b.state.r, tgt.state.r), n);
      if (!(d0 < 0 && d1 >= 0)) continue; // 自機側 → 向こう側への通過のみ
      const t = d0 / (d0 - d1);
      const pos = addScaled(b.prevR, sub(b.state.r, b.prevR), t);
      const off = sub(pos, tgt.state.r);
      if (lenSq(off) > C.BOARD_RADIUS * C.BOARD_RADIUS) continue; // 的から外れすぎ
      ctx.boardMarks.push({ off, age: 0 });
      if (ctx.boardMarks.length > C.MAX_BOARD_MARKS) ctx.boardMarks.shift();
    }
  }

  // サブステップ間の相対運動を線分 vs 球でチェック(高速弾のトンネリング防止)
  checkBulletHits(ctx: CombatCtx): void {
    for (const b of ctx.bullets) {
      if (!b.alive) continue;
      for (const ship of ctx.enemies) {
        if (!ship.alive) continue;
        if (this.segmentHit(b, ship)) {
          this.applyHit(b, ship, ctx);
          break;
        }
      }
      if (!b.alive) continue;
      // 自機被弾(軌道を一周して戻ってきた自弾)
      if (
        ctx.player.alive &&
        ctx.simTime - b.bornSim > C.SELF_HIT_GRACE &&
        this.segmentHit(b, ctx.player)
      ) {
        this.applyHit(b, ctx.player, ctx);
      }
    }
    for (const pb of ctx.plasmaBullets) {
      if (!pb.alive) continue;
      if (ctx.player.alive && this.segmentHit(pb, ctx.player)) {
        pb.alive = false;
        ctx.scene.remove(pb.obj);
        ctx.player.hp -= C.PLAYER_HIT_DAMAGE;
        ctx.setLostReason('敵のエネルギー弾により機体を喪失した');
        this.hits++;
        this.sfx.hit();
        this.spawnFlash(ctx, clone(pb.state.r), clone(ctx.player.state.v), C.PLASMA_HIT_FLASH_SIZE0, C.PLASMA_HIT_FLASH_SIZE1, C.PLASMA_HIT_FLASH_DURATION, 0xffa0ff);
        this.spawnFragments(ctx, clone(pb.state.r), clone(ctx.player.state.v), C.HIT_FRAG_COUNT, 0x6a7078, C.HIT_FRAG_SIZE_MIN, C.HIT_FRAG_SIZE_MAX, C.HIT_FRAG_SPEED);
        if (ctx.player.hp <= 0) {
          this.destroyShip(ctx.player, ctx);
        }
      }
    }
  }

  private segmentHit(b: Bullet | PlasmaBullet, ship: Ship): boolean {
    const a = sub(b.prevR, ship.prevR);
    const bb = sub(b.state.r, ship.state.r);
    const d = sub(bb, a);
    const dd = lenSq(d);
    const t = dd > 1e-9 ? Math.max(0, Math.min(1, -dot(a, d) / dd)) : 0;
    const closest = addScaled(a, d, t);
    return lenSq(closest) <= ship.radius * ship.radius;
  }

  private applyHit(b: Bullet, ship: Ship, ctx: CombatCtx): void {
    b.alive = false;
    ship.hp -= (ship === ctx.player ? C.PLAYER_HIT_DAMAGE : C.ENEMY_HIT_DAMAGE);
    if (ship === ctx.player) ctx.setLostReason('自弾の被弾により機体を喪失した');
    this.hits++;
    this.sfx.hit();
    this.spawnFlash(ctx, clone(b.state.r), clone(ship.state.v), C.BULLET_HIT_FLASH_SIZE0, C.BULLET_HIT_FLASH_SIZE1, C.BULLET_HIT_FLASH_DURATION, 0xffe2a0);
    // 被弾時にも小さな欠片を飛散させる
    this.spawnFragments(ctx, clone(b.state.r), clone(ship.state.v), C.HIT_FRAG_COUNT, 0x6a7078, C.HIT_FRAG_SIZE_MIN, C.HIT_FRAG_SIZE_MAX, C.HIT_FRAG_SPEED);
    if (ship.hp <= 0) {
      this.destroyShip(ship, ctx);
    }
  }

  /**
   * @param byPlayer true = 弾丸命中による正式撃破（kills に加算し勝利判定を行う）
   *                 false = 再突入・空力分解など物理的消滅（カウントせず静かに除去）
   */
  destroyShip(ship: Ship, ctx: CombatCtx, byPlayer = true): void {
    ship.alive = false;
    ship.obj.visible = false;
    this.sfx.explosion();
    // 敵機は自機の 10 倍サイズなので、爆発・破片も見合った大きさにする
    const sc = ship === ctx.player ? 1 : C.ENEMY_SCALE;
    this.spawnFlash(ctx, clone(ship.state.r), clone(ship.state.v), C.DESTROY_FLASH1_SIZE0 * sc, C.DESTROY_FLASH1_SIZE1 * sc, C.DESTROY_FLASH1_DURATION, 0xffb36b);
    this.spawnFlash(ctx, clone(ship.state.r), clone(ship.state.v), C.DESTROY_FLASH2_SIZE0 * sc, C.DESTROY_FLASH2_SIZE1 * sc, C.DESTROY_FLASH2_DURATION, 0xfffbe8);
    this.spawnDebris(ship, sc, ctx);

    if (ship === ctx.player) {
      ctx.setPhase('lost');
      this.sfx.setThrust(false);
      this.sfx.stopBgm();
      this.hud.showEnd(false, `${ctx.lostReason}<br>撃破 ${this.kills}/${ctx.enemies.length} 機`);
      return;
    }

    if (byPlayer) {
      // 弾丸命中による正式撃破のみカウント
      this.kills++;
      this.hud.hint(`${ship.name} 撃破`);
    } else {
      // 再突入・空力分解によるデスポーンは撃破に含めない
      this.hud.hint(`${ship.name} 再突入により喪失`);
    }
    if (ctx.target === ship) {

    }
    // ステージ00(無限サバイバル)とステージ0(時間制限スコアアタック)は、敵全滅でクリアにはならない
    if (ctx.stage !== 0 && ctx.stage !== -1 && ctx.enemies.every((e) => !e.alive)) {
      if (byPlayer) {
        // 全機を自力で撃破した場合のみクリア
        ctx.setPhase('won');
        this.sfx.setThrust(false);
        this.sfx.stopBgm();
        let unlockNote = '';
        if (ctx.stage === 1) {
          try {
            const first = localStorage.getItem(C.STAGE1_CLEARED_KEY) !== '1';
            localStorage.setItem(C.STAGE1_CLEARED_KEY, '1');
            if (first) unlockNote = `<br><span style="color:${ACCENT}">第二ステージ(モルニヤ戦域)が解放された</span>`;
          } catch {
            /* localStorage 不可なら解放なし */
          }
        }
        const acc = this.shots > 0 ? ((this.hits / this.shots) * 100).toFixed(1) : '0.0';
        this.hud.showEnd(
          true,
          `全 ${ctx.enemies.length} 機撃破<br>` +
          `ミッション時間 T+ ${Math.floor(ctx.simTime / 3600)}h ${Math.floor((ctx.simTime % 3600) / 60)}m ${Math.floor(ctx.simTime % 60)}s<br>` +
          `発射 ${this.shots} 発 / 命中 ${this.hits} 発 (命中率 ${acc}%)` +
          unlockNote,
        );
      } else {
        // 再突入等で全機消滅しても勝利にはしない（残存機ゼロだが kills < enemies.length）
        // 継続してプレイングを続けさせる（そもそも alive === false なので弾も当たらない）
      }
    }
  }

  // 撃破デブリ: 非対称な慣性テンソル + 中間軸まわり回転 → ジャニベコフ効果
  private spawnDebris(ship: Ship, sc: number, ctx: CombatCtx): void {
    const accent = ship === ctx.player ? 0x9fd8e8 : 0xff6a4a;
    this.spawnFragments(ctx, ship.state.r, ship.state.v, 11, accent, C.DEBRIS_SIZE_MIN * sc, C.DEBRIS_SIZE_MAX * sc, 2.8);
  }

  // 破片を飛散させる共通処理(撃破デブリ・被弾の欠片)
  private spawnFragments(
    ctx: CombatCtx,
    origin: Vec3,
    baseVel: Vec3,
    count: number,
    accent: number,
    sizeMin: number,
    sizeMax: number,
    spread: number,
  ): void {
    for (let i = 0; i < count; i++) {
      const size = sizeMin + Math.random() * (sizeMax - sizeMin);
      const piece: DebrisPiece = {
        state: {
          r: add(origin, randVec(2.5)),
          v: add(baseVel, randVec(spread)),
        },
        att: {
          q: randomQuat(),
          w: v3(randSym(0.25), (1.4 + Math.random() * 1.2) * (Math.random() < 0.5 ? -1 : 1), randSym(0.25)),
          inertia: v3(1, 2.05, 3.0), // 中間軸 = y: ここに主回転を与えると周期的に反転する
        },
        obj: buildDebrisMesh(accent, size),
      };
      ctx.debris.push(piece);
      ctx.scene.add(piece.obj);
    }
    while (ctx.debris.length > C.MAX_DEBRIS) {
      const old = ctx.debris.shift()!;
      this.removeDebrisObj(ctx, old);
    }
  }

  // d.obj は単一 Mesh(通常の破片)の場合と、複数子メッシュを持つ Group
  // (排出された空マガジンのフレーム等)の場合がある。traverse して
  // 見つかった Mesh すべてのジオメトリ・マテリアルを破棄する。
  removeDebrisObj(ctx: CombatCtx, d: DebrisPiece): void {
    ctx.scene.remove(d.obj);
    d.obj.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      if (Array.isArray(mesh.material)) mesh.material.forEach((m) => m.dispose());
      else mesh.material.dispose();
    });
  }

  private spawnFlash(
    ctx: CombatCtx,
    pos: Vec3,
    vel: Vec3,
    size0: number,
    size1: number,
    duration: number,
    color: number,
    peakOpacity = 1,
    muzzle = false,
  ): void {
    const mesh = buildFlashMesh(ctx.glowTex, color);
    const fx: FlashEffect = { mesh, pos, vel, age: 0, duration, size0, size1, peakOpacity, muzzle };
    ctx.effects.push(fx);
    ctx.scene.add(mesh);
  }

  // |relP + relV t| = s t を満たす最小の正の t
  solveLeadTime(relP: Vec3, relV: Vec3, s: number): number | null {
    const a = lenSq(relV) - s * s;
    const b = 2 * dot(relP, relV);
    const c = lenSq(relP);
    if (Math.abs(a) < 1e-6) {
      if (Math.abs(b) < 1e-9) return null;
      const t = -c / b;
      return t > 0 ? t : null;
    }
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    const sq = Math.sqrt(disc);
    const t1 = (-b - sq) / (2 * a);
    const t2 = (-b + sq) / (2 * a);
    let best: number | null = null;
    for (const t of [t1, t2]) {
      if (t > 0 && (best === null || t < best)) best = t;
    }
    return best;
  }
}
