// 常設 CONTACTS パネル(#hud-enemies)の同期: コンタクト中の敵を距離順で示す。戦闘ビュー専用。
import { len, sub } from '../../physics/vec3';
import { fmtDist } from './utils';
import type { Vec3 } from '../../physics/vec3';
import type { Enemy } from '../game-entity/enemy';
import type { CombatTarget } from '../targeter';
import type { Game } from '../game';

const SYNC_INTERVAL_MS = 250;

type EnemyRow =
  | {
    readonly kind: 'single';
    readonly id: string;
    readonly name: string;
    readonly distanceM: number;
    readonly targeted: boolean;
  }
  | {
    readonly kind: 'wave';
    readonly waveId: number;
    readonly count: number;
    readonly distanceM: number;
    readonly targeted: boolean;
  };

export class EnemiesPanel {
  private nextSyncAt = 0;
  private hasContacts = false;

  // 単独表示の行(波に集約されていない敵)の右クリック。波の集約行は特定の1機を指さないため呼ばれない。
  onSelectRight: ((id: string, clientX: number, clientY: number) => void) | null = null;

  public constructor(private readonly els: ReadonlyMap<string, HTMLElement>) {}

  public sync(game: Game): void {
    const player = game.player;
    const panel = document.getElementById('hud-enemies');
    if (!player) {
      this.hasContacts = false;
      panel?.classList.add('hidden');
      return;
    }

    const now = performance.now();
    if (now >= this.nextSyncAt) {
      this.nextSyncAt = now + SYNC_INTERVAL_MS;

      const { kills, totalEnemiesSpawned } = game.activeStage.scoreCounter;
      const remainingCount = totalEnemiesSpawned - kills;
      const count = this.els.get('count');
      if (count) {
        count.textContent = `${remainingCount} / ${totalEnemiesSpawned}`;
        count.setAttribute('aria-label', `残存 ${remainingCount}、合計 ${totalEnemiesSpawned}`);
      }
      const primaryTarget = game.targeter.aliveTarget;
      const rows = this.buildEnemyRows(
        game.entities.enemies.filter((enemy) => enemy.alive),
        player.state.r,
        primaryTarget,
      );
      this.hasContacts = rows.length > 0;
      this.syncEnemyList(rows);
    }

    // 更新間隔中も直前の敵有無を維持する。ここで戦闘ビュー判定だけを行うと、
    // 敵0件で隠したパネルを次のフレームに再表示してしまう。
    panel?.classList.toggle('hidden', game.cameraSystem.overviewMode || !this.hasContacts);
  }

  // waveId を持つ敵ごとに「第N波」1行へ集約して組み立てる。
  // waveId 不在の敵は個別の行になる。ターゲットが波のメンバーなら、その波の行を強調する側に倒す。
  private buildEnemyRows(
    enemies: readonly Enemy[],
    playerPositionEci: Vec3,
    primaryTarget: CombatTarget | null,
  ): EnemyRow[] {
    const singles: EnemyRow[] = [];
    const waves = new Map<number, { count: number; nearestDistanceM: number; targeted: boolean }>();
    for (const enemy of enemies) {
      const distanceM = len(sub(enemy.state.r, playerPositionEci));
      const targeted = enemy === primaryTarget;
      if (enemy.waveId === undefined) {
        singles.push({ kind: 'single', id: enemy.id, name: enemy.name, distanceM, targeted });
        continue;
      }
      const waveSummary = waves.get(enemy.waveId);
      if (!waveSummary) {
        waves.set(enemy.waveId, { count: 1, nearestDistanceM: distanceM, targeted });
      } else {
        // 波の代表距離は最も近い個体を使い、波内にターゲットがいれば強調する。
        waveSummary.count += 1;
        waveSummary.nearestDistanceM = Math.min(waveSummary.nearestDistanceM, distanceM);
        waveSummary.targeted = waveSummary.targeted || targeted;
      }
    }
    const waveRows: EnemyRow[] = Array.from(waves.entries()).map(([waveId, waveSummary]) => ({
      kind: 'wave',
      waveId,
      count: waveSummary.count,
      distanceM: waveSummary.nearestDistanceM,
      targeted: waveSummary.targeted,
    }));
    return [...singles, ...waveRows].sort((a, b) => a.distanceM - b.distanceM);
  }

  // 距離順のリストへ同期する。ターゲット・隣接は色と状態語で識別する。
  private syncEnemyList(rows: readonly EnemyRow[]): void {
    const list = this.els.get('elist');
    if (!list) return;
    if (rows.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'contact-empty';
      empty.textContent = '残存目標なし';
      list.replaceChildren(empty);
      return;
    }

    const adjacentIndex = rows.findIndex((row) => !row.targeted);
    const items = rows.map((row, index) => {
      const isAdjacent = index === adjacentIndex;
      const role = row.targeted ? '固定' : isAdjacent ? '隣接' : '';
      const label = row.kind === 'wave' ? `第${row.waveId}波 ×${row.count}` : row.name;
      const distance = fmtDist(row.distanceM);
      const item = document.createElement('li');
      item.className = [
        'contact-row',
        row.targeted ? 'primary' : '',
        isAdjacent ? 'near' : '',
      ].filter(Boolean).join(' ');
      if (row.targeted) item.setAttribute('aria-current', 'true');
      item.setAttribute('aria-label', [label, distance, role ? `${role}ターゲット` : '未選択'].join('、'));
      if (row.kind === 'single') {
        item.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          this.onSelectRight?.(row.id, e.clientX, e.clientY);
        });
      }

      const name = document.createElement('span');
      name.className = 'contact-name';
      name.textContent = label;
      const distanceValue = document.createElement('span');
      distanceValue.className = 'contact-distance';
      distanceValue.textContent = distance;
      const roleLabel = document.createElement('span');
      roleLabel.className = 'contact-role';
      roleLabel.textContent = role;
      roleLabel.setAttribute('aria-hidden', 'true');
      item.append(name, distanceValue, roleLabel);
      return item;
    });
    list.replaceChildren(...items);
  }
}
