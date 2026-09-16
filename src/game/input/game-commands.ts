import type { GameInputBinding } from './game-actions';

/** 押下エッジを1回だけ処理するゲームコマンド。 */
export interface GameCommand {
  readonly kind: 'command';
  readonly id: string;
  readonly binding: GameInputBinding;
}

/** コマンド定義の kind を各配線箇所で繰り返さないための生成関数。 */
export function gameCommand(id: string, binding: GameInputBinding): GameCommand {
  return { kind: 'command', id, binding };
}
