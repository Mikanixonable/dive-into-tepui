// 雲影の幾何評価のための合成ケース。形の分かっている孤立した積雲(方向の円板、量一様)を焼いた
// 雲場を実機の CloudShadowRenderer へ結び、真球の地表の受け手の透過率を画面へ直接出す。
// 画面の各画素は円板の直下を中心とした地表の 1 点へ写る(cloud-shadow-geometry-model.ts の
// MAP)ので、影の位置と長さを tools/cloud-shadow-geometry-check.mjs がピクセルから読む。
import * as THREE from 'three/webgpu';
import { float, normalize, screenUV, vec3 } from 'three/tsl';
import { cumulusAmountFromTopAltitude } from '../../src/render/cloud/cloud-kind';
import { CloudBlendState } from '../../src/render/cloud/cloud-field-sample';
import type { CloudFieldBinding } from '../../src/render/cloud/cloud-field-sampler';
import {
  CloudShadowRenderer, type ShadowCloud,
} from '../../src/render/pipeline/shadow/cloud-shadow-renderer';
import { cloudShadowKinds } from '../../src/render/pipeline/shadow/shadow-select';
import { markOverlay } from '../../src/render/pipeline/lit-layer';
import { CUMULUS_DETAIL, cumulusOctavesOf } from '../../src/render/opaque-cloud-surface-renderer';
import {
  BODY_RADIUS_M, CAP_GROUND_RADIUS_M, DISCS, FIELD_TEXELS, MAP, TOP_ALTITUDE_M, ZENITH_DEG,
} from './cloud-shadow-geometry-model';
import { directionFromAngles } from './view-angles';
import { labCamera, VIEW_WIDTH, type CaseBuilder, type LabCase, type LabShot } from './lab-case';

// 円板を焼いた雲場テクスチャ。texel は cap の正射影 uv と同じ写像(方向 → 平面座標)で置き、
// 平面座標の長さから球面上の角距離へ戻して円板を判じる。
function bakeGeometryField(): THREE.DataTexture {
  const size = FIELD_TEXELS;
  const data = new Uint8Array(size * size * 4);
  const sinRadius = Math.sin(CAP_GROUND_RADIUS_M / BODY_RADIUS_M);
  for (let j = 0; j < size; j++) {
    const py = (1 - 2 * ((j + 0.5) / size)) * sinRadius;
    for (let i = 0; i < size; i++) {
      const px = (2 * ((i + 0.5) / size) - 1) * sinRadius;
      const rho = Math.hypot(px, py);
      const angle = Math.asin(Math.min(1, rho));
      const gx = rho > 1e-9 ? (BODY_RADIUS_M * angle * px) / rho : 0;
      const gz = rho > 1e-9 ? (BODY_RADIUS_M * angle * py) / rho : 0;
      let amount = 0;
      for (const disc of DISCS) {
        if (Math.hypot(gx - disc.xiM, gz - disc.zetaM) <= disc.radiusM) {
          amount = Math.max(amount, cumulusAmountFromTopAltitude(disc.topAltitudeM));
        }
      }
      const o = (j * size + i) * 4;
      data[o] = Math.round(amount * 255);
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.colorSpace = THREE.NoColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function cloudShadowGeometryCase(...[, , sunLight]: Parameters<CaseBuilder>): LabCase {
  const field = bakeGeometryField();
  const empty = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
  empty.colorSpace = THREE.NoColorSpace;
  empty.needsUpdate = true;
  const capRadius = CAP_GROUND_RADIUS_M / BODY_RADIUS_M;
  const binding: CloudFieldBinding = {
    slots: [
      { cloud: field, motion: empty, environment: empty },
      { cloud: field, motion: empty, environment: empty },
    ],
    blend: new CloudBlendState(),
    cap: {
      center: new THREE.Vector3(0, 1, 0),
      east: new THREE.Vector3(1, 0, 0),
      north: new THREE.Vector3(0, 0, 1),
      sinRadius: Math.sin(capRadius),
      cosRadius: Math.cos(capRadius),
    },
  };
  // 受け手の天体は真球。円板の直下を描画原点へ置くので、中心は半径ぶん −Y。
  const shadowCloud: ShadowCloud = {
    center: new THREE.Vector3(0, -BODY_RADIUS_M, 0),
    surfaceRadius: BODY_RADIUS_M,
    axes: new THREE.Vector3(BODY_RADIUS_M, BODY_RADIUS_M, BODY_RADIUS_M),
    bodyFromWorld: new THREE.Matrix4(),
    cloud: {
      field: binding,
      generation: 0,
      topAltitude: TOP_ALTITUDE_M,
      clock: { displayTime: 0, simSpeed: 0 },
    },
  };
  // パイプラインが持つものとは別の CloudShadowRenderer を組む — 透過率を直接画素へ出すので、
  // このケースが自分で恒星と雲場を結ぶ。uniform とテクスチャの結びは set() が毎フレーム保つ。
  const shadow = new CloudShadowRenderer(sunLight);
  // 画面の画素を地表の点へ写す(MAP)。地表は円板の直下の球面 — 半径ぶん原点へ戻してから法線へ正規化する。
  const xi = screenUV.x.sub(0.5).mul(MAP.widthM).add(MAP.centerXM);
  const zeta = screenUV.y.sub(0.5).mul(MAP.heightM).negate();
  const receiver = normalize(vec3(xi, float(BODY_RADIUS_M), zeta))
    .mul(BODY_RADIUS_M).add(vec3(0, -BODY_RADIUS_M, 0));
  const material = new THREE.MeshBasicNodeMaterial();
  material.colorNode = vec3(shadow.transmittance(receiver, float(MAP.widthM / VIEW_WIDTH)));
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(4000, 2400), material);
  plane.position.set(0, 0, -1000);
  plane.frustumCulled = false;
  markOverlay(plane);
  plane.userData.ownsGeometry = true;
  plane.userData.ownsMaterial = true;
  const shots: Record<string, LabShot> = {};
  for (const zenith of ZENITH_DEG) {
    for (const [tag, detail] of [
      ['d0', CUMULUS_DETAIL.coarse], ['dstd', CUMULUS_DETAIL.standard],
    ] as const) {
      shots[`csgeom-z${zenith}-${tag}`] = {
        view: { sunAzimuthDeg: 90, sunElevationDeg: 90 - zenith },
        graphics: { cumulusDetail: detail },
      };
    }
  }
  return {
    objects: [plane],
    camera: labCamera(),
    viewTarget: new THREE.Vector3(0, 0, -1000),
    sunDirection: directionFromAngles(90, 60, new THREE.Vector3()),
    sync: (graphics) => {
      const kinds = cloudShadowKinds(graphics);
      shadow.set(shadowCloud, {
        ...kinds,
        cirrus: false,
        // coarse はこのケースでは「細部 0 段(形を決定的にする)」の意味で使う。
        cumulusOctaves: graphics.cumulusDetail === CUMULUS_DETAIL.coarse
          ? 0 : cumulusOctavesOf(graphics.cumulusDetail),
      });
    },
    dispose: () => {
      shadow.set(null, { cumulus: false, cirrus: false, cumulusOctaves: 0, cirrusOctaves: 0 });
      field.dispose();
      empty.dispose();
    },
    shots,
  };
}

export const CLOUD_SHADOW_GEOMETRY_CASES = {
  'cloud-shadow-geometry': cloudShadowGeometryCase,
} as const;
