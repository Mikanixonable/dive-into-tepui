// HUD ステータスパネル(スタッツ・ターゲット情報・敵一覧)の同期。
import * as C from '../const';
import { ACCENT, ACCENT_SECONDARY, BAR_BG, BG, DANGER, FONT_XS, SPACE_2, TEXT_DIM, TEXT_STRONG, TRANSITION_FAST } from '../theme';
import { Attractor } from '../../physics/attractor';
import { Vec3, len, sub } from '../../physics/vec3';
import type { Game } from '../game';
import type { Enemy } from '../game-entity/enemy';
import type { CombatTarget } from '../targeter';
import { SIM_EPOCH_SEC, fmtAmmoStatus, fmtDateTime, fmtDist, fmtSpeed, fmtTime } from './utils';
import { orbitInfo, relativeInfo } from './orbit-info';
import { formatMapScaleDistance, mapScaleFor } from './map-scale';

interface GlobalStatusData {
  simSpeedLabel: string;
  autoWarpSimRemain: number | null;
  autoWarpRealRemain: number | null;
  paused: boolean;
}

interface StatsData {
  rcsDamp: boolean;
  throttleIdx: number;
  fineAttitude: boolean;
  progradeHold: boolean;
  camFollowAttitude: boolean;
  roundsInMag: number; // 給弾中マガジンの残弾
  magsLeft: number; // ベルトの未使用マガジン数
  reloadTimer: number; // リロード(バレル交換)中の残り時間
  centerName: string; // 軌道要素の中心天体の表示名
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
  centerName: string; // 軌道要素の中心天体の表示名
  apAlt: number;
  peAlt: number;
  incDeg: number;
  period: number;
  relIncDeg: number; // 自機軌道面との相対傾斜角 [deg]
}

// パネル書き換えの間隔 [ms]。毎フレーム innerHTML を組み直すには重いので間引く。
const STATS_INTERVAL_MS = 100;
const ENEMY_LIST_INTERVAL_MS = 250;

type EnemyRow =
  | { kind: 'single'; name: string; dist: number; targeted: boolean; secondary: boolean }
  | { kind: 'wave'; waveId: number; count: number; dist: number; targeted: boolean; secondary: boolean };

export class HudPanels {
  private nextStatsAt = 0;
  private nextGlobalStatusAt = 0;
  private nextEnemyListAt = 0;

  constructor(private readonly els: Map<string, HTMLElement>) {}

  // 毎フレーム呼ぶ。スタッツ/ターゲット/敵一覧パネルの表示を、内部間隔ごとに更新する。
  sync(game: Game, attractors: readonly Attractor[]): void {
    const now = performance.now();
    this.syncMapScale(game);
    // グローバルステータス(時刻・時間加速・NODE WARP)は自機の有無に関係なく画面全体の
    // 状態なので、自機不在で以降の処理を抜ける早期 return より前に書く。
    this.setText('met', `${fmtDateTime(SIM_EPOCH_SEC + game.simulator.simTime)} / T+ ${fmtTime(game.simulator.simTime)}`);
    if (now >= this.nextGlobalStatusAt) {
      this.nextGlobalStatusAt = now + STATS_INTERVAL_MS;
      this.setGlobalStatus({
        simSpeedLabel: `×${game.simSpeedManager.simSpeed}`,
        autoWarpSimRemain: game.simSpeedManager.remainingSimulationSeconds(game.simulator.simTime),
        autoWarpRealRemain: game.simSpeedManager.estimatedRealSecondsToWarpEnd(game.simulator.simTime),
        paused: game.isPaused,
      });
    }
    const player = game.player;
    if (!player) {
      // 操作できる艦が1隻も無い間は、操縦/戦闘 HUD の値が存在しない。
      for (const id of ['hud-status', 'hud-orbit', 'hud-target', 'hud-enemies']) {
        document.getElementById(id)?.classList.add('hidden');
      }
      return;
    }
    // 未配置状態から最初の艦を置いたとき、操縦HUDを再び通常の同期へ戻す。
    if (!game.cameraSystem.overviewMode) {
      document.getElementById('hud-status')?.classList.remove('hidden');
    }
    // CONTACTS・ORBIT は戦闘ビュー専用。マップビューではプロパティウィンドウの「軌道」グループが代わる。
    for (const id of ['hud-orbit', 'hud-enemies']) {
      document.getElementById(id)?.classList.toggle('hidden', game.cameraSystem.overviewMode);
    }
    const tgt = game.targeter.aliveTarget;
    const secTgt = game.targeter.aliveSecondaryTarget;
    this.setTargetVisibility(tgt !== null);
    const player0 = orbitInfo(player, attractors);

    // スタッツパネルを一定間隔で更新
    if (now >= this.nextStatsAt) {
      this.nextStatsAt = now + STATS_INTERVAL_MS;
      const thermal = player.thermal;
      this.setStats({
        rcsDamp: player.rcsDamp,
        throttleIdx: player.throttleIdx,
        fineAttitude: player.fineAttitude,
        progradeHold: player.progradeHold,
        camFollowAttitude: game.cameraSystem.combatCamera.camFollowAttitude,
        roundsInMag: player.roundsInMag,
        magsLeft: player.magsLeft,
        reloadTimer: player.reloadTimer,
        ...player0,
        altDescending: thermal.altDescendWarned,
        qdyn: thermal.qdyn,
        hullTemp: thermal.hullTemp,
        shots: game.activeStage.scoreCounter.shots,
        kills: game.activeStage.scoreCounter.kills,
        total: game.activeStage.scoreCounter.totalEnemiesSpawned,
      });

      if (tgt) {
        const tgt0 = orbitInfo(tgt, attractors);
        const rel = relativeInfo(player, tgt, attractors);
        this.setTarget({
          name: tgt.name,
          hp: tgt.hp,
          maxHp: tgt.maxHp,
          centerName: tgt0.centerName,
          apAlt: tgt0.apAlt,
          peAlt: tgt0.peAlt,
          incDeg: tgt0.incDeg,
          period: tgt0.period,
          ...rel,
        });
      } else {
        this.setTarget(null);
      }
    }

    // 敵一覧パネルはさらに緩い間隔で更新
    if (now >= this.nextEnemyListAt) {
      this.nextEnemyListAt = now + ENEMY_LIST_INTERVAL_MS;
      this.setEnemyList(this.buildEnemyRows(game.entities.enemies.filter((e) => e.alive), player.state.r, tgt, secTgt));
    }
  }

  // マップ視点の縮尺は、カメラから画面中心までではなく、現在フォーカスしている対象の
  // 深度における meters-per-pixel から求める。パンしてもフォーカス対象を基準にするため、
  // 同じ天体を見続ける限り、表示値はスクロールズームだけに対応して変化する。
  private syncMapScale(game: Game): void {
    const panel = this.els.get('map-scale');
    if (!panel) return;
    const overview = game.cameraSystem.overviewMode;
    panel.style.display = overview ? '' : 'none';
    if (!overview) return;

    const focus = game.cameraSystem.overviewCamera.resolvedFocus;
    const metersPerPixel = game.cameraSystem.activeCameraScale(focus);
    const scale = mapScaleFor(metersPerPixel);
    const ruler = this.els.get('map-scale-ruler');
    if (!scale || !ruler) {
      panel.style.display = 'none';
      return;
    }
    this.setText('map-scale-value', formatMapScaleDistance(scale.distanceM));
    ruler.style.width = `${scale.widthPx.toFixed(2)}px`;
    ruler.setAttribute('aria-label', `${formatMapScaleDistance(scale.distanceM)} の縮尺`);
  }

  // id 要素のテキストを、変化があるときだけ書き換える
  private setText(id: string, text: string): void {
    const e = this.els.get(id);
    if (e && e.textContent !== text) e.textContent = text;
  }

  // グローバルステータスバーの時間加速/NODE WARP 表示を書き換える
  private setGlobalStatus(d: GlobalStatusData): void {
    const simSpeedEl = this.els.get('sim-speed');
    if (simSpeedEl) {
      // 自動ワープ中は現在のワープ段の右に残り実時間を添える。停止中はワープ段より PAUSE を優先する。
      const warpRemain = d.autoWarpRealRemain !== null ? ` (残り ${fmtTime(d.autoWarpRealRemain)})` : '';
      simSpeedEl.textContent = d.paused ? 'PAUSE' : `${d.simSpeedLabel}${warpRemain}`;
      simSpeedEl.classList.toggle('sim-speed-hot', d.simSpeedLabel !== '×1' || d.paused);
    }
    const nodeWarpEl = this.els.get('node-warp-remain');
    if (nodeWarpEl) {
      nodeWarpEl.textContent = d.autoWarpSimRemain === null ? '—' : fmtTime(d.autoWarpSimRemain);
      nodeWarpEl.classList.toggle('sim-speed-hot', d.autoWarpSimRemain !== null);
    }
  }

  // スタッツパネル各項目のテキストと警告表示を書き換える
  private setStats(d: StatsData): void {
    this.setText('rcs', d.rcsDamp ? 'ON' : 'OFF');
    this.setText(
      'throttle',
      `${C.THROTTLE_LABELS[d.throttleIdx]} (${C.THROTTLE_LEVELS[d.throttleIdx]!.toFixed(1)} m/s²)`,
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
      ammoEl.textContent = fmtAmmoStatus(d.roundsInMag, d.magsLeft, d.reloadTimer);
      ammoEl.classList.toggle('warn-hot', d.reloadTimer > 0 || d.magsLeft < 4);
    }
    this.setText('center', d.centerName);
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
      body.innerHTML = `<div style="color:${TEXT_DIM}">ターゲットなし</div>`;
      return;
    }
    if (title) title.textContent = t.name;
    // 距離・速度・軌道要素・相対傾斜角を一覧表示
    body.innerHTML = `
      <div class="row"><span class="k">距離</span><span class="v">${fmtDist(t.dist)}</span></div>
      <div class="row"><span class="k">接近速度</span><span class="v">${fmtSpeed(t.closing)}</span></div>
      <div class="row"><span class="k">相対速度</span><span class="v">${fmtSpeed(t.relSpeed)}</span></div>
      <div class="row"><span class="k">装甲</span><span class="v"><div style="display:inline-block; position:relative; width:120px; height:12px; background:${BAR_BG}; vertical-align:middle; margin-left:${SPACE_2};"><div style="width:${Math.max(0, Math.min(100, (t.hp / t.maxHp) * 100))}%; height:100%; background:${t.hp <= t.maxHp * 0.3 ? DANGER : ACCENT}; transition:width ${TRANSITION_FAST};"></div><div style="position:absolute; right:4px; top:0; bottom:0; display:flex; align-items:center; font-size:${FONT_XS}; color:${TEXT_STRONG}; text-shadow:0 0 2px ${BG}, 0 0 2px ${BG};">${Math.floor(t.hp)} / ${t.maxHp}</div></div></span></div>
      <div class="row"><span class="k">基準天体</span><span class="v">${t.centerName}</span></div>
      <div class="row"><span class="k">遠地点 AP</span><span class="v">${fmtDist(t.apAlt)}</span></div>
      <div class="row"><span class="k">近地点 PE</span><span class="v">${fmtDist(t.peAlt)}</span></div>
      <div class="row"><span class="k">傾斜角 INC</span><span class="v">${isFinite(t.incDeg) ? t.incDeg.toFixed(2) + '°' : '---'}</span></div>
      <div class="row"><span class="k">周期 PRD</span><span class="v">${fmtTime(t.period)}</span></div>
      <div class="row"><span class="k">相対傾斜 [AN/DN]</span><span class="v">${isFinite(t.relIncDeg) ? t.relIncDeg.toFixed(2) + '°' : '---'}</span></div>`;
  }

  // ターゲットが無いときはパネル自体を隠し、空のTARGETウィンドウを残さない。
  private setTargetVisibility(visible: boolean): void {
    this.els.get('tgtbody')?.closest<HTMLElement>('#hud-target')?.classList.toggle('hidden', !visible);
  }

  // 敵一覧パネルの行データを、waveId を持つ敵ごとに「第N波」1行へ集約して組み立てる。
  // waveId 不在の敵は個別の行になる。ターゲット/第二ターゲットが波のメンバーなら、
  // その波の行を強調する側に倒す。
  private buildEnemyRows(
    enemies: readonly Enemy[],
    playerPos: Vec3,
    tgt: CombatTarget | null,
    secTgt: CombatTarget | null,
  ): EnemyRow[] {
    const singles: EnemyRow[] = [];
    const waves = new Map<number, { count: number; nearestDist: number; targeted: boolean; secondary: boolean }>();
    for (const e of enemies) {
      const dist = len(sub(e.state.r, playerPos));
      const targeted = e === tgt;
      const secondary = e === secTgt;
      if (e.waveId === undefined) {
        singles.push({ kind: 'single', name: e.name, dist, targeted, secondary });
        continue;
      }
      const w = waves.get(e.waveId);
      if (!w) {
        waves.set(e.waveId, { count: 1, nearestDist: dist, targeted, secondary });
      } else {
        // 波の代表距離は最も近い個体、強調表示は波内のいずれかがターゲットなら点灯させる
        w.count++;
        w.nearestDist = Math.min(w.nearestDist, dist);
        w.targeted = w.targeted || targeted;
        w.secondary = w.secondary || secondary;
      }
    }
    const waveRows: EnemyRow[] = Array.from(waves.entries()).map(([waveId, w]) => ({
      kind: 'wave',
      waveId,
      count: w.count,
      dist: w.nearestDist,
      targeted: w.targeted,
      secondary: w.secondary,
    }));
    return [...singles, ...waveRows].sort((a, b) => a.dist - b.dist);
  }

  // 敵一覧パネルの本文を、距離順の行として書き換える。第二ターゲットは第一と別に
  // シアンで強調する(CSS クラスでなくインライン色。この2色目は theme.ts の ACCENT_SECONDARY)。
  private setEnemyList(rows: EnemyRow[]): void {
    const list = this.els.get('elist');
    if (!list) return;
    // 残存する敵がいなければプレースホルダ表示にする
    if (rows.length === 0) {
      list.innerHTML = `<div style="color:${TEXT_DIM}">残存目標なし</div>`;
      return;
    }
    list.innerHTML = rows
      .map((r) => {
        // 1つの波に第一・第二ターゲットが混在しうる。インライン色は .tgt のクラス指定に勝つため、
        // 第一ターゲットを含む行は ▶ と同じ色に倒す。
        const style = r.secondary && !r.targeted ? ` style="color:${ACCENT_SECONDARY}"` : '';
        const mark = r.targeted ? '▶ ' : r.secondary ? '▷ ' : '';
        const label = r.kind === 'wave' ? `第${r.waveId}波 ×${r.count}` : r.name;
        return `<div class="erow${r.targeted ? ' tgt' : ''}"${style}><span>${mark}${label}</span><span>${fmtDist(r.dist)}</span></div>`;
      })
      .join('');
  }
}
