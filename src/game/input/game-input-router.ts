import type { ContinuousGameAction, GameInputBinding } from './game-actions';
import type { GameCommand } from './game-commands';

/**
 * Input の生データをゲーム側へ渡す narrow port。
 *
 * 実装は後続移行時に Input を保持する adapter が担う。`takePressed` の消費単位や
 * `isDown` の押下判定は既存 Input の意味をそのまま委譲し、この契約では変更しない。
 */
export interface RawGameInputAdapter {
  isDown(binding: GameInputBinding): boolean;
  takePressed(binding: GameInputBinding): boolean;
}

/**
 * 1つのゲーム機能が入力を受け取る境界。
 *
 * router の配列に入れた順番が優先順位になる。`isEnabled` が false のポートは入力を
 * 消費せず、次の優先順位のポートが同じ入力を処理できる。
 */
export interface GameInputPort {
  readonly feature: string;
  readonly isEnabled?: () => boolean;
  readonly actions?: readonly ContinuousGameAction[];
  readonly commands?: readonly GameCommand[];
  readonly handleAction?: (action: ContinuousGameAction) => void;
  readonly handleCommand?: (command: GameCommand) => void;
}

/**
 * raw input を feature-specific port へ優先順位付きで配分する。
 *
 * このクラスは raw input の取得方法を知らず、ゲーム機能の状態も所有しない。連続操作は
 * 同一の物理キーを同じフレームに複数ポートへ渡さず、コマンドは raw adapter の押下エッジ
 * を成功した最初のポートだけへ渡す。
 */
export class GameInputRouter {
  private readonly ports: readonly GameInputPort[];

  constructor(private readonly input: RawGameInputAdapter, ports: readonly GameInputPort[]) {
    this.ports = [...ports];
  }

  /** 登録順のポートへ連続操作と押下エッジを配分する。 */
  route(): void {
    const enabledPorts = this.ports.filter((port) => port.isEnabled?.() ?? true);
    this.routeActions(enabledPorts);
    this.routeCommands(enabledPorts);
  }

  private routeActions(ports: readonly GameInputPort[]): void {
    const claimedCodes = new Set<string>();
    for (const port of ports) {
      if (!port.handleAction) continue;
      for (const action of port.actions ?? []) {
        if (bindingOverlapsCodes(action.binding, claimedCodes)) continue;
        if (!this.input.isDown(action.binding)) continue;
        port.handleAction(action);
        addBindingCodes(action.binding, claimedCodes);
      }
    }
  }

  private routeCommands(ports: readonly GameInputPort[]): void {
    const consumedCodes = new Set<string>();
    for (const port of ports) {
      if (!port.handleCommand) continue;
      for (const command of port.commands ?? []) {
        if (bindingOverlapsCodes(command.binding, consumedCodes)) continue;
        if (!this.input.takePressed(command.binding)) continue;
        port.handleCommand(command);
        addBindingCodes(command.binding, consumedCodes);
      }
    }
  }
}

function bindingCodes(binding: GameInputBinding): readonly string[] {
  return [binding.code, ...(binding.altCodes ?? [])];
}

function bindingOverlapsCodes(binding: GameInputBinding, codes: ReadonlySet<string>): boolean {
  return bindingCodes(binding).some((code) => codes.has(code));
}

function addBindingCodes(binding: GameInputBinding, codes: Set<string>): void {
  for (const code of bindingCodes(binding)) codes.add(code);
}
