import * as assert from 'node:assert/strict';
import { shortcutKeyLabel } from '../../src/hud/windows/shortcut-hint';
import { test } from '../harness';

export function register(): void {
  test('shortcut hint: Escape/Delete get special-cased labels, others uppercase', () => {
    assert.equal(shortcutKeyLabel('Escape'), 'ESC');
    assert.equal(shortcutKeyLabel('Delete'), 'DEL');
    assert.equal(shortcutKeyLabel('f'), 'F');
    assert.equal(shortcutKeyLabel('n'), 'N');
  });
}
