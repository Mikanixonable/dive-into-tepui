// 生成雲場から、半透明雲の教師窓と同じ形の物理量の画像を読み出すページ。ゲームと同じ
// 生成器が焼く雲場を、窓の緯度経度を覆う置き方へ cap を狙い、積雲・巻雲それぞれの
// 鉛直柱光学深さ(COT 相当)と雲頂高度(雲頂高度相当)を描画器と同じ式(cloud-kind の
// ノード)で場から出す。風は雲を運ぶ風の写しを返す。
// window.cloudTranslucent が tools/cloud-translucent-compare.mjs の駆動口。
import * as THREE from 'three/webgpu';
import { QuadMesh, WebGPURenderer } from 'three/webgpu';
import { mrt, uniform, vec4 } from 'three/tsl';
import { earthGeneratedCloudField, R_EARTH } from '../../src/game/celestial/solar-system/earth-system';
import { OrthographicCap } from '../../src/render/field-projection';
import { DeferredTexture } from '../../src/render/deferred-texture';
import { snapCap } from '../../src/render/cloud/cloud-cap';
import {
  cirrusColumnOpticalDepthNode, cirrusTopAltitudeNode,
  cumulusColumnOpticalDepthNode, cumulusTopAltitudeNode,
} from '../../src/render/cloud/cloud-kind-node';
import {
  CIRRUS_MAX_OPTICAL_DEPTH, CIRRUS_TOP_ALTITUDE,
  CUMULUS_MAX_OPTICAL_DEPTH, CUMULUS_TOP_ALTITUDE,
} from '../../src/render/cloud/cloud-kind';
import {
  CloudMotionWind, awaitClimateMap, boxDirectionNode, renderTargetBase64,
} from './probe-common';
import type { GeneratedCloudField } from '../../src/render/cloud/generated-cloud-field';
import type { Vec3Node, Vec4Node } from '../../src/render/tsl-types';

declare global {
  interface Window {
    cloudTranslucent?: CloudTranslucentProbe;
  }
}

// 箱の指定。緯度経度 [deg] の四辺(実写の窓と同じ EPSG:4326 の面)。読み出す面は一辺 BOX_PX 画素。
interface BoxSpec {
  readonly north: number;
  readonly south: number;
  readonly west: number;
  readonly east: number;
}

interface CloudTranslucentProbe {
  // 中心 latDeg・lonDeg [deg] から半径 radiusKm [km] の円板を覆うよう cap を置き直す。
  // 置き方は本番と同じく地表の格子へ揃える(snapCap)。
  readonly aim: (latDeg: number, lonDeg: number, radiusKm: number) => void;
  // 表示時刻 hours [h] の場を焼く。以後の samplePhysBox / sampleWindBox はこの時刻を読む。
  readonly prepare: (hours: number) => Promise<void>;
  // 種類別の物理量を箱の面で読む。RGBA8 の生画素の base64(行は北から南、列は西から東):
  // R = 積雲の鉛直柱光学深さ / CUMULUS_MAX_OPTICAL_DEPTH、
  // G = 巻雲の同 / CIRRUS_MAX_OPTICAL_DEPTH、B = 積雲の雲頂高度 / CUMULUS_TOP_ALTITUDE、
  // A = 巻雲の雲頂高度 / CIRRUS_TOP_ALTITUDE。
  readonly samplePhysBox: (spec: BoxSpec) => Promise<string>;
  // 雲を運ぶ風を箱の面で読む。RGBA8 の生画素の base64(R・G = 地表付近、B・A = 上層の
  // 東・北成分。いずれも ±WIND_SPAN_MS m/s を 0..1 へ写した値)。
  readonly sampleWindBox: (spec: BoxSpec) => Promise<string>;
}

// 切り出し面の一辺 [px]。
const BOX_PX = 512;

class TranslucentProbeCanvas {
  private readonly physQuad: QuadMesh;
  private readonly windQuad: QuadMesh;
  private readonly boxBounds = uniform(new THREE.Vector4(0, 0, 0, 0));
  private readonly motionWind: CloudMotionWind;
  private readonly physTarget = (() => {
    const target = new THREE.RenderTarget(BOX_PX, BOX_PX, {
      format: THREE.RGBAFormat, type: THREE.UnsignedByteType, depthBuffer: false, samples: 0,
    });
    target.textures[0]!.name = 'phys';
    return target;
  })();
  private readonly windTarget = (() => {
    const target = new THREE.RenderTarget(BOX_PX, BOX_PX, {
      format: THREE.RGBAFormat, type: THREE.UnsignedByteType, depthBuffer: false, samples: 0,
    });
    target.textures[0]!.name = 'wind';
    return target;
  })();
  private readonly physMaterial: THREE.MeshBasicNodeMaterial;
  private readonly windMaterial: THREE.MeshBasicNodeMaterial;

  public static async create(
    canvas: HTMLCanvasElement, cap: OrthographicCap,
  ): Promise<TranslucentProbeCanvas> {
    const renderer = new WebGPURenderer({ canvas });
    renderer.setSize(BOX_PX, BOX_PX, false);
    renderer.toneMapping = THREE.NoToneMapping;
    await renderer.init();
    const field = earthGeneratedCloudField(cap);
    const probe = new TranslucentProbeCanvas(renderer, field);
    await awaitClimateMap(renderer, [field.climateMap], 'cloud translucent probe');
    return probe;
  }

  private constructor(
    private readonly renderer: WebGPURenderer, private readonly field: GeneratedCloudField,
  ) {
    this.motionWind = new CloudMotionWind(field);
    this.physMaterial = new THREE.MeshBasicNodeMaterial({ depthTest: false, depthWrite: false });
    this.windMaterial = new THREE.MeshBasicNodeMaterial({ depthTest: false, depthWrite: false });
    // 読み出しの 4 成分目をアルファとして捨てられないよう、MRT 経路で全成分を書く
    // (colorNode の vec4.w は不透明マテリアルでは 1 に潰れる)。
    this.physMaterial.mrtNode = mrt({ phys: this.physNode() });
    this.windMaterial.mrtNode = mrt({ wind: this.windNode() });
    this.physQuad = new QuadMesh(this.physMaterial);
    this.windQuad = new QuadMesh(this.windMaterial);
  }

  // いまの boxBounds が指す箱の画素が張る単位方向。
  private directionNode(): Vec3Node {
    return boxDirectionNode(this.boxBounds);
  }

  // 積雲・巻雲の量から、種類別の柱の深さ(積雲は覆いの深さ、巻雲は光学的厚み)と雲頂高度を
  // 描画器と同じ式で出す。
  private physNode(): Vec4Node {
    const direction = this.directionNode();
    const sample = this.field.at(direction);
    return vec4(
      cumulusColumnOpticalDepthNode(sample.cumulus).div(CUMULUS_MAX_OPTICAL_DEPTH),
      cirrusColumnOpticalDepthNode(sample.cirrus).div(CIRRUS_MAX_OPTICAL_DEPTH),
      cumulusTopAltitudeNode(sample.cumulus).div(CUMULUS_TOP_ALTITUDE),
      cirrusTopAltitudeNode(sample.cirrus).div(CIRRUS_TOP_ALTITUDE));
  }

  // 雲を運ぶ風の写し(±WIND_SPAN_MS へ写した地表付近・上層の東・北成分)。
  private windNode(): Vec4Node {
    return this.motionWind.windNode(this.directionNode());
  }

  // 表示時刻 hours [h] の場を焼く。時刻が大きく跳ぶので 1 枚だけ焼き直される。
  public async prepare(hours: number): Promise<void> {
    DeferredTexture.publishOne(this.renderer);
    this.field.prepare(this.renderer, hours * 3600);
    this.motionWind.syncBlend();
  }

  // 画素を base64 で返す(行は北から南へ、列は西から東へ並ぶ)。
  private async sample(spec: BoxSpec, quad: QuadMesh, target: THREE.RenderTarget): Promise<string> {
    this.boxBounds.value.set(
      THREE.MathUtils.degToRad(spec.west), THREE.MathUtils.degToRad(spec.south),
      THREE.MathUtils.degToRad(spec.east), THREE.MathUtils.degToRad(spec.north));
    return renderTargetBase64(this.renderer, quad, target, BOX_PX);
  }

  public async samplePhysBox(spec: BoxSpec): Promise<string> {
    return this.sample(spec, this.physQuad, this.physTarget);
  }

  public async sampleWindBox(spec: BoxSpec): Promise<string> {
    return this.sample(spec, this.windQuad, this.windTarget);
  }
}

async function init(): Promise<void> {
  // cap は生成器が場を焼く投影。初期の置き方はダミーで、aim が窓ごとに置き直す。
  const cap = new OrthographicCap(512, 0, 0, 0.02);
  const probe = await TranslucentProbeCanvas.create(
    document.getElementById('view') as HTMLCanvasElement, cap);
  window.cloudTranslucent = {
    aim: (latDeg, lonDeg, radiusKm) => {
      const lat = THREE.MathUtils.degToRad(latDeg);
      const lon = THREE.MathUtils.degToRad(lonDeg);
      const snapped = snapCap(lat, lon, radiusKm / R_EARTH);
      cap.aim(snapped.latitude, snapped.longitude, snapped.radius);
    },
    prepare: (hours) => probe.prepare(hours),
    samplePhysBox: (spec) => probe.samplePhysBox(spec),
    sampleWindBox: (spec) => probe.sampleWindBox(spec),
  };
}

init().catch((e: unknown) => {
  document.getElementById('error')!.textContent = String(e);
});
