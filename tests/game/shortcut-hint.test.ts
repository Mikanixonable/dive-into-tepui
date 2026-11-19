import * as assert from 'node:assert/strict';
import { shortcutKeyLabel } from '../../src/hud/shortcut-hint';
import { test } from '../harness';

export function register(): void {
  test('shortcut hint: Escape/Delete get special-cased labels, others uppercase', () => {
    assert.equal(shortcutKeyLabel('Escape', false), 'ESC');
    assert.equal(shortcutKeyLabel('Delete', false), 'DEL');
    assert.equal(shortcutKeyLabel('KeyF', false), 'F');
    assert.equal(shortcutKeyLabel('f', false), 'F');
    assert.equal(shortcutKeyLabel('n', false), 'N');
  });

  test('shortcut hint: coarse な環境ではキー名を添えない', () => {
    assert.equal(shortcutKeyLabel('Escape', true), '');
    assert.equal(shortcutKeyLabel('Delete', true), '');
    assert.equal(shortcutKeyLabel('KeyF', true), '');
  });
}
