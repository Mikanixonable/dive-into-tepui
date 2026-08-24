// タンパク質の半透明外殻をライト空間の深度マップへ描き、内部リボンへだけ自己影を返す。
// THREE の標準 shadowMap はこのプロジェクトのカスタム GBuffer/LightPrepass と接続しないため、
// 外殻の遮蔽深度とリボンの受け手マスクを専用ターゲットへ描く。
import * as THREE from 'three/webgpu';
import { MeshBasicNodeMaterial, WebGPURenderer } from 'three/webgpu';
import { clamp, positionView, uniform, vec3, vec4 } from 'three/tsl';
import type { FloatNode, FloatUniform, Mat4Uniform } from '../tsl-types';
import {
  PROTEIN_SHADOW_OCCLUDER_LAYER, PROTEIN_SHADOW_RECEIVER_LAYER,
} from './lit-layer';
import type { SunLight } from './sun-light';

const SHADOW_MAP_SIZE = 1024;
const SHADOW_BIAS = 0.0015;

export class ProteinShadowPass {
  private readonly shadowTarget: THREE.RenderTarget;
  private readonly receiverTarget: THREE.RenderTarget;
  private readonly shadowMaterial: THREE.MeshBasicNodeMaterial;
  private readonly receiverMaterial: THREE.MeshBasicNodeMaterial;
  private readonly lightCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  private readonly depthNear: FloatUniform;
  private readonly depthFar: FloatUniform;
  private readonly activeUniform: FloatUniform;
  private readonly lightViewUniform: Mat4Uniform;
  private readonly lightViewProjectionUniform: Mat4Uniform;
  private readonly box = new THREE.Box3();
  private readonly size = new THREE.Vector3();
  private readonly center = new THREE.Vector3();
  private readonly lightDirection = new THREE.Vector3();
  private readonly clearColor = new THREE.Color();

  constructor(private readonly renderer: WebGPURenderer) {
    this.shadowTarget = new THREE.RenderTarget(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE, {
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
      depthBuffer: true,
      samples: 0,
    });
    this.shadowTarget.texture.name = 'protein-shadow-depth';
    this.shadowTarget.depthTexture = new THREE.DepthTexture(
      SHADOW_MAP_SIZE, SHADOW_MAP_SIZE, THREE.FloatType,
    );

    this.receiverTarget = new THREE.RenderTarget(1, 1, {
      format: THREE.RedFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: true,
      samples: 0,
    });
    this.receiverTarget.texture.name = 'protein-shadow-receiver';

    this.depthNear = uniform(0.1);
    this.depthFar = uniform(10);
    this.activeUniform = uniform(0);
    this.lightViewUniform = uniform(new THREE.Matrix4());
    this.lightViewProjectionUniform = uniform(new THREE.Matrix4());

    const linearDepth: FloatNode = clamp(
      positionView.z.negate().sub(this.depthNear).div(this.depthFar.sub(this.depthNear)), 0, 1,
    );
    this.shadowMaterial = new MeshBasicNodeMaterial({
      depthTest: true,
      depthWrite: true,
      transparent: false,
      blending: THREE.NoBlending,
      side: THREE.DoubleSide,
    });
    // 色へライト空間の線形深度を書き、通常の深度バッファは「最も手前の外殻」を選ばせる。
    this.shadowMaterial.colorNode = vec4(vec3(linearDepth), 1);

    this.receiverMaterial = new MeshBasicNodeMaterial({
      color: 0xffffff,
      depthTest: true,
      depthWrite: true,
      transparent: false,
      blending: THREE.NoBlending,
      side: THREE.DoubleSide,
    });
  }

  get shadowTexture(): THREE.Texture { return this.shadowTarget.texture; }
  get receiverTexture(): THREE.Texture { return this.receiverTarget.texture; }
  get active(): FloatNode { return this.activeUniform; }
  get lightView(): Mat4Uniform { return this.lightViewUniform; }
  get lightViewProjection(): Mat4Uniform { return this.lightViewProjectionUniform; }
  get near(): FloatUniform { return this.depthNear; }
  get far(): FloatUniform { return this.depthFar; }
  get bias(): number { return SHADOW_BIAS; }

  render(scene: THREE.Scene, camera: THREE.Camera, width: number, height: number, sun: SunLight): void {
    if (this.receiverTarget.width !== width || this.receiverTarget.height !== height) {
      this.receiverTarget.setSize(width, height);
    }
    this.activeUniform.value = 0;
    if (!this.findOccluders(scene) || !this.configureLight(sun)) return;

    const savedMask = camera.layers.mask;
    const savedOverride = scene.overrideMaterial;
    const savedTarget = this.renderer.getRenderTarget();
    const savedAutoClear = this.renderer.autoClear;
    const savedAutoClearColor = this.renderer.autoClearColor;
    const savedAutoClearDepth = this.renderer.autoClearDepth;
    const savedClearColor = this.renderer.getClearColor(this.clearColor).clone();
    const savedClearAlpha = this.renderer.getClearAlpha();
    try {
      this.renderer.autoClear = true;
      this.renderer.autoClearColor = true;
      this.renderer.autoClearDepth = true;
      scene.overrideMaterial = this.shadowMaterial;
      this.lightCamera.layers.set(PROTEIN_SHADOW_OCCLUDER_LAYER);
      this.renderer.setClearColor(0xffffff, 1);
      this.renderer.setRenderTarget(this.shadowTarget);
      this.renderer.clear(true, true, false);
      this.renderer.render(scene, this.lightCamera);

      scene.overrideMaterial = this.receiverMaterial;
      camera.layers.set(PROTEIN_SHADOW_RECEIVER_LAYER);
      this.renderer.setClearColor(0x000000, 1);
      this.renderer.setRenderTarget(this.receiverTarget);
      this.renderer.clear(true, true, false);
      this.renderer.render(scene, camera);
      this.activeUniform.value = 1;
    } finally {
      scene.overrideMaterial = savedOverride;
      camera.layers.mask = savedMask;
      this.renderer.setRenderTarget(savedTarget);
      this.renderer.autoClear = savedAutoClear;
      this.renderer.autoClearColor = savedAutoClearColor;
      this.renderer.autoClearDepth = savedAutoClearDepth;
      this.renderer.setClearColor(savedClearColor, savedClearAlpha);
    }
  }

  private findOccluders(scene: THREE.Scene): boolean {
    this.box.makeEmpty();
    scene.traverse((object) => {
      if (object.userData.proteinShadowOccluder === true) this.box.expandByObject(object);
    });
    return !this.box.isEmpty();
  }

  private configureLight(sun: SunLight): boolean {
    this.box.getCenter(this.center);
    this.box.getSize(this.size);
    this.lightDirection.copy(sun.position.value).sub(this.center);
    const distance = this.lightDirection.length();
    if (!(distance > 1e-6) || !Number.isFinite(distance)) return false;
    this.lightDirection.multiplyScalar(1 / distance);

    const radius = Math.max(this.size.length() * 0.5, 1);
    const lightDistance = Math.max(radius * 4, 10);
    const extent = radius * 1.35;
    this.lightCamera.left = -extent;
    this.lightCamera.right = extent;
    this.lightCamera.top = extent;
    this.lightCamera.bottom = -extent;
    this.lightCamera.near = 0.1;
    this.lightCamera.far = lightDistance + radius * 2;
    this.lightCamera.position.copy(this.center).addScaledVector(this.lightDirection, lightDistance);
    this.lightCamera.up.set(
      Math.abs(this.lightDirection.y) < 0.9 ? 0 : 1,
      Math.abs(this.lightDirection.y) < 0.9 ? 1 : 0,
      0,
    );
    this.lightCamera.lookAt(this.center);
    this.lightCamera.updateProjectionMatrix();
    this.lightCamera.updateMatrixWorld(true);

    this.depthNear.value = this.lightCamera.near;
    this.depthFar.value = this.lightCamera.far;
    this.lightViewUniform.value.copy(this.lightCamera.matrixWorldInverse);
    this.lightViewProjectionUniform.value.multiplyMatrices(
      this.lightCamera.projectionMatrix, this.lightCamera.matrixWorldInverse,
    );
    return true;
  }

  dispose(): void {
    this.shadowTarget.dispose();
    this.receiverTarget.dispose();
    this.shadowMaterial.dispose();
    this.receiverMaterial.dispose();
  }
}
