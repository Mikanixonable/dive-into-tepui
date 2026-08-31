// 実験環境(render-lab / cloud-lab)が撮影した RGBA 画素列を PNG のデータ URL にする。
export function pixelsToPngDataUrl(pixels: Uint8Array, width: number, height: number): string {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d')!;
  context.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
  return canvas.toDataURL('image/png');
}
