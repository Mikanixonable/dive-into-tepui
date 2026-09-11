// デコード済みの地表色画像を常駐用RGBA8へ変換する。
let earthSurfaceColorCanvas: OffscreenCanvas | null = null;

export async function earthSurfaceColorToRgba8(color: unknown): Promise<Uint8Array> {
  if (color instanceof Uint8Array) return color;
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') {
    throw new Error('Earth surface color conversion is unavailable');
  }
  if (!(color instanceof ImageBitmap)) throw new Error('Earth surface color is not an ImageBitmap');
  const canvas = earthSurfaceColorCanvas ?? new OffscreenCanvas(color.width, color.height);
  earthSurfaceColorCanvas = canvas;
  if (canvas.width !== color.width) canvas.width = color.width;
  if (canvas.height !== color.height) canvas.height = color.height;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('Earth surface 2D canvas is unavailable');
  context.drawImage(color, 0, 0);
  return new Uint8Array(context.getImageData(0, 0, color.width, color.height).data);
}
