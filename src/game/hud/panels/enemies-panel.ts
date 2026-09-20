// 常設 CONTACTS パネル(#hud-enemies)の同期: コンタクト中の敵を距離順で示す。戦闘ビュー専用。
import { fmtDist } from '../../../hud/utils';
import { SyncThrottle } from '../sync-throttle';

const SYNC_INTERVAL_MS = 250;

// 生存している敵1機ぶんの、一覧に出す値。同じ波に属する敵は1行へ畳まれる。
export interface EnemyContact {
  readonly id: string;
  readonly name: string;
  readonly distanceM: number;
  // 波に属さない敵では null。
  readonly waveId: number | null;
  readonly targeted: boolean;
}

// CONTACTS パネルが1フレームに表示する値と、個別行の右クリック通知コールバック。
export interface EnemiesPanelViewModel {
  readonly remainingCount: number;
  readonly totalCount: number;
  readonly contacts: readonly EnemyContact[];
  onSelectRight(id: string, clientX: number, clientY: number): void;
}

// 一覧に出す1行。同じ波の敵は1行へ畳み、波に属さない敵はそれぞれ1行になる。
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
  private readonly throttle = new SyncThrottle(SYNC_INTERVAL_MS);
  private hasContacts = false;
  // 直近の sync で受け取った状態。右クリックはフレーム外で発生するため、現在のコールバックをここから取得する。
  private view: EnemiesPanelViewModel | null = null;

  public constructor(private readonly els: ReadonlyMap<string, HTMLElement>) {}

  // 残存数の見出しと、距離順の敵一覧を同期する。view が null(操作対象が無い)ならパネルごと隠す。
  public sync(view: EnemiesPanelViewModel | null, nowMs: number): void {
    this.view = view;
    const panel = this.els.get('hud-enemies');
    if (!view) {
      this.hasContacts = false;
      panel?.classList.add('hidden');
      return;
    }

    // 間引き周期でのみ一覧を組み直す。
    if (this.throttle.due(nowMs)) {
      const count = this.els.get('count');
      if (count) {
        count.textContent = `${view.remainingCount} / ${view.totalCount}`;
        count.setAttribute('aria-label', `残存 ${view.remainingCount}、合計 ${view.totalCount}`);
      }
      const rows = this.buildEnemyRows(view.contacts);
      this.hasContacts = rows.length > 0;
      this.syncEnemyList(rows);
    }

    // 更新間隔中も直前の敵有無を維持する。毎フレーム敵の有無を見ると、
    // 敵0件で隠したパネルを次のフレームに再表示してしまう。
    panel?.classList.toggle('hidden', !this.hasContacts);
  }

  // contacts を、波ごとの「第N波」1行と波に属さない敵の個別行へまとめ、距離順に並べる。
  // 波の行は、ターゲットが波のメンバーなら強調する。
  private buildEnemyRows(contacts: readonly EnemyContact[]): EnemyRow[] {
    const singles: EnemyRow[] = [];
    const waves = new Map<number, { count: number; nearestDistanceM: number; targeted: boolean }>();
    for (const { id, name, distanceM, waveId, targeted } of contacts) {
      if (waveId === null) {
        singles.push({ kind: 'single', id, name, distanceM, targeted });
        continue;
      }
      const waveSummary = waves.get(waveId);
      if (!waveSummary) {
        waves.set(waveId, { count: 1, nearestDistanceM: distanceM, targeted });
      } else {
        // 波の代表距離は最も近い個体の距離。
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

    // rows は距離順なので、固定ターゲットでない先頭行が最も近い(=隣接)行になる。
    const adjacentIndex = rows.findIndex((row) => !row.targeted);
    const items = rows.map((row, index) => {
      const isAdjacent = index === adjacentIndex;
      const role = row.targeted ? '固定' : isAdjacent ? '隣接' : '';
      const label = row.kind === 'wave' ? `第${row.waveId}波 ×${row.count}` : row.name;
      const distance = fmtDist(row.distanceM);

      // 行本体。固定/隣接の強調はクラスと aria-current で示す。
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
          this.view?.onSelectRight(row.id, e.clientX, e.clientY);
        });
      }

      // 名前・距離・役割ラベルの3スパン。
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
