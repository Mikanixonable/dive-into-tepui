// 装置が毎フレーム受け取る、マーカー1件ぶんの宣言。cls は DOM へそのまま貼る文字列で、
// 装置はその中身を解釈しない。種別の意味から装置の語彙へ写すのは宣言を組む側が行う。

export interface MarkerDeclaration {
  // 群をまたいで一意な識別子。DOM 要素の同一性と、表示したかの問い合わせに使う。
  readonly id: string;
  // 要素へ貼る CSS クラス。要素を作るときに一度だけ貼る。
  readonly cls: string;
  // シンボルの字形。markup を立てると HTML として書き込む。
  readonly sym: string;
  readonly markup?: boolean;
  // シンボル中心の画面座標 [px]。
  readonly x: number;
  readonly y: number;
  // 画面の手前にあるか。false のフレームは要素を残したまま伏せる。
  readonly front: boolean;
  readonly label?: string;
  readonly opacity?: number;
  // 要素の色。省略すると cls の CSS が決める色になる。
  readonly color?: string;
  // シンボルの回転 [deg]。省略すると直前のフレームの角度を保つ。
  readonly rotationDeg?: number;
  // ラベルを既定位置へ固定し、押し出しの対象から外すか。
  readonly fixedLabel?: boolean;
  // 重なったときに残す度合い。大きいほど残る。
  readonly priority: number;
  // 視点からの距離。持たない宣言は奥行きの比較に加わらない。
  readonly dist?: number;
  // 遮蔽で畳むか。立て続けているあいだに透明になり、そのまま伏せる。
  readonly occluded?: boolean;
  // 混雑したときにアイコンを消してよいか。既定は消してよい。
  readonly iconHidable?: boolean;
  // 近接まとめでアイコンの扱いが既に決まっている宣言か。既定は決まっていない。
  readonly clustered?: boolean;
}
