// マーカーが画面に出ているかどうかの問い合わせ口。
export interface MarkerVisibility {
  // そのキーのマーカーを直前のフレームで画面へ出したか。遮蔽で薄れている途中も出していない扱い。
  shows(key: string): boolean;
}
