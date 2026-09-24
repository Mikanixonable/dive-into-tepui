import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { test } from '../harness';
import { withLabPixelRatio } from '../../tools/render-lab/lab';

class TestRenderer {
  public readonly domElement = { width: 960, height: 540 } as HTMLCanvasElement;
  private pixelRatio = 1;
  private width = 960;
  private height = 540;

  public getPixelRatio(): number { return this.pixelRatio; }

  public getSize(target: THREE.Vector2): THREE.Vector2 {
    return target.set(this.width, this.height);
  }

  public setPixelRatio(value: number): void { this.pixelRatio = value; }

  public setSize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.domElement.width = Math.floor(width * this.pixelRatio);
    this.domElement.height = Math.floor(height * this.pixelRatio);
  }
}

export function register(): void {
  test('render-lab medium measurement: CSS viewportを保って内部解像度を戻す', async () => {
    const renderer = new TestRenderer();
    const dimensions = await withLabPixelRatio(renderer, 0.75, async () => ({
      width: renderer.domElement.width,
      height: renderer.domElement.height,
      viewport: renderer.getSize(new THREE.Vector2()),
    }));

    assert.equal(dimensions.width, 720);
    assert.equal(dimensions.height, 405);
    assert.deepEqual(dimensions.viewport.toArray(), [960, 540]);
    assert.equal(renderer.domElement.width, 960);
    assert.equal(renderer.domElement.height, 540);
    assert.equal(renderer.getPixelRatio(), 1);
  });

  test('render-lab medium measurement: 失敗しても内部解像度を戻す', async () => {
    const renderer = new TestRenderer();
    await assert.rejects(
      withLabPixelRatio(renderer, 0.75, async () => { throw new Error('measurement failed'); }),
      /measurement failed/,
    );

    assert.equal(renderer.domElement.width, 960);
    assert.equal(renderer.domElement.height, 540);
    assert.equal(renderer.getPixelRatio(), 1);
  });
}
