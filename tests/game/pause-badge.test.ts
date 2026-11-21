// ⚙バッジ(ESC メニューの代替操作ボタン)の回帰テスト。バッジの押下が物理 Esc と同じ
// 押下エッジとして入力ポートの表へ届くことと、表示可否が仮想パッドと同じ
// body.touch-ui-active の規則に従うことを固定する。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { Input } from '../../src/input-devices/input';
import { KEY_MAPPING as K } from '../../src/input-devices/key-mapping';
import { rawGameInputAdapter } from '../../src/game/input/raw-game-input-adapter';
import { SKELETON_STYLE } from '../../src/game/hud/style/skeleton-style';

// Input が購読する window / document の最小限の代役を globalThis へ置き、物理 Esc の
// keydown ハンドラを取り出せるようにする。restore で代役を外す。
function stubBrowserGlobals(): { pressPhysicalEscape: () => void; restore: () => void } {
  let keydown: ((e: KeyboardEvent) => void) | null = null;
  const fakeWindow = {
    addEventListener: (type: string, handler: (e: KeyboardEvent) => void) => {
      if (type === 'keydown') keydown = handler;
    },
  };
  const fakeDocument = { addEventListener: () => {}, hidden: false };
  const globals = globalThis as unknown as { window?: unknown; document?: unknown };
  const prevWindow = globals.window;
  const prevDocument = globals.document;
  globals.window = fakeWindow;
  globals.document = fakeDocument;
  return {
    pressPhysicalEscape: () => keydown?.({
      code: K.pauseMenu.code, repeat: false, preventDefault: () => {},
    } as KeyboardEvent),
    restore: () => {
      globals.window = prevWindow;
      globals.document = prevDocument;
    },
  };
}

// イベント対象の代役を持つ Input を作る。
function newInput(): Input {
  const target = { addEventListener: () => {}, style: {} } as unknown as HTMLElement;
  return new Input(target);
}

export function register(): void {
  test('pause badge: 仮想キーのタップがポーズの押下エッジとして届く', () => {
    const stub = stubBrowserGlobals();
    try {
      const input = newInput();
      const adapter = rawGameInputAdapter(input);
      input.tapKey(K.pauseMenu);
      input.update();
      // 別のキーにはエッジが立っていない。
      assert.equal(adapter.takePressed({ code: K.help.code }), false);
      // ポーズのポートが受けるのと同じ binding で、1度だけ消費できる。
      assert.equal(adapter.takePressed({ code: K.pauseMenu.code }), true);
      assert.equal(adapter.takePressed({ code: K.pauseMenu.code }), false);
    } finally {
      stub.restore();
    }
  });

  test('pause badge: 物理 Esc も同じ押下エッジになる', () => {
    const stub = stubBrowserGlobals();
    try {
      const input = newInput();
      const adapter = rawGameInputAdapter(input);
      stub.pressPhysicalEscape();
      input.update();
      assert.equal(adapter.takePressed({ code: K.pauseMenu.code }), true);
      assert.equal(adapter.takePressed({ code: K.pauseMenu.code }), false);
    } finally {
      stub.restore();
    }
  });

  test('pause badge: 表示は body.touch-ui-active の間だけ', () => {
    // 既定では隠し、タッチ操作系が有効な間だけ常設ボタン群の並びへ出す。
    assert.match(SKELETON_STYLE, /#hud-chrome-actions \.hud-action--touch \{ display: none; \}/);
    assert.match(SKELETON_STYLE, /body\.touch-ui-active #hud-chrome-actions \.hud-action--touch \{ display: flex; \}/);
    // 建造中は他の常設バッジと同様に隠す。
    assert.match(SKELETON_STYLE, /#hud\.construction-mode #hud-chrome-actions,/);
  });
}
