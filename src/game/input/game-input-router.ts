import type { ContinuousGameAction, GameInputBinding } from './game-actions';
import type { GameCommand } from './game-commands';

export interface GameInputMode {
  readonly camera: boolean;
  readonly construction: boolean;
  readonly world: boolean;
  readonly simulation: boolean;
}

// モーダル、建造、一時停止の優先順位を1箇所へ固定する。建造中は視点と建造操作だけを通す。
export function gameInputMode(paused: boolean, inputGated: boolean, constructionActive: boolean): GameInputMode {
  return {
    camera: !inputGated,
    construction: !inputGated && constructionActive,
    world: !inputGated && !paused && !constructionActive,
    simulation: !paused && !constructionActive,
  };
}

/**
 * Input の生データをゲーム側へ渡す narrow port。
 *
 * 実装は後続移行時に Input を保持する adapter が担う。`takePressed` / `takePressedCodes` の消費単位や
 * `isDown` の押下判定は既存 Input の意味をそのまま委譲し、この契約では変更しない。
 */
export interface RawGameInputAdapter {
  isDown(binding: GameInputBinding): boolean;
  takePressed(binding: GameInputBinding): boolean;
  takePressedCodes(handler: (code: string) => boolean): void;
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
  readonly handlePressed?: (code: string) => boolean;
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
  private readonly claimedActionCodes = new Set<string>();
  private readonly claimedCommandCodes = new Set<string>();

  public constructor(private readonly input: RawGameInputAdapter, ports: readonly GameInputPort[]) {
    this.ports = [...ports];
  }

  /** 登録順のポートへ連続操作と押下エッジを配分する。 */
  public route(): void {
    this.routeAdditional(this.ports);
  }

  /** 同じフレームの残りの優先順位へ入力を配分する。外部のライフサイクル層が使う。 */
  public routeAdditional(ports: readonly GameInputPort[]): void {
    const enabledPorts = ports.filter((port) => port.isEnabled?.() ?? true);
    this.routeActions(enabledPorts);
    this.routeCommands(enabledPorts);
  }

  /** フレーム開始時に連続操作の競合記録を破棄する。edge は raw adapter が管理する。 */
  public beginFrame(): void {
    this.claimedActionCodes.clear();
    this.claimedCommandCodes.clear();
  }

  private routeActions(ports: readonly GameInputPort[]): void {
    for (const port of ports) {
      if (!port.handleAction) continue;
      for (const action of port.actions ?? []) {
        if (bindingOverlapsCodes(action.binding, this.claimedActionCodes)) continue;
        if (!this.input.isDown(action.binding)) continue;
        port.handleAction(action);
        addBindingCodes(action.binding, this.claimedActionCodes);
      }
    }
  }

  private routeCommands(ports: readonly GameInputPort[]): void {
    for (const port of ports) {
      if (port.handlePressed) {
        const handlePressed = port.handlePressed;
        this.input.takePressedCodes((code) => handlePressed(code));
      }
      if (!port.handleCommand) continue;
      for (const command of port.commands ?? []) {
        if (bindingOverlapsCodes(command.binding, this.claimedCommandCodes)) continue;
        if (!this.input.takePressed(command.binding)) continue;
        port.handleCommand(command);
        addBindingCodes(command.binding, this.claimedCommandCodes);
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
