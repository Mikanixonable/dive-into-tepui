// 自艦の搭載部品のプロパティウィンドウ。部品1つにつき高々1枚を保ち、展開できる部品の
// 展開/収納を実行する。排他グループを持たせず、被選択物のウィンドウと共存させる。
import { PropertyWindow, type PropertyWindowContent, type PropertyWindowItem } from '../hud/windows/property-window';
import type { MenuAction } from '../hud/windows/menu-actions';
import type { ActivePlayerController } from '../active-controllable-controller';
import type { Hud } from '../hud/hud';
import type { Part } from '../dynamic/dynamic-entity/parts';
import type { Player } from '../player/player';

interface PartWindowEntry {
  readonly win: PropertyWindow<MenuAction>;
  readonly ship: Player;
  readonly part: Part;
}

// 部品の損耗度の表記。最大 HP を持たない部品は完全に損耗した扱いにする。
function wearText(part: Part): string {
  const wear = part.maxHp > 0 ? Math.max(0, Math.min(1, 1 - part.hp / part.maxHp)) : 1;
  return `${(wear * 100).toFixed(1)}% (${Math.floor(part.hp)} / ${part.maxHp})`;
}

// 展開・収納を選べる部品にだけ操作項目を出す。
function deploymentItems(part: Part): PropertyWindowItem<MenuAction>[] {
  if (part.type !== 'radiator' && part.type !== 'solar_panel') return [];
  return [
    { label: '展開', act: 'deployPart', keepOpen: true },
    { label: '収納', act: 'stowPart', keepOpen: true },
  ];
}

// 同じ種別の中で何番目かで、上下どちらの側を動かすかが決まる。
function setDeployment(ship: Player, part: Part, deployed: boolean): void {
  const sameType = ship.parts.filter((candidate) => candidate.type === part.type);
  const side = sameType.indexOf(part) === 0 ? 'up' : 'down';
  if (part.type === 'radiator') ship.radiator.setDeployed(side, deployed);
  if (part.type === 'solar_panel') ship.power.setDeployed(side, deployed);
}

export class PartWindows {
  private readonly windows = new Map<string, PartWindowEntry>();

  constructor(
    private readonly hud: Hud,
    private readonly activePlayers: ActivePlayerController,
  ) {}

  // 部品のウィンドウを開く。既に開いていればクリック位置へ動かして最前面に出すだけにする。
  open(ship: Player, part: Part, clientX: number, clientY: number): void {
    const key = `${ship.id}:${part.id}`;
    const existing = this.windows.get(key);
    if (existing) {
      existing.win.moveTo(clientX, clientY);
      existing.win.bringToFront();
      return;
    }
    const win = new PropertyWindow<MenuAction>(
      this.hud.layers.window, clientX, clientY, this.content(ship, part), this.hud.overlayManager,
    );
    this.windows.set(key, { win, ship, part });
    win.onSelect = (act) => {
      if (ship.parts.includes(part)) setDeployment(ship, part, act === 'deployPart');
    };
    win.onClose = () => { this.windows.delete(key); };
  }

  // その艦の部品ウィンドウをすべて畳む。
  closeFor(shipId: string): void {
    for (const entry of [...this.windows.values()]) {
      if (entry.ship.id === shipId) entry.win.close();
    }
  }

  // 開いている各ウィンドウの値を最新化する。操作対象から外れた艦・失われた部品は閉じる。
  sync(): void {
    for (const entry of [...this.windows.values()]) {
      const { ship, part } = entry;
      if (!ship.alive || ship !== this.activePlayers.current || !ship.parts.includes(part)) {
        entry.win.close();
        continue;
      }
      entry.win.syncHeader(part.name, `取り付け艦: ${ship.name}`);
      entry.win.syncRows(this.content(ship, part).rows);
      entry.win.syncItems(deploymentItems(part));
    }
  }

  // 開いているウィンドウをすべて畳む。
  close(): void {
    for (const entry of [...this.windows.values()]) entry.win.close();
  }

  // ウィンドウ1枚ぶんの見出し・行・操作項目。
  private content(ship: Player, part: Part): PropertyWindowContent<MenuAction> {
    return {
      title: part.name,
      subtitle: `取り付け艦: ${ship.name}`,
      rows: [
        { key: 'name', label: '部品名', value: part.name },
        { key: 'ship', label: '取り付け艦', value: ship.name },
        { key: 'wear', label: '損耗度', value: wearText(part) },
      ],
      items: deploymentItems(part),
    };
  }
}
