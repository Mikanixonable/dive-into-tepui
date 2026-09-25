import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import {
  cloudDetailResidualCoverage, cloudDetailTileWeight, type CloudFieldDetailTileBinding,
} from '../../src/render/cloud/cloud-field-sampler';
import {
  CLOUD_FIELD_SOURCE_KIND, CloudPresentation, type CloudFieldSource, type CloudFieldSourceKind,
  type CloudPresentationDetailTile,
} from '../../src/render/cloud/cloud-presentation';
import { OrthographicCap } from '../../src/render/field-projection';
import { DEFAULT_GRAPHICS } from '../../src/render/graphics-settings';
import {
  cloudDetailDiagnosticCoverage, CLOUD_DETAIL_DIAGNOSTIC_DIRECTIONS_DEG,
  CLOUD_DETAIL_DIAGNOSTIC_SIZE, CLOUD_DETAIL_DIAGNOSTIC_WAVELENGTHS_KM, createCloudDetailDiagnosticTile,
} from '../../tools/render-lab/cloud-detail-diagnostic';
import { test } from '../harness';

class TestCloudFieldSource implements CloudFieldSource {
  public readonly texture = new THREE.DataTexture(new Uint8Array(4), 1, 1, THREE.RGBAFormat);
  public readonly generation = 0;
  public prepare(): void {}
  public dispose(): void { this.texture.dispose(); }
}

export function register(): void {
  test('cloud detail tile: angular blend is zero outside, smooth at the seam, and full inside', () => {
    const outerCos = Math.cos(0.08);
    const fullDetailCos = Math.cos(0.05);
    const blendMidpoint = (outerCos + fullDetailCos) / 2;

    assert.equal(cloudDetailTileWeight(outerCos - 0.01, outerCos, fullDetailCos), 0);
    assert.equal(cloudDetailTileWeight(outerCos, outerCos, fullDetailCos), 0);
    assert.ok(Math.abs(cloudDetailTileWeight(blendMidpoint, outerCos, fullDetailCos) - 0.5) < 1e-12);
    assert.equal(cloudDetailTileWeight(fullDetailCos, outerCos, fullDetailCos), 1);
    assert.equal(cloudDetailTileWeight(fullDetailCos + 0.001, outerCos, fullDetailCos), 1);
  });

  test('cloud detail tile: applies only to generated source and returns when generated is reselected', () => {
    const generated = new TestCloudFieldSource();
    const observed = new TestCloudFieldSource();
    const presentation = new CloudPresentation(
      generated, observed, new OrthographicCap(8, 0, 0, 0.4), 6_371_000,
    );
    const tileTexture = new THREE.DataTexture(new Uint8Array(4), 1, 1, THREE.RGBAFormat);
    const tile: CloudPresentationDetailTile = {
      texture: tileTexture,
      cap: new OrthographicCap(8, 0, 0, 0.1),
      radius: 0.1,
      blendStartCos: Math.cos(0.05),
      composition: 'coverage-residual',
    };
    const settings = (cloudFieldSource: CloudFieldSourceKind) => ({
      ...DEFAULT_GRAPHICS,
      clouds: true,
      cloudFieldSource,
    });

    try {
      presentation.syncGraphics(settings(CLOUD_FIELD_SOURCE_KIND.generated), 100, tile);
      const generatedTile = presentation.renderInput.field.detailTile;
      assert.ok(generatedTile !== null);
      assert.equal(generatedTile.texture, tileTexture);

      presentation.syncGraphics(settings(CLOUD_FIELD_SOURCE_KIND.observed), 100, tile);
      assert.equal(presentation.renderInput.field.texture, observed.texture);
      assert.equal(presentation.renderInput.field.detailTile, null);

      presentation.syncGraphics(settings(CLOUD_FIELD_SOURCE_KIND.generated), 100, tile);
      assert.equal(presentation.renderInput.field.texture, generated.texture);
      const selectedTile = (): CloudFieldDetailTileBinding | null => presentation.renderInput.field.detailTile;
      assert.equal(selectedTile()?.texture, tileTexture);

      presentation.syncGraphics(settings(CLOUD_FIELD_SOURCE_KIND.generated), 100, null);
      assert.equal(presentation.renderInput.field.detailTile, null);
    } finally {
      presentation.dispose();
      tileTexture.dispose();
    }
  });

  test('cloud detail tile: blend boundaries must describe a non-empty angular band', () => {
    assert.throws(() => cloudDetailTileWeight(0, 0.5, 0.5), RangeError);
    assert.throws(() => cloudDetailTileWeight(0, -1.1, 0), RangeError);
    assert.throws(() => cloudDetailTileWeight(0, 0, 1.1), RangeError);
    assert.throws(() => cloudDetailTileWeight(1.1, -0.5, 0.5), RangeError);
  });

  test('cloud detail tile: residual coverage preserves clear and opaque base, and its mean', () => {
    for (const detail of [0, 0.25, 0.5, 0.75, 1]) {
      assert.equal(cloudDetailResidualCoverage(0, detail), 0);
      assert.equal(cloudDetailResidualCoverage(1, detail), 1);
    }
    for (const base of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      assert.equal(cloudDetailResidualCoverage(base, 0.5), base);
      assert.ok(Math.abs((cloudDetailResidualCoverage(base, 0)
        + cloudDetailResidualCoverage(base, 1)) / 2 - base) < 1e-12);
    }
    assert.throws(() => cloudDetailResidualCoverage(-0.1, 0.5), RangeError);
  });

  test('cloud detail diagnostic: known 2 km wave repeats and rotates by its declared direction', () => {
    assert.deepEqual(CLOUD_DETAIL_DIAGNOSTIC_WAVELENGTHS_KM, [1, 1.5, 2, 3, 4]);
    assert.deepEqual(CLOUD_DETAIL_DIAGNOSTIC_DIRECTIONS_DEG, [0, 45, 90, 135]);
    assert.equal(cloudDetailDiagnosticCoverage(0, 0, 2, 0), 1);
    assert.ok(Math.abs(cloudDetailDiagnosticCoverage(0.5, 0, 2, 0) - 0.5) < 1e-12);
    assert.equal(cloudDetailDiagnosticCoverage(1, 0, 2, 0), 0);
    assert.equal(cloudDetailDiagnosticCoverage(2, 0, 2, 0), 1);
    assert.equal(cloudDetailDiagnosticCoverage(0, 1, 2, 0), 1);
    assert.equal(cloudDetailDiagnosticCoverage(0, 1, 2, 90), 0);
    for (const direction of CLOUD_DETAIL_DIAGNOSTIC_DIRECTIONS_DEG) {
      const original = cloudDetailDiagnosticCoverage(0.37, -0.18, 2, direction);
      const inverted = cloudDetailDiagnosticCoverage(0.37, -0.18, 2, direction, 180);
      assert.ok(Math.abs(original + inverted - 1) < 1e-12);
    }
    assert.throws(() => cloudDetailDiagnosticCoverage(0, 0, 0, 0), RangeError);
  });

  test('cloud detail diagnostic: RGBA8 tile stays within 4 MiB at its fixed 2 km resolution fixture', () => {
    const tile = createCloudDetailDiagnosticTile();
    const data = tile.texture.image.data;
    assert.ok(data instanceof Uint8Array);
    assert.equal(tile.texture.image.width, CLOUD_DETAIL_DIAGNOSTIC_SIZE);
    assert.equal(tile.texture.image.height, CLOUD_DETAIL_DIAGNOSTIC_SIZE);
    assert.equal(data.byteLength, 4 * 1024 * 1024);
    assert.ok(tile.blendStartCos > tile.cap.placement.cosRadius);
    tile.texture.dispose();
  });
}
