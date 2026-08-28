// =============================================================================
// JPEG の EXIF orientation 読み取り（純 TS・DOM 非依存）。
//
// 用途: エクスポート時、orientation ≠ 1 の JPEG は「ブラウザで表示していた向き」と
// ファイル内のピクセル配置が食い違う。アノテーション座標は表示された向き
// （naturalWidth/Height 基準 = EXIF 適用後）で保存されているため、そのままコピーすると
// 学習側で座標がズレる。≠1 の画像だけ runner が再エンコードして正規化する。
// orientation 1 / EXIF 無しはバイト無変換コピーで良い（再エンコード劣化を避ける）。
//
// 方針: **どんな壊れたバイト列でも例外を投げず 1 を返す**（エクスポートは
// 全画像を回すバッチ処理であり、1枚の破損で全体が落ちてはいけない）。
// =============================================================================

/** JPEG バイト列の EXIF orientation（1..8）。EXIF 無し・非 JPEG・破損は 1 */
export function readJpegOrientation(bytes: Uint8Array): number {
  try {
    return parseOrientation(bytes);
  } catch {
    return 1;
  }
}

function parseOrientation(bytes: Uint8Array): number {
  // SOI
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return 1;

  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      // マーカー境界がずれている（破損）。1 バイトずつ再同期する
      offset++;
      continue;
    }
    // 0xFF の連続はフィルバイト
    let markerAt = offset + 1;
    while (markerAt < bytes.length && bytes[markerAt] === 0xff) markerAt++;
    if (markerAt >= bytes.length) return 1;
    const marker = bytes[markerAt];

    // 長さフィールドを持たないスタンドアロンマーカー（TEM / RSTn）
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset = markerAt + 1;
      continue;
    }
    // SOS 以降は圧縮データ、EOI は終端。ここまでに APP1 が無ければ EXIF 無し
    if (marker === 0xda || marker === 0xd9) return 1;

    if (markerAt + 3 >= bytes.length) return 1;
    const size = (bytes[markerAt + 1] << 8) | bytes[markerAt + 2];
    if (size < 2) return 1; // 破損（長さフィールドは自身の 2 バイトを含む）
    const segStart = markerAt + 3;
    const segEnd = markerAt + 1 + size;
    if (segEnd > bytes.length) return 1;

    if (marker === 0xe1 && isExifHeader(bytes, segStart, segEnd)) {
      const o = readTiffOrientation(bytes, segStart + 6, segEnd);
      return o >= 1 && o <= 8 ? o : 1;
    }
    offset = segEnd;
  }
  return 1;
}

/** APP1 セグメント先頭が "Exif\0\0" か */
function isExifHeader(b: Uint8Array, start: number, end: number): boolean {
  return (
    end - start >= 6 &&
    b[start] === 0x45 && // E
    b[start + 1] === 0x78 && // x
    b[start + 2] === 0x69 && // i
    b[start + 3] === 0x66 && // f
    b[start + 4] === 0x00 &&
    b[start + 5] === 0x00
  );
}

/** TIFF ヘッダ（II/MM 両対応）→ IFD0 の tag 0x0112 を読む。読めなければ 0 */
function readTiffOrientation(b: Uint8Array, tiff: number, end: number): number {
  if (tiff + 8 > end) return 0;
  let little: boolean;
  if (b[tiff] === 0x49 && b[tiff + 1] === 0x49) little = true;
  else if (b[tiff] === 0x4d && b[tiff + 1] === 0x4d) little = false;
  else return 0;

  const u16 = (p: number): number =>
    little ? b[p] | (b[p + 1] << 8) : (b[p] << 8) | b[p + 1];
  const u32 = (p: number): number =>
    little
      ? (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0
      : (((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0);

  if (u16(tiff + 2) !== 42) return 0; // TIFF マジック
  const ifd0 = tiff + u32(tiff + 4);
  if (ifd0 + 2 > end || ifd0 < tiff) return 0;

  const count = u16(ifd0);
  // 1 エントリ 12 バイト。件数が領域を超えるものは破損として弾く
  if (ifd0 + 2 + count * 12 > end) return 0;

  for (let i = 0; i < count; i++) {
    const entry = ifd0 + 2 + i * 12;
    if (u16(entry) !== 0x0112) continue;
    const type = u16(entry + 2);
    // Orientation は SHORT(3)。念のため LONG(4) も受ける
    if (type === 3) return u16(entry + 8);
    if (type === 4) return u32(entry + 8);
    return 0;
  }
  return 0;
}
