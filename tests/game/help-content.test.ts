// 操作説明の文面分岐の回帰テスト。細かいポインタではキー名で案内し(従来どおり)、
// 粗いポインタではキー名ではなく画面上の操作部品の名前で案内することを固定する。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { helpRows, type HelpCategory } from '../../src/game/hud/windows/help-content';

// 章とラベルで行を1つ引く。見つからなければテストを落とす。
function row(
  rows: ReturnType<typeof helpRows>, category: HelpCategory, label: string,
): { input: string; description: string } {
  const found = rows.find((r) => r.category === category && r.label === label);
  assert.ok(found, `${category}/${label} の行がある`);
  return found;
}

export function register(): void {
  test('help content: 細かいポインタではキー名で案内する', () => {
    const rows = helpRows(false);
    assert.equal(row(rows, 'flight', '機体の並進').input, 'W / S / A / D / Q / E');
    assert.equal(row(rows, 'combat', '機関砲発射').input, 'SPACE');
    // ジェスチャの行にも同じラベルがあるので、矢印キーの行を input で見分ける。
    const cameraKeys = rows.find((r) => r.category === 'camera' && r.label === '視点回転' && r.input.includes('←'));
    assert.equal(cameraKeys?.input, '← / → / ↑ / ↓');
    assert.equal(row(rows, 'construction', '視点').input, 'F');
    assert.equal(row(rows, 'construction', '取り消し').input, 'Ctrl+Z');
    assert.match(row(rows, 'system', 'デバッグ・セーブ').description, /F3 でデバッグ表示、F5 で手動セーブ、F9 でセーブデータ画面/);
    assert.match(row(rows, 'flight', '機体の並進').description, /キーを押している間だけ/);
  });

  test('help content: 粗いポインタでは操作部品の名前で案内する', () => {
    const rows = helpRows(true);
    assert.equal(row(rows, 'flight', '機体の並進').input, '左下の並進パッド');
    assert.match(row(rows, 'flight', '機体の並進').description, /ボタンを押している間だけ/);
    assert.equal(row(rows, 'combat', '機関砲発射').input, 'FIRE ボタン');
    assert.equal(row(rows, 'system', 'ESC メニュー').input, '⚙\uFE0E バッジ');
    assert.equal(row(rows, 'construction', '視点').input, '「視点を寄せる」ボタン');
    assert.equal(row(rows, 'construction', '建造を終える').input, '「建造終了」ボタン');
    assert.match(row(rows, 'system', 'デバッグ・セーブ').description, /ESC メニューから/);
  });

  test('help content: 粗いポインタではキー名だけの行が残らない', () => {
    const fine = helpRows(false);
    const coarse = helpRows(true);
    // 矢印キー等の3行はジェスチャの行で案内済みのため coarse では省かれる。
    assert.equal(coarse.length, fine.length - 3);
    const keyOnlyInputs = ['W / S / A / D / Q / E', 'SPACE', 'ESC', 'TAB', 'H', 'M', 'N', 'X', 'Ctrl+Z', 'F3 / F5 / F9'];
    for (const r of coarse) {
      assert.ok(!keyOnlyInputs.includes(r.input), `coarse の input にキー名が残っている: ${r.input}`);
      assert.ok(!r.input.includes('Ctrl'), `coarse の input に修飾キーが残っている: ${r.input}`);
    }
  });
}
