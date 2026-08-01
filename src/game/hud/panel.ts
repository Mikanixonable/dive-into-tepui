// HUD ステータスパネル(スタッツ・ターゲット情報・敵一覧)の同期。
import * as C from '../const';
import { TEXT_DIM as INK_SOFT } from '../theme';
import { altitudeOf } from '../../physics/orbital';
import { dot, len, sub } from '../../physics/vec3';
import type { Game } from '../game';
import { fmtDist, fmtSpeed, fmtTime } from './utils';

interface StatsData {
  met: number;
  simSpeedLabel: string;
  paused: boolean;
  rcsDamp: boolean;
  throttleIdx: number;
  fineAttitude: boolean;
  progradeHold: boolean;
  camFollowAttitude: boolean;
  roundsInMag: number; // 給弾中マガジンの残弾
  magsLeft: number; // ベルトの未使用マガジン数
  reloadTimer: number; // リロード(バレル交換)中の残り時間
  alt: number;
  altDescending: boolean;
  spd: number;
  apAlt: number;
  peAlt: number;
  incDeg: number;
  period: number;
  qdyn: number; // 動圧 [Pa]
  hullTemp: number; // 機体表面温度 [K]
  shots: number;
  kills: number;
  total: number;
}

interface TargetData {
  name: string;
  dist: number;
  closing: number; // 接近速度 [m/s] (正 = 近づいている)
  relSpeed: number;
  hp: number;
  maxHp: number;
  apAlt: number;
  peAlt: number;
  incDeg: number;
  period: number;
  relIncDeg: number; // 自機軌道面との相対傾斜角 [deg]
}

export class HudPanels {
  private hudTimer = 0;
  private listTimer = 0;

  constructor(private readonly els: Map<string, HTMLElement>) {}

  // 毎フレーム呼ぶ。スタッツ/ターゲット/敵一覧パネルの表示を、内部間隔ごとに更新する。
  update(game: Game, dt: number): void {
    const player = game.player;
    const tgt = game.targeter.autoTarget;
    const playerEl = player.elements;
    const tgtEl = tgt ? tgt.elements : null;

    // スタッツパネルを一定間隔で更新
    this.hudTimer -= dt;
    if (this.hudTimer <= 0) {
      this.hudTimer = 0.1;
      const thermal = player.thermal;
      this.setStats({
        met: game.simulator.simTime,
        simSpeedLabel: `×${game.simSpeedManager.simSpeed}`,
        paused: game.isPaused,
        rcsDamp: player.rcsDamp,
        throttleIdx: player.throttleIdx,
        fineAttitude: player.fineAttitude,
        progradeHold: player.progradeHold,
        camFollowAttitude: game.cameraSystem.chaseCamera.camFollowAttitude,
        roundsInMag: player.roundsInMag,
        magsLeft: player.magsLeft,
        reloadTimer: player.reloadTimer,
        alt: altitudeOf(player.state.r),
        altDescending: thermal.altDescendWarned,
        spd: len(player.state.v),
        apAlt: playerEl ? playerEl.apAlt : NaN,
        peAlt: playerEl ? playerEl.peAlt : NaN,
        incDeg: playerEl ? playerEl.incDeg : NaN,
        period: playerEl ? playerEl.period : NaN,
        qdyn: thermal.qdyn,
        hullTemp: thermal.hullTemp,
        shots: game.activeStage.scoreCounter.shots,
        kills: game.activeStage.scoreCounter.kills,
        total: game.activeStage.scoreCounter.totalEnemiesSpawned,
      });

      if (tgt) {
        const relP = sub(tgt.state.r, player.state.r);
        const relV = sub(tgt.state.v, player.state.v);
        const dist = len(relP);
        // 自機軌道面とターゲット軌道面のなす角
        const relIncDeg =
          playerEl && tgtEl
            ? (Math.acos(Math.max(-1, Math.min(1, dot(playerEl.hHat, tgtEl.hHat)))) * 180) / Math.PI
            : NaN;
        this.setTarget({
          name: tgt.name,
          dist,
          closing: dist > 1e-6 ? -dot(relP, relV) / dist : 0,
          relSpeed: len(relV),
          hp: tgt.hp,
          maxHp: tgt.maxHp,
          apAlt: tgtEl ? tgtEl.apAlt : NaN,
          peAlt: tgtEl ? tgtEl.peAlt : NaN,
          incDeg: tgtEl ? tgtEl.incDeg : NaN,
          period: tgtEl ? tgtEl.period : NaN,
          relIncDeg,
        });
      } else {
        this.setTarget(null);
      }
    }

    // 敵一覧パネルはさらに緩い間隔で更新
    this.listTimer -= dt;
    if (this.listTimer <= 0) {
      this.listTimer = 0.25;
      const rows = game.entities.enemies
        .filter((e) => e.alive)
        .map((e) => ({
          name: e.name,
          dist: len(sub(e.state.r, player.state.r)),
          targeted: e === tgt,
        }))
        .sort((a, b) => a.dist - b.dist);
      this.setEnemyList(rows);
    }
  }

  // id 要素のテキストを、変化があるときだけ書き換える
  private setText(id: string, text: string): void {
    const e = this.els.get(id);
    if (e && e.textContent !== text) e.textContent = text;
  }

  // スタッツパネル各項目のテキストと警告表示を書き換える
  private setStats(d: StatsData): void {
    this.setText('met', `T+ ${fmtTime(d.met)}`);
    const simSpeedEl = this.els.get('sim-speed');
    if (simSpeedEl) {
      simSpeedEl.textContent = d.paused ? 'PAUSE' : d.simSpeedLabel;
      simSpeedEl.classList.toggle('sim-speed-hot', d.simSpeedLabel !== '×1' || d.paused);
    }

    this.setText('rcs', d.rcsDamp ? 'ON' : 'OFF');
    const throttleLabels = ['弱', '中', '強'];
    this.setText(
      'throttle',
      `${throttleLabels[d.throttleIdx]} (${C.THROTTLE_LEVELS[d.throttleIdx]!.toFixed(1)} m/s²)`,
    );
    const fineEl = this.els.get('fine');
    if (fineEl) {
      fineEl.textContent = d.fineAttitude ? 'ON' : 'OFF';
      fineEl.classList.toggle('mode-tgt', d.fineAttitude);
    }
    const camfollowEl = this.els.get('camfollow');
    if (camfollowEl) {
      camfollowEl.textContent = d.camFollowAttitude ? 'ON' : 'OFF';
      camfollowEl.classList.toggle('mode-tgt', d.camFollowAttitude);
    }
    const proholdEl = this.els.get('prohold');
    if (proholdEl) {
      proholdEl.textContent = d.progradeHold ? 'ON' : 'OFF';
      proholdEl.classList.toggle('mode-tgt', d.progradeHold);
    }
    // 残弾/リロード中の表示
    const ammoEl = this.els.get('ammo');
    if (ammoEl) {
      if (d.reloadTimer > 0) {
        ammoEl.textContent = 'RELOADING...';
        ammoEl.classList.add('warn-hot');
      } else {
        ammoEl.textContent =
          d.roundsInMag <= 0 && d.magsLeft <= 0
            ? '弾切れ'
            : `${d.roundsInMag}/${C.MAG_ROUNDS} +${d.magsLeft}連`;
        ammoEl.classList.toggle('warn-hot', d.magsLeft < 4);
      }
    }
    this.setText('alt', fmtDist(d.alt));
    const altEl = this.els.get('alt');
    if (altEl) altEl.classList.toggle('warn-hot', d.altDescending);
    this.setText('spd', fmtSpeed(d.spd));
    this.setText('ap', fmtDist(d.apAlt));
    this.setText('pe', fmtDist(d.peAlt));
    this.setText('inc', `${d.incDeg.toFixed(2)}°`);
    this.setText('prd', fmtTime(d.period));
    // 動圧・機体温度は閾値超過で警告表示にする
    const qEl = this.els.get('qdyn');
    if (qEl) {
      qEl.textContent = d.qdyn >= 10 ? `${(d.qdyn / 1000).toFixed(2)} kPa` : '0.00 kPa';
      qEl.classList.toggle('warn-hot', d.qdyn > 0.5 * C.MAX_DYN_PRESSURE);
    }
    const tEl = this.els.get('temp');
    if (tEl) {
      tEl.textContent = `${d.hullTemp.toFixed(0)} K`;
      tEl.classList.toggle('warn-hot', d.hullTemp > 0.7 * C.MAX_HULL_TEMP);
    }
    this.setText('count', `${d.total - d.kills}/${d.total}`);
  }

  // ターゲットパネルの本文を書き換える。t が null ならプレースホルダ表示にする。
  private setTarget(t: TargetData | null): void {
    const body = this.els.get('tgtbody');
    if (!body) return;
    const title = this.els.get('tgtname');
    if (!t) {
      if (title) title.textContent = 'TARGET';
      body.innerHTML = `<div style="color:${INK_SOFT}">ターゲットなし</div>`;
      return;
    }
    if (title) title.textContent = t.name;
    // 距離・速度・軌道要素・相対傾斜角を一覧表示
    body.innerHTML = `
      <div class="row"><span class="k">距離</span><span class="v">${fmtDist(t.dist)}</span></div>
      <div class="row"><span class="k">接近速度</span><span class="v">${fmtSpeed(t.closing)}</span></div>
      <div class="row"><span class="k">相対速度</span><span class="v">${fmtSpeed(t.relSpeed)}</span></div>
      <div class="row"><span class="k">磁気装甲</span><span class="v">${Math.floor(t.hp)} / ${t.maxHp} <div style="display:inline-block; width:100px; height:8px; background:#222; vertical-align:middle; margin-left:4px;"><div style="width:${Math.max(0, Math.min(100, (t.hp / t.maxHp) * 100))}%; height:100%; background:${t.hp <= t.maxHp * 0.3 ? '#ff4a3d' : '#ff6a00'}; transition:width 0.2s;"></div></div></span></div>
      <div class="row"><span class="k">遠地点 AP</span><span class="v">${fmtDist(t.apAlt)}</span></div>
      <div class="row"><span class="k">近地点 PE</span><span class="v">${fmtDist(t.peAlt)}</span></div>
      <div class="row"><span class="k">傾斜角 INC</span><span class="v">${isFinite(t.incDeg) ? t.incDeg.toFixed(2) + '°' : '---'}</span></div>
      <div class="row"><span class="k">周期 PRD</span><span class="v">${fmtTime(t.period)}</span></div>
      <div class="row"><span class="k">相対傾斜 [AN/DN]</span><span class="v">${isFinite(t.relIncDeg) ? t.relIncDeg.toFixed(2) + '°' : '---'}</span></div>`;
  }

  // 敵一覧パネルの本文を、距離順の行として書き換える
  private setEnemyList(rows: { name: string; dist: number; targeted: boolean }[]): void {
    const list = this.els.get('elist');
    if (!list) return;
    // 残存する敵がいなければプレースホルダ表示にする
    if (rows.length === 0) {
      list.innerHTML = `<div style="color:${INK_SOFT}">残存目標なし</div>`;
      return;
    }
    list.innerHTML = rows
      .map(
        (r) =>
          `<div class="erow${r.targeted ? ' tgt' : ''}"><span>${r.targeted ? '▶ ' : ''}${r.name}</span><span>${fmtDist(r.dist)}</span></div>`,
      )
      .join('');
  }
}
