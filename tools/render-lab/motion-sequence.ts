// 動く絵の道具。カメラを 1 フレームずつ動かしながら描き、フレームごとに全体の絵と近傍拡散補正の最後の拡大の出力を撮って、
// 同じ表面の点の補正の、隣り合うフレームの差を参照の再投影で測る。補正は、そのフレームの 1 パスの列と、そのフレームを
// 位相の列で描き直した平均の列を並べて撮れる。
import * as THREE from 'three/webgpu';
import { VIEW_HEIGHT } from './lab-case';
import {
  differenceSummaryOf, reprojectedDifference, reprojectedPixels, type DifferenceSummary,
} from './reference-reprojection';
import type { CorrectionPhase } from './phase-sequence';
import type { FloatImage, LabView } from './lab';
import type { LightAngleShift } from './view-angles';

// 補正の差を、補正と同じ符号付きの表示へ写すときに掛ける倍率。
const DIFFERENCE_DISPLAY_GAIN = 4;

// そのフレームの 1 パスの補正の列の名前。
export const SINGLE_COLUMN = 'single';

// 位相の列 phases で描き直した平均の補正の列。name は SINGLE_COLUMN 以外。
export interface MotionColumn {
  readonly name: string;
  readonly phases: readonly CorrectionPhase[];
}

// 1 フレームで撮った補正の 1 列。PNG はデータ URL で、補正と差は符号付きの表示(差は DIFFERENCE_DISPLAY_GAIN 倍)。差と
// その要約は、前のフレームに同じ列が無ければ null。要約の尺度は、アルベド 1 の面の表示の尺度 q = 露出係数·ΔE/π。
export interface MotionColumnRecord {
  readonly correction: string;
  readonly difference: string | null;
  readonly summary: DifferenceSummary | null;
}

// 1 フレームで撮ったもの。capture は全体の絵の PNG のデータ URL、columns は列の名前ごと(SINGLE_COLUMN を含む)。
export interface MotionFrameRecord {
  readonly capture: string;
  readonly columns: Readonly<Record<string, MotionColumnRecord>>;
}

// 前のフレームのうち、次のフレームとの差に要るもの。
interface PreviousFrame {
  readonly depth: FloatImage;
  readonly camera: THREE.Camera;
  readonly corrections: ReadonlyMap<string, FloatImage>;
}

export class MotionSequence {
  // 直前に撮ったフレーム。列の最初では null。
  private previous: PreviousFrame | null = null;
  // 次に撮るフレームの論理フレーム。
  private frameNumber = 0;

  public constructor(private readonly view: LabView) {}

  // 列を終える。前のフレームを捨て、カメラと光源に重ねた動きを外して、番号 0 で履歴を切って描き直す。
  public reset(): void {
    this.previous = null;
    this.view.setCameraShift(null);
    this.view.setLightShift({});
    this.frameNumber = 0;
    this.view.setFrame(this.frameNumber, Number.POSITIVE_INFINITY);
  }

  // 次に描くフレームから、cameraShiftOf の姿勢をカメラへ重ねる。
  public moveCamera(
    translationPx: readonly [number, number], rotationPx: readonly [number, number], orbitPx: readonly [number, number],
  ): void {
    this.view.setCameraShift(cameraShiftOf(this.view, translationPx, rotationPx, orbitPx));
  }

  // 次に描くフレームから、光源の置き方のつまみへ shift を重ねる。
  public moveLight(shift: LightAngleShift): void {
    this.view.setLightShift(shift);
  }

  // いまのカメラで 1 フレーム描いて撮り、前のフレームからの補正の差を測る。columns を渡すと、それぞれの位相の列で描き直した
  // 平均の列も撮る。
  public async frame(columns: readonly MotionColumn[]): Promise<MotionFrameRecord> {
    const frame = this.frameNumber;
    this.view.setFrame(frame, frame === 0 ? Number.POSITIVE_INFINITY : 0);
    // 平均の列は補正を描き直すので、そのフレームの 1 パスの補正・深度・カメラを先に読む。
    const capture = await this.view.captureSettled('motion frame');
    const corrections = new Map<string, FloatImage>([[SINGLE_COLUMN, await this.view.readFloat('upsampled-correction')]]);
    const depth = await this.view.readFloat('depth');
    const camera = this.view.camera.clone();
    for (const { name, phases } of columns) {
      if (name === SINGLE_COLUMN) throw new RangeError(`render-lab: the column name ${SINGLE_COLUMN} is the single pass`);
      corrections.set(name, await this.view.averageCorrection(phases));
    }

    // 列ごとに、前のフレームの同じ列を同じ表面の点で引いた差と、その要約。
    const previous = this.previous;
    const reprojected = previous === null ? null : reprojectedPixels(depth, camera, previous.depth, previous.camera);
    let surfaceCount = 0;
    for (let p = 0; p < depth.width * depth.height; p++) if (depth.rgba[4 * p]! > 0) surfaceCount++;
    const scale = this.view.exposureFactor / Math.PI;
    const records: Record<string, MotionColumnRecord> = {};
    for (const [column, correction] of corrections) {
      const before = previous?.corrections.get(column);
      const difference = reprojected === null || before === undefined
        ? null : reprojectedDifference(correction, before, reprojected);
      records[column] = {
        correction: await this.view.signedCorrectionPng(correction),
        difference: difference === null ? null : await this.view.signedCorrectionPng(amplified(difference)),
        summary: difference === null ? null : differenceSummaryOf(difference, correction, surfaceCount, scale),
      };
    }
    this.previous = { depth, camera, corrections };
    this.frameNumber++;
    return { capture, columns: records };
  }
}

// 観察の向きで置いたカメラへ、周回の中心を中心とする回転(周回)orbitPx、並進 translationPx、カメラを中心とする回転
// rotationPx [描画バッファの画素] をこの順に重ねる姿勢を返す。並進は周回の中心の深さの点が、周回と回転は無限遠の点が、
// 画面の上でその向きと量だけ動くもので、x は右、y は上が正。周回では、周回の中心が画面の中心に留まる。
export function cameraShiftOf(
  view: Pick<LabView, 'cameraFovDeg' | 'cameraDistance'>,
  translationPx: readonly [number, number], rotationPx: readonly [number, number], orbitPx: readonly [number, number],
): THREE.Matrix4 {
  const focalPx = VIEW_HEIGHT / 2 / Math.tan(THREE.MathUtils.degToRad(view.cameraFovDeg) / 2);
  const distance = view.cameraDistance;
  // 物が画面の右へ動くのはカメラが左へ動くとき。
  const translation = new THREE.Vector3(-translationPx[0], -translationPx[1], 0).multiplyScalar(distance / focalPx);
  // 周回の中心はカメラの座標で (0, 0, −距離)。そこを中心に回すと、カメラの位置と向きが同じ回転で回る。
  const pivot = new THREE.Vector3(0, 0, -distance);
  const orbit = new THREE.Matrix4().makeTranslation(pivot)
    .multiply(new THREE.Matrix4().makeRotationFromQuaternion(rotationOf(orbitPx, focalPx)))
    .multiply(new THREE.Matrix4().makeTranslation(pivot.clone().negate()));
  const rest = new THREE.Matrix4().compose(translation, rotationOf(rotationPx, focalPx), new THREE.Vector3(1, 1, 1));
  return orbit.multiply(rest);
}

// 焦点距離 focalPx [描画バッファの画素] のカメラで、無限遠の点を画面の上で movePx [描画バッファの画素](x は右、y は上)だけ
// 動かす、カメラの座標の回転。画面が右へ動くのはカメラが左を向く(+Y まわりの正の回転)とき、上へ動くのは下を向く
// (+X まわりの負の回転)とき。
function rotationOf(movePx: readonly [number, number], focalPx: number): THREE.Quaternion {
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(
    -Math.atan(movePx[1] / focalPx), Math.atan(movePx[0] / focalPx), 0, 'YXZ'));
}

// 差 difference の rgb を DIFFERENCE_DISPLAY_GAIN 倍した写し。
function amplified(difference: FloatImage): FloatImage {
  const rgba = difference.rgba.map((v, i) => (i % 4 === 3 ? v : DIFFERENCE_DISPLAY_GAIN * v));
  return { ...difference, rgba };
}
