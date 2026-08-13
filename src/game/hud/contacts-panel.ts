// 常設 CONTACTS パネル(#hud-enemies)の同期: 生存中の敵を距離順に一覧表示する。戦闘ビュー専用。
import { Vec3, len, sub } from '../../physics/vec3';
import type { Enemy } from '../game-entity/enemy';
import type { CombatTarget } from '../targeter';
import { fmtDist } from './utils';
import { ACCENT_SECONDARY, TEXT_DIM } from '../theme';
import type { Game } from '../game';

const SYNC_INTERVAL_MS = 250;

type EnemyRow =
  | { kind: 'single'; name: string; dist: number; targeted: boolean; secondary: boolean }
  | { kind: 'wave'; waveId: number; count: number; dist: number; targeted: boolean; secondary: boolean };

export class ContactsPanel {
  private nextSyncAt = 0;

  constructor(private readonly els: Map<string, HTMLElement>) {}

  sync(game: Game): void {
    const player = game.player;
    const el = document.getElementById('hud-enemies');
    if (!player) {
      el?.classList.add('hidden');
      return;
    }
    el?.classList.toggle('hidden', game.cameraSystem.overviewMode);

    const now = performance.now();
    if (now < this.nextSyncAt) return;
    this.nextSyncAt = now + SYNC_INTERVAL_MS;

    const { kills, totalEnemiesSpawned } = game.activeStage.scoreCounter;
    this.setText('count', `${totalEnemiesSpawned - kills}/${totalEnemiesSpawned}`);
    const tgt = game.targeter.aliveTarget;
    const secTgt = game.targeter.aliveSecondaryTarget;
    this.setEnemyList(this.buildEnemyRows(game.entities.enemies.filter((e) => e.alive), player.state.r, tgt, secTgt));
  }

  // id 要素のテキストを、変化があるときだけ書き換える。
  private setText(id: string, text: string): void {
    const e = this.els.get(id);
    if (e && e.textContent !== text) e.textContent = text;
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
