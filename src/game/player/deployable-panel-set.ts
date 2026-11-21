// 展開式パネル(太陽電池パドル・ラジエーター)の状態を、搭載 module の ID へ結び付ける集合。
// 互換スロット(up/down)から module ID への移譲と、直列化・復元の形を両系統で共有する。
import type { ShipAssembly } from '../ship/ship-assembly';
import type { ShipModuleKind } from '../ship/ship-module-definition';
import { DeployablePanelState, type SerializedDeployablePanelState } from './deployable-panel-state';

// 互換スロット名。assembly を持たない旧式は上下2面固定だったため、その名残を id として使う。
export type DeployablePanelSide = 'up' | 'down';

export interface SerializedDeployablePanelEntry {
  readonly id: string;
  readonly state: SerializedDeployablePanelState;
}

// 直列化の共通部分。各系統はこれに自身の項(蓄電量など)を足す。
export interface SerializedDeployablePanelSet {
  readonly up: SerializedDeployablePanelState;
  readonly down: SerializedDeployablePanelState;
  readonly panels: readonly SerializedDeployablePanelEntry[] | null;
}

export interface RestoredDeployablePanel {
  readonly id: string;
  readonly state: DeployablePanelState;
}

export class DeployablePanelSet implements Iterable<[string, DeployablePanelState]> {
  private readonly panels = new Map<string, DeployablePanelState>();
  private assemblyValue: ShipAssembly | null;

  public constructor(
    private readonly moduleKind: ShipModuleKind,
    private readonly initialTarget: 0 | 1,
    up = new DeployablePanelState(initialTarget, initialTarget),
    down = new DeployablePanelState(initialTarget, initialTarget),
    assembly: ShipAssembly | null = null,
    restoredPanels: readonly RestoredDeployablePanel[] = [],
  ) {
    this.panels.set('up', up);
    this.panels.set('down', down);
    for (const panel of restoredPanels) {
      if (panel.id.length > 0) this.panels.set(panel.id, panel.state);
    }
    this.assemblyValue = assembly;
  }

  public get assembly(): ShipAssembly | null { return this.assemblyValue; }

  // 直列化した up/down と module ID 連動の panels を復元する部品を返す。壊れた項は fallbackTarget の初期値へ。
  public static deserialize(
    serialized: SerializedDeployablePanelSet,
    fallbackTarget: 0 | 1,
  ): { up: DeployablePanelState; down: DeployablePanelState; restoredPanels: RestoredDeployablePanel[] } {
    const up = DeployablePanelState.deserialize(serialized.up)
      ?? new DeployablePanelState(fallbackTarget, fallbackTarget);
    const down = DeployablePanelState.deserialize(serialized.down)
      ?? new DeployablePanelState(fallbackTarget, fallbackTarget);
    const restoredPanels: RestoredDeployablePanel[] = [];
    for (const panel of serialized.panels ?? []) {
      const state = DeployablePanelState.deserialize(panel.state);
      if (state !== null && panel.id.length > 0) restoredPanels.push({ id: panel.id, state });
    }
    return { up, down, restoredPanels };
  }

  // assembly の module ID へ状態を結び付ける。互換スロット名(up/down)は接続順へ移譲する。
  public syncAssembly(assembly: ShipAssembly | null = this.assemblyValue): void {
    if (assembly === null) return;
    this.assemblyValue = assembly;
    const old = new Map(this.panels);
    const modules = assembly.modules.filter(module => module.kind === this.moduleKind);
    const next = new Map<string, DeployablePanelState>();
    for (const [index, module] of modules.entries()) {
      const legacy = index === 0 ? old.get('up') : index === 1 ? old.get('down') : undefined;
      const deployed = 'deployed' in module && typeof module.deployed === 'number' ? module.deployed : this.initialTarget;
      const state = old.get(module.id) ?? legacy
        ?? new DeployablePanelState(deployed >= 0.5 ? 1 : 0, deployed);
      next.set(module.id, state);
    }
    this.panels.clear();
    for (const [id, state] of next) this.panels.set(id, state);
  }

  // sideOrId は module ID か互換スロット名(up/down)。該当するパネルのキーを返す。
  public key(sideOrId: string): string | null {
    if (this.panels.has(sideOrId)) return sideOrId;
    if (this.assemblyValue === null) return null;
    const modules = this.assemblyValue.modules.filter(module => module.kind === this.moduleKind);
    const index = sideOrId === 'up' ? 0 : sideOrId === 'down' ? 1 : -1;
    return index >= 0 ? modules[index]?.id ?? null : null;
  }

  public toggle(sideOrId: string): void {
    const key = this.key(sideOrId);
    if (key !== null) this.panels.get(key)?.toggle();
  }

  public setDeployed(sideOrId: string, deployed: boolean): void {
    const key = this.key(sideOrId);
    if (key !== null) this.panels.get(key)?.setTarget(deployed);
  }

  // パネルを1枚でも積んでいるか。deployOf と同じ結び付けで判定する。
  public hasPanels(): boolean {
    return this.key('up') !== null || this.key('down') !== null;
  }

  // side にパネルを積んでいるか。deployOf と同じ結び付けで判定する。
  public hasPanel(side: DeployablePanelSide): boolean {
    return this.key(side) !== null;
  }

  public deployOf(sideOrId: string): number {
    const key = this.key(sideOrId);
    return key === null ? 0 : this.panels.get(key)?.value ?? 0;
  }

  public get(key: string): DeployablePanelState | undefined { return this.panels.get(key); }
  public values(): IterableIterator<DeployablePanelState> { return this.panels.values(); }
  public [Symbol.iterator](): IterableIterator<[string, DeployablePanelState]> { return this.panels.entries(); }

  public serializeSet(): SerializedDeployablePanelSet {
    const fresh = () => new DeployablePanelState(this.initialTarget, this.initialTarget);
    const up = this.panels.get('up') ?? fresh();
    const down = this.panels.get('down') ?? fresh();
    const panels = [...this.panels]
      .filter(([id]) => id !== 'up' && id !== 'down')
      .map(([id, state]) => ({ id, state: state.serialize() }));
    return {
      up: up.serialize(),
      down: down.serialize(),
      panels: panels.length === 0 ? null : panels,
    };
  }
}
