import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { metersPerPixelAtDepth } from '../../src/math/projection';
import { R_EARTH_EQ } from '../../src/game/celestial/solar-system/earth-system';
import { QUALITY_PRESETS } from '../../src/render/graphics-settings';
import { earthCenterOf } from '../../tools/render-lab/lab-earth';
import { EARTH_CASES } from '../../tools/render-lab/earth-cases';
import { FOV_DEG, VIEW_HEIGHT, VIEW_WIDTH } from '../../tools/render-lab/lab-case';
import { test } from '../harness';

export function register(): void {
  test('render-lab Earth nadir and standard cloud shot target the declared surface', () => {
    const earthCase = EARTH_CASES.earth();
    assert.ok(earthCase.earth);
    assert.ok(earthCase.viewTarget);

    const cameraForward = earthCase.camera.getWorldDirection(new THREE.Vector3());
    const pivotDepth = cameraForward.dot(
      new THREE.Vector3().subVectors(earthCase.viewTarget, earthCase.camera.position),
    );
    const pivot = earthCase.camera.position.clone().addScaledVector(cameraForward, pivotDepth);
    assert.ok(earthCase.viewTarget.distanceTo(pivot) < 1e-9);

    const nadirShot = earthCase.shots?.['earth-nadir'];
    const nearRangeShot = earthCase.shots?.['cloud-standard-near-range-250km'];
    assert.ok(nadirShot);
    assert.ok(nearRangeShot);

    const nadirPlacement = { ...earthCase.earth, ...nadirShot.view };
    const nadirCenter = earthCenterOf(nadirPlacement);
    const nadirEquatorialSurface = nadirCenter.clone().add(new THREE.Vector3(0, 0, R_EARTH_EQ));
    assert.ok(nadirEquatorialSurface.distanceTo(pivot) < 1e-6);
    assert.ok(nadirCenter.clone().sub(pivot).normalize().dot(cameraForward) > 1 - 1e-12);

    const nearPlacement = { ...earthCase.earth, ...nearRangeShot.view };
    const nearCenter = earthCenterOf(nearPlacement);
    const nearEquatorialSurface = nearCenter.clone().add(new THREE.Vector3(0, 0, R_EARTH_EQ));
    assert.ok(nearEquatorialSurface.distanceTo(pivot) < 1e-6);

    const baseCameraDistance = cameraForward.dot(
      new THREE.Vector3().subVectors(pivot, earthCase.camera.position),
    );
    const nearCameraDistance = baseCameraDistance * 10 ** nearRangeShot.view.cameraDistanceLog!;
    assert.ok(Math.abs(nearCameraDistance - 250e3) < 1e-6);
    assert.equal(FOV_DEG, 50);
    assert.equal(VIEW_WIDTH, 960);
    assert.equal(VIEW_HEIGHT, 540);
    const metersPerPixel = metersPerPixelAtDepth(FOV_DEG, nearCameraDistance, VIEW_HEIGHT);
    assert.ok(metersPerPixel <= 500);
    assert.ok(2e3 / metersPerPixel >= 4);
    assert.equal(nearRangeShot.graphics?.clouds, true);
    assert.deepEqual(nearRangeShot.graphics, QUALITY_PRESETS.medium);
  });
}
