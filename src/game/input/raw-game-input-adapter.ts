import type { Input } from '../../input/input';
import type { KeyBinding } from '../../input/key-mapping';
import type { RawGameInputAdapter } from './game-input-router';

function keyBindingOf(binding: { readonly code: string; readonly altCodes?: readonly string[] }): KeyBinding {
  return { ...binding, label: binding.code };
}

// ゲーム層の入力インターフェースへ生入力を適合・中継する adapter。
export function rawGameInputAdapter(input: Input): RawGameInputAdapter {
  return {
    isDown: binding => input.down(keyBindingOf(binding)),
    takePressed: binding => input.takeKey(keyBindingOf(binding)),
    takePressedCodes: handler => input.takeKeys(handler),
  };
}
