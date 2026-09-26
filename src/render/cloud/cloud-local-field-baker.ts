// 局所光学場の再焼を担う。CloudLocalFieldSupply の導出から CloudOpticalVolume と sampler へ
// 渡す binding を組み、再焼の条件と焼いた体積の寿命を持つ。
import { cross, dot, len } from '../../math/vec3';
import type { Vec3 } from '../../math/vec3';
import {
  validateCloudLocalFieldFrame,
  type CloudLocalFieldBinding, type CloudLocalFieldSupply,
  type CloudLocalFieldSupplyResult,
} from './cloud-local-field';
import {
  CloudOpticalVolume, type CloudOpticalVolumeStorageFormat,
} from './cloud-optical-volume';

const VECTOR_TOLERANCE = 1e-10;

function requireFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
}

function requireUnitVector(vector: Vec3, name: string): void {
  requireFinite(vector.x, `${name}.x`);
  requireFinite(vector.y, `${name}.y`);
  requireFinite(vector.z, `${name}.z`);
  if (Math.abs(len(vector) - 1) > VECTOR_TOLERANCE) {
    throw new RangeError(`${name} must be a unit vector`);
  }
}

function angularDistanceRad(first: Vec3, second: Vec3): number {
  return Math.atan2(len(cross(first, second)), Math.max(-1, Math.min(1, dot(first, second))));
}

export class CloudLocalFieldBaker {
  private current: {
    readonly volume: CloudOpticalVolume;
    readonly binding: CloudLocalFieldBinding;
  } | null = null;
  // 直前に差し替えた体積。差し替え中に binding を読む側が破棄済みの texture を掴まないよう、
  // 次の再焼まで生かしてから破棄する。
  private retainedVolume: CloudOpticalVolume | null = null;
  // 直近に焼き上げた時刻と中心方向。失敗した試行では更新しない — 条件が残ったままなので
  // 次の呼び出しでそのまま再試行になる。
  private builtAt: { readonly timeSeconds: number; readonly centerDirection: Vec3 } | null = null;

  // supply は場の内容の導出先(null なら場を持たない)。rebuildIntervalSeconds は再焼の最小
  // 間隔 [s]、recenterAngularThresholdRad は中心がどれだけ動いたら焼き直すかの角距離 [rad]。
  public constructor(
    private readonly supply: CloudLocalFieldSupply | null,
    private readonly rebuildIntervalSeconds = 300,
    private readonly recenterAngularThresholdRad = 0.01,
    private readonly storageFormat: CloudOpticalVolumeStorageFormat = 'rg32f',
  ) {
    requireFinite(rebuildIntervalSeconds, 'rebuildIntervalSeconds');
    if (rebuildIntervalSeconds <= 0) {
      throw new RangeError('rebuildIntervalSeconds must be positive');
    }
    requireFinite(recenterAngularThresholdRad, 'recenterAngularThresholdRad');
    if (recenterAngularThresholdRad <= 0 || recenterAngularThresholdRad >= Math.PI / 2) {
      throw new RangeError('recenterAngularThresholdRad must be between zero and π/2');
    }
    if (storageFormat !== 'rg32f' && storageFormat !== 'rg16f') {
      throw new RangeError('unsupported local field storage format');
    }
  }

  // 現在の有効 binding。未構築・供給源なしでは null。
  public get binding(): CloudLocalFieldBinding | null {
    return this.current?.binding ?? null;
  }

  // 未構築・前回の構築から interval 以上経過・中心方向が閾値以上移動のいずれかで再焼する。
  // 導出が null または例外で失敗したときは現行の binding を保ち、次の呼び出しで再試行する
  // — 例外は握り潰して null と同じ失敗として扱い、毎フレーム投げ続けない。
  public maybeRebuild(displayTimeSeconds: number, centerDirection: Vec3): void {
    requireFinite(displayTimeSeconds, 'displayTimeSeconds');
    requireUnitVector(centerDirection, 'centerDirection');
    const supply = this.supply;
    if (supply === null || !this.needsRebuild(displayTimeSeconds, centerDirection)) return;
    const result = tryDerive(supply, displayTimeSeconds, centerDirection);
    if (result === null) return;
    const volume = new CloudOpticalVolume(result.data, { storageFormat: this.storageFormat });
    this.retainedVolume?.dispose();
    this.retainedVolume = this.current?.volume ?? null;
    this.current = {
      volume,
      binding: { texture: volume.texture, frame: result.frame },
    };
    this.builtAt = { timeSeconds: displayTimeSeconds, centerDirection };
  }

  // 現行と保持分の体積を解放する。
  public dispose(): void {
    this.retainedVolume?.dispose();
    this.retainedVolume = null;
    this.current?.volume.dispose();
    this.current = null;
  }

  private needsRebuild(displayTimeSeconds: number, centerDirection: Vec3): boolean {
    if (this.builtAt === null) return true;
    // 時刻は前後どちらへジャンプしても焼き直す — 表示時刻より先に焼いた場を残さない。
    return Math.abs(displayTimeSeconds - this.builtAt.timeSeconds) >= this.rebuildIntervalSeconds
      || angularDistanceRad(this.builtAt.centerDirection, centerDirection)
        >= this.recenterAngularThresholdRad;
  }
}

// 導出と frame の検査をまとめて失敗扱いにする。焼いた結果が frame の契約を外していても、
// 毎フレーム投げる代わりに現行場を保って次へ進む。
function tryDerive(
  supply: CloudLocalFieldSupply, displayTimeSeconds: number, centerDirection: Vec3,
): CloudLocalFieldSupplyResult | null {
  try {
    const result = supply.derive(displayTimeSeconds, centerDirection);
    if (result === null) return null;
    validateCloudLocalFieldFrame(result.frame);
    return result;
  } catch {
    return null;
  }
}
