// 折れ線(軌道線・軌跡線)の天体遮蔽を、ハードウェアの深度テストではなくレイ・球交差の
// 解析判定で行うための TSL ノード。near=2m・24bit 非対数深度バッファでは、天体表面近くの
// ジオメトリと地表そのものとの深度差が水平線に近い視線ほど量子化幅を下回り、深度テストだけに
// 頼ると z-fighting でちらつく/透けて見える(render/earth.ts が地表付近の他ジオメトリを深度
// テストに一切乗せない理由と同じ)。判定式は physics/occlusion.ts の isOccluded と同じ
// (レイと球の交差、手前側交点がその対象点より OCCLUSION_MARGIN 以上カメラ寄りなら遮蔽)。
import * as THREE from 'three/webgpu';
import {
  Fn, If, and, float, uniform, vec3,
  positionWorld, cameraPosition, dot, max as tslMax, sqrt as tslSqrt, sub, length,
} from 'three/tsl';

// 折れ線1本が同時に遮蔽判定できる天体数の上限。固定本数ぶんのユニフォームを並べ、シェーダ
// ビルド時(JS 側)に静的に展開する — 実行時に可変長のループを回すより単純で、太陽系全体の
// 登録天体数(約100)は呼び出し側が見かけの角半径順にこの件数まで絞ってから渡す
// (physics/occlusion.ts の nearestOccludingBodies)。
export const MAX_OCCLUDING_BODIES = 8;

// physics/occlusion.ts の OCCLUSION_MARGIN と同じ値・同じ理由(対象点自身がその天体の
// 表面近傍にあるときの自己遮蔽の誤判定を防ぐ余裕)。
const OCCLUSION_MARGIN = 1;

// 遮蔽体1件ぶんのユニフォーム。半径0は「未使用」を表し、球交差が常に不成立になる。
function sphereUniform() {
  const center = new THREE.Vector3();
  return { center, centerNode: uniform(center, 'vec3'), radiusNode: uniform(0, 'float') };
}

// 折れ線1本ぶんの遮蔽体一覧。呼び出し側が毎フレーム set() で書き換える。
export class LineOcclusion {
  private readonly spheres = Array.from({ length: MAX_OCCLUDING_BODIES }, sphereUniform);

  // 判定対象の天体を差し替える。bodies は MAX_OCCLUDING_BODIES 件以内であること
  // (呼び出し側で nearestOccludingBodies により絞り込み済みを渡す)。
  set(bodies: readonly { readonly position: THREE.Vector3; readonly radius: number }[]): void {
    const n = Math.min(bodies.length, MAX_OCCLUDING_BODIES);
    for (let i = 0; i < MAX_OCCLUDING_BODIES; i++) {
      const slot = this.spheres[i]!;
      if (i < n) {
        slot.center.copy(bodies[i]!.position);
        slot.radiusNode.value = bodies[i]!.radius;
      } else {
        slot.radiusNode.value = 0;
      }
    }
  }

  // 現在のフラグメント(positionWorld)がいずれの天体にも遮られていなければ 1、
  // いずれかに遮られていれば 0。opacityNode へ乗算して使う。
  readonly factor = Fn(() => {
    const visible = float(1).toVar();
    const toPoint = sub(positionWorld, cameraPosition);
    const dist = length(toPoint);
    const dir = toPoint.div(tslMax(dist, float(1e-6)));

    for (const { centerNode, radiusNode } of this.spheres) {
      const center = vec3(centerNode);
      const radius = float(radiusNode);
      const oc = sub(center, cameraPosition);
      const tca = dot(oc, dir);
      If(tca.greaterThan(float(0)), () => {
        const dSq = sub(dot(oc, oc), tca.mul(tca));
        const rSq = radius.mul(radius);
        If(dSq.lessThan(rSq), () => {
          const thc = tslSqrt(tslMax(sub(rSq, dSq), float(0)));
          const t0 = sub(tca, thc);
          If(and(t0.greaterThan(float(0)), t0.lessThan(sub(dist, float(OCCLUSION_MARGIN)))), () => {
            visible.assign(float(0));
          });
        });
      });
    }

    return visible;
  })();
}
