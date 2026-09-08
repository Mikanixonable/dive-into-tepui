// 積雲の場を所有し、表示設定と焼成時刻を描画パイプラインへ渡す窓口。積雲そのものは G-buffer の
// 不透明メッシュとしては描かない。視線・大気散乱・太陽光路が同じ密度場を積分するため、ここには
// 雲頂交差探索、深度・法線ノード、固定半径の積雲シェルを置かない。
import type { Texture, WebGPURenderer } from 'three/webgpu';
import { GeneratedCloudField } from './cloud/generated-cloud-field';
import { CLOUD_TOP_SPAN } from './cloud/cumulus-shape';

// 積雲の精細さの段。値は保存された設定を読む鍵なので、既存の番号を変えない。
export const CUMULUS_DETAIL = { off: 0, coarse: 1, standard: 2, fine: 3 } as const;
export type CumulusDetail = (typeof CUMULUS_DETAIL)[keyof typeof CUMULUS_DETAIL];

export class CumulusShell {
  private readonly cloudField: GeneratedCloudField;
  private detail: CumulusDetail = CUMULUS_DETAIL.standard;
  private cloudVisible = false;
  private cirrusVisible = true;
  private volumeVisible = true;

  // cloudField は表示時刻へ焼く2D雲場を所有し、各描画経路へ同じテクスチャを公開する。
  public constructor(cloudField: GeneratedCloudField) {
    this.cloudField = cloudField;
  }

  // 雲場のテクスチャ。解放までこの窓口が所有する。
  public get field(): Texture { return this.cloudField.texture; }

  // 不透明 G-buffer 面の代わりに、積雲の密度と影を有効にする設定があるか。
  public get visible(): boolean {
    return this.cloudVisible && this.detail !== CUMULUS_DETAIL.off;
  }

  public get cloudsVisible(): boolean { return this.cloudVisible; }

  // 密度場が大気または影から参照されるか。
  public get fieldContributes(): boolean {
    return this.cloudVisible && (this.cirrusVisible || this.volumeVisible);
  }

  public get atmosphereVisible(): boolean { return this.fieldContributes; }

  // 雲頂の最大高度 [m]。密度場の G はこの尺度で正規化されている。
  public get topAltitude(): number { return CLOUD_TOP_SPAN; }

  // 雲場を読む GPU パスがあるフレームだけ、表示時刻の雲を焼く。
  public bake(renderer: WebGPURenderer, displayTime: number): void {
    if (!this.fieldContributes) return;
    this.cloudField.bake(renderer, displayTime);
  }

  // 積雲の表示品質を置き直す。off では積雲の影も無効になる。
  public setDetail(detail: CumulusDetail): void {
    this.detail = detail;
  }

  // 雲場を読む描画経路の有効状態を置き直す。
  public setCloudsVisible(visible: boolean): void {
    this.cloudVisible = visible;
  }

  // cirrus は従来どおり薄い固定層、translucentCumulus は新しい積雲ボリュームの表示可否を表す。
  public setAtmosphereCloudsVisible(cirrusVisible: boolean, translucentCumulusVisible: boolean): void {
    this.cirrusVisible = cirrusVisible;
    this.volumeVisible = translucentCumulusVisible;
  }

  // 雲場を読む経路を一時的に無効にする。
  public hide(): void {
    this.cloudVisible = false;
  }

  // 雲場の GPU 資源を解放する。
  public dispose(): void {
    this.cloudField.dispose();
  }
}
