// 動く絵の道具。カメラを 1 フレームずつ動かしながら描き、フレームごとに全体の絵と近傍拡散補正の最後の拡大の出力を撮って、
// 同じ表面の点の補正の、隣り合うフレームの差を参照の再投影で測る。補正は、そのフレームの 1 パスの列と、そのフレームの
// G バッファのまま seed の列で描き直した平均の列を並べて撮れる。
import * as THREE from 'three/webgpu';
import { VIEW_HEIGHT } from './lab-case';
import {
  differenceSummaryOf, reprojectedDifference, reprojectedPixels, type DifferenceSummary,
} from './reference-reprojection';
import type { FloatImage, LabView } from './lab';

// 補正の差を、補正と同じ符号付きの表示へ写すときに掛ける倍率。
const DIFFERENCE_DISPLAY_GAIN = 4;

// 撮る補正の列。single はそのフレームの 1 パス、averaged は seed の列の平均。
type CorrectionColumn = 'single' | 'averaged';

// 1 フレームで撮った補正の 1 列。PNG はデータ URL で、補正と差は符号付きの表示(差は DIFFERENCE_DISPLAY_GAIN 倍)。差と
// その要約は、前のフレームに同じ列が無ければ null。要約の尺度は、アルベド 1 の面の表示の尺度 q = 露出係数·ΔE/π。
export interface MotionColumnRecord {
  readonly correction: string;
  readonly difference: string | null;
  readonly summary: DifferenceSummary | null;
}

// 1 フレームで撮ったもの。capture は全体の絵の PNG のデータ URL。
export interface MotionFrameRecord {
  readonly capture: string;
  readonly columns: Readonly<Partial<Record<CorrectionColumn, MotionColumnRecord>>>;
}

// 前のフレームのうち、次のフレームとの差に要るもの。
interface PreviousFrame {
  readonly depth: FloatImage;
  readonly camera: THREE.Camera;
  readonly corrections: Readonly<Partial<Record<CorrectionColumn, FloatImage>>>;
}

export class MotionSequence {
  private previous: PreviousFrame | null = null;

  public constructor(private readonly view: LabView) {}

  // 列を終える。前のフレームを捨て、カメラに重ねた動きを外す。
  public reset(): void {
    this.previous = null;
    this.view.setCameraShift(null);
  }

  // 次に描くフレームから、観察の向きで置いたカメラへ、並進 translationPx と回転 rotationPx [描画バッファの画素] を重ねる。
  // 並進は周回の中心の深さの点が、回転は画面の中心が、画面の上でその向きと量だけ動くもので、x は右、y は上が正。
  public moveCamera(translationPx: readonly [number, number], rotationPx: readonly [number, number]): void {
    const focalPx = VIEW_HEIGHT / 2 / Math.tan(THREE.MathUtils.degToRad(this.view.cameraFovDeg) / 2);
    const metersPerPx = this.view.cameraDistance / focalPx;
    // 物が画面の右へ動くのはカメラが左へ動くとき。画面が右へ動くのはカメラが左を向く(+Y まわりの正の回転)とき、上へ
    // 動くのは下を向く(+X まわりの負の回転)とき。
    const translation = new THREE.Vector3(-translationPx[0] * metersPerPx, -translationPx[1] * metersPerPx, 0);
    const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(
      -Math.atan(rotationPx[1] / focalPx), Math.atan(rotationPx[0] / focalPx), 0, 'YXZ'));
    this.view.setCameraShift(new THREE.Matrix4().compose(translation, rotation, new THREE.Vector3(1, 1, 1)));
  }

  // いまのカメラで 1 フレーム描いて撮り、前のフレームからの補正の差を測る。averagedSeeds [タイルの幅] を渡すと、平均の列も
  // 撮る(終わると seed は列の最後のもの)。
  public async frame(averagedSeeds: readonly (readonly [number, number])[] | null): Promise<MotionFrameRecord> {
    // 平均の列は補正を描き直すので、そのフレームの 1 パスの補正を先に読む。
    const capture = await this.view.captureSettled('motion frame');
    const corrections: Partial<Record<CorrectionColumn, FloatImage>> = { single: await this.view.readFloat('correction') };
    const depth = await this.view.readFloat('depth');
    const camera = this.view.camera.clone();
    if (averagedSeeds !== null) corrections.averaged = await this.view.averageCorrection(averagedSeeds);

    // 列ごとに、前のフレームの同じ列を同じ表面の点で引いた差と、その要約。
    const previous = this.previous;
    const reprojected = previous === null ? null : reprojectedPixels(depth, camera, previous.depth, previous.camera);
    let surfaceCount = 0;
    for (let p = 0; p < depth.width * depth.height; p++) if (depth.rgba[4 * p]! > 0) surfaceCount++;
    const scale = this.view.exposureFactor / Math.PI;
    const columns: Partial<Record<CorrectionColumn, MotionColumnRecord>> = {};
    for (const [column, correction] of Object.entries(corrections) as [CorrectionColumn, FloatImage][]) {
      const before = previous?.corrections[column];
      const difference = reprojected === null || before === undefined
        ? null : reprojectedDifference(correction, before, reprojected);
      columns[column] = {
        correction: await this.view.signedCorrectionPng(correction),
        difference: difference === null ? null : await this.view.signedCorrectionPng(amplified(difference)),
        summary: difference === null ? null : differenceSummaryOf(difference, correction, surfaceCount, scale),
      };
    }
    this.previous = { depth, camera, corrections };
    return { capture, columns };
  }
}

// 差 difference の rgb を DIFFERENCE_DISPLAY_GAIN 倍した写し。
function amplified(difference: FloatImage): FloatImage {
  const rgba = difference.rgba.map((v, i) => (i % 4 === 3 ? v : DIFFERENCE_DISPLAY_GAIN * v));
  return { ...difference, rgba };
}
