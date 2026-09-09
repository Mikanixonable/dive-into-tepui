import * as assert from 'node:assert/strict';
import {
  integrateVerticalCloudProfile,
  verticalCloudProfile,
} from '../../src/render/cloud/cloud-volume';
import { test } from '../harness';

export function register(): void {
  test('cloud volume: vertical profile is continuous and zero at both boundaries', () => {
    assert.equal(verticalCloudProfile(0), 0);
    assert.equal(verticalCloudProfile(1), 0);
    assert.equal(verticalCloudProfile(0.5), 1.5);
    assert.equal(verticalCloudProfile(-1), 0);
    assert.equal(verticalCloudProfile(2), 0);
  });

  test('cloud volume: normalized profile preserves unit column optical depth', () => {
    const profileIntegral = integrateVerticalCloudProfile(64);
    assert.ok(Math.abs(integrateVerticalCloudProfile(16) - 1) < 0.002);
    assert.ok(Math.abs(profileIntegral - 1) < 0.0002);
    for (const columnTau of [0, 0.25, 2.5]) {
      assert.ok(Math.abs(columnTau * profileIntegral - columnTau) < 0.0005);
    }
    assert.equal(integrateVerticalCloudProfile(0), 0);
    assert.equal(integrateVerticalCloudProfile(Number.NaN), 0);
  });

  test('cloud volume: thin profile samples remain finite and bounded', () => {
    for (const height of [0, 0.1, 0.5, 0.9, 1]) {
      const profile = verticalCloudProfile(height);
      assert.ok(Number.isFinite(profile));
      assert.ok(profile >= 0 && profile <= 1.5);
    }
  });
}
