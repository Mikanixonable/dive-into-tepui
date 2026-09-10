import type { GameInputBinding } from './game-actions';

/** 押下エッジを1回だけ処理するゲームコマンド。 */
export interface GameCommand {
  readonly kind: 'command';
  readonly id: string;
  readonly binding: GameInputBinding;
}
