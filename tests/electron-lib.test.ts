/// <reference types="node" />
// =============================================================================
// M3（Electron 統合）の純ロジック検証。
//   electron/lib/* は fs / electron API に依存しない（atomicWrite のみ fs 依存だが
//   実 tmpdir で検証できる）ため、Electron を起動せずにここでテストできる。
//
// 重点はパス検証（レンダラ侵害時の最後の砦）。攻撃ケースを網羅的に落とす。
// =============================================================================

import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  atomicCopyFile,
  atomicWriteFile,
  backupExisting,
  isDirectory,
  pathExists,
  preserveBeforeOverwrite,
  writeFileWithBackup,
  writeJsonWithBackup,
} from '../electron/lib/atomicWrite';
import { pendingLockCount, withFileLock } from '../electron/lib/fileLock';
import {
  SymlinkRejectedError,
  isRealPathInside,
  isSymbolicLink,
  resolveDestPathNoSymlink,
  statRegularFile,
} from '../electron/lib/safeFs';
import {
  INITIAL_PROGRESS_STATE,
  buildFfmpegArgs,
  buildScaleFilter,
  escapeFilterValue,
  feedFfmpegProgress,
  normalizeVideoParams,
} from '../electron/lib/ffmpegArgs';
import {
  compareNatural,
  filterAndSortImageNames,
  isImageFileName,
} from '../electron/lib/naturalSort';
import {
  buildAnnoImageUrl,
  isPathInside,
  isSafeFileName,
  isWindowsReservedName,
  parseAnnoImageUrl,
  safeDestPath,
  safeDestSegments,
  safeJoin,
} from '../electron/lib/pathGuard';
import { summarizeSidecar } from '../electron/lib/sidecarSummary';
import type { VideoExtractParams } from '../src/core/types';

// ---------------------------------------------------------------------------
// pathGuard: ファイル名検証
// ---------------------------------------------------------------------------

describe('isSafeFileName', () => {
  it('通常のファイル名（日本語・空白・記号込み）は許可する', () => {
    for (const name of [
      'IMG_0001.jpg',
      'frame_000123.png',
      '現場写真 001.JPG',
      'a-b_c.d.webp',
      "it's a photo.png",
      'ひび割れ（北面）.bmp',
    ]) {
      expect(isSafeFileName(name)).toBe(true);
    }
  });

  it('パス区切りを含む名前を拒否する', () => {
    for (const name of ['a/b.jpg', 'a\\b.jpg', '/etc/passwd', 'C:\\Windows\\x.jpg', 'sub/../x.jpg']) {
      expect(isSafeFileName(name)).toBe(false);
    }
  });

  it("'..' / '.' / 空文字を拒否する", () => {
    for (const name of ['..', '.', '']) {
      expect(isSafeFileName(name)).toBe(false);
    }
  });

  it('NUL・制御文字を含む名前を拒否する', () => {
    expect(isSafeFileName('a\0.jpg')).toBe(false);
    expect(isSafeFileName('\0')).toBe(false);
    expect(isSafeFileName('a\nb.jpg')).toBe(false);
    expect(isSafeFileName('a\tb.jpg')).toBe(false);
    expect(isSafeFileName('a\x7fb.jpg')).toBe(false);
  });

  it("':' を含む名前を拒否する（Windows のドライブ相対・NTFS 代替データストリーム対策）", () => {
    expect(isSafeFileName('C:foo.jpg')).toBe(false);
    expect(isSafeFileName('photo.jpg:hidden')).toBe(false);
  });

  it('末尾のドット・空白を拒否する（Windows が暗黙に切り詰めるため）', () => {
    expect(isSafeFileName('photo.jpg.')).toBe(false);
    expect(isSafeFileName('photo.jpg ')).toBe(false);
  });

  it('Windows 予約デバイス名を拒否する（拡張子付き・大文字小文字を問わない）', () => {
    const reserved = [
      'CON',
      'con',
      'Con.jpg',
      'PRN',
      'AUX',
      'NUL',
      'nul.json',
      'COM1',
      'com9.png',
      'LPT1',
      'lpt9.jpg.json',
    ];
    for (const name of reserved) {
      expect(isWindowsReservedName(name), name).toBe(true);
      expect(isSafeFileName(name), name).toBe(false);
    }
  });

  it('予約名に似ているだけの通常ファイル名は許可する', () => {
    const ok = ['CONSOLE.jpg', 'console.png', 'com.jpg', 'COM10.jpg', 'LPT0.jpg', 'NULL.json', 'my-con.jpg'];
    for (const name of ok) {
      expect(isWindowsReservedName(name), name).toBe(false);
      expect(isSafeFileName(name), name).toBe(true);
    }
  });

  it('文字列以外・長すぎる名前を拒否する', () => {
    expect(isSafeFileName(null)).toBe(false);
    expect(isSafeFileName(undefined)).toBe(false);
    expect(isSafeFileName(42)).toBe(false);
    expect(isSafeFileName({})).toBe(false);
    expect(isSafeFileName('a'.repeat(256))).toBe(false);
    expect(isSafeFileName('a'.repeat(255))).toBe(true);
  });

  it('URL エンコードされた攻撃文字列はデコード後に拒否される', () => {
    expect(isSafeFileName(decodeURIComponent('%2e%2e'))).toBe(false);
    expect(isSafeFileName(decodeURIComponent('%2e%2e%2fetc%2fpasswd'))).toBe(false);
    expect(isSafeFileName(decodeURIComponent('%2fetc%2fpasswd'))).toBe(false);
    expect(isSafeFileName(decodeURIComponent('a%00.jpg'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// pathGuard: safeJoin
// ---------------------------------------------------------------------------

describe('safeJoin', () => {
  const dir = path.resolve('/tmp/genba-anno-test');

  it('正常なファイル名は dir 直下の絶対パスを返す', () => {
    expect(safeJoin(dir, 'IMG_0001.jpg')).toBe(path.join(dir, 'IMG_0001.jpg'));
  });

  it('トラバーサルを拒否する', () => {
    for (const attack of [
      '../x.jpg',
      '../../etc/passwd',
      'a/../../b.jpg',
      './x.jpg',
      '..',
      '/etc/passwd',
      'sub/x.jpg',
      'sub\\x.jpg',
    ]) {
      expect(safeJoin(dir, attack)).toBeNull();
    }
  });

  it('dir が空・NUL 入りなら拒否する', () => {
    expect(safeJoin('', 'a.jpg')).toBeNull();
    expect(safeJoin('/tmp/a\0b', 'a.jpg')).toBeNull();
  });

  it('結合結果は必ず dir 配下になる', () => {
    const joined = safeJoin(dir, '現場 写真.jpg');
    expect(joined).not.toBeNull();
    expect(isPathInside(dir, joined as string)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// pathGuard: isPathInside
// ---------------------------------------------------------------------------

describe('isPathInside', () => {
  it('配下は true・外は false', () => {
    expect(isPathInside('/a/b', '/a/b/c')).toBe(true);
    expect(isPathInside('/a/b', '/a/b/c/d/e.txt')).toBe(true);
    expect(isPathInside('/a/b', '/a/c')).toBe(false);
    expect(isPathInside('/a/b', '/a')).toBe(false);
    expect(isPathInside('/a/b', '/')).toBe(false);
  });

  it('同一パスは allowEqual のときだけ true', () => {
    expect(isPathInside('/a/b', '/a/b')).toBe(false);
    expect(isPathInside('/a/b', '/a/b', { allowEqual: true })).toBe(true);
  });

  it('接頭辞が一致するだけの兄弟ディレクトリは false', () => {
    expect(isPathInside('/a/b', '/a/bb')).toBe(false);
    expect(isPathInside('/a/b', '/a/b-2/x')).toBe(false);
  });

  it("'..' から始まる名前の子ディレクトリを誤って弾かない", () => {
    expect(isPathInside('/a', '/a/..foo')).toBe(true);
    expect(isPathInside('/a', '/a/../foo')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// pathGuard: safeDestPath（エクスポート出力先）
// ---------------------------------------------------------------------------

describe('safeDestPath', () => {
  const dest = path.resolve('/tmp/genba-anno-export');

  it('正常な相対パスを解決する', () => {
    expect(safeDestPath(dest, 'labels/train/IMG_0001.txt')).toBe(
      path.join(dest, 'labels', 'train', 'IMG_0001.txt'),
    );
    expect(safeDestPath(dest, 'data.yaml')).toBe(path.join(dest, 'data.yaml'));
  });

  it('絶対パスを拒否する（POSIX / Windows ドライブ / UNC）', () => {
    for (const attack of ['/etc/passwd', '\\\\server\\share\\x', 'C:\\Windows\\x', 'D:/x/y']) {
      expect(safeDestPath(dest, attack)).toBeNull();
    }
  });

  it("'..' によるトラバーサルを拒否する", () => {
    for (const attack of [
      '../x',
      '../../etc/passwd',
      'a/../../b',
      'a/b/../../../c',
      'labels/../../escape.txt',
      '..\\..\\x',
      'a/./b',
      '..',
    ]) {
      expect(safeDestPath(dest, attack)).toBeNull();
    }
  });

  it('URL エンコード済み文字列はデコード後に拒否される', () => {
    expect(safeDestPath(dest, decodeURIComponent('%2e%2e%2fx'))).toBeNull();
    expect(safeDestPath(dest, decodeURIComponent('a%2f%2e%2e%2f%2e%2e%2fb'))).toBeNull();
  });

  it('空文字・NUL・空セグメント・末尾区切りを拒否する', () => {
    expect(safeDestPath(dest, '')).toBeNull();
    expect(safeDestPath(dest, 'a\0b')).toBeNull();
    expect(safeDestPath(dest, 'a//b')).toBeNull();
    expect(safeDestPath(dest, 'a/b/')).toBeNull();
    expect(safeDestPath(dest, '/')).toBeNull();
  });

  it('文字列以外・長すぎる値を拒否する', () => {
    expect(safeDestPath(dest, null)).toBeNull();
    expect(safeDestPath(dest, 123)).toBeNull();
    expect(safeDestPath(dest, `${'a/'.repeat(600)}x`)).toBeNull();
  });

  it('解決結果は必ず destDir 配下', () => {
    const resolved = safeDestPath(dest, 'images/train/現場 001.jpg');
    expect(resolved).not.toBeNull();
    expect(isPathInside(dest, resolved as string)).toBe(true);
  });

  it('Windows 予約デバイス名を含むセグメントを拒否する', () => {
    expect(safeDestPath(dest, 'images/CON/x.jpg')).toBeNull();
    expect(safeDestPath(dest, 'labels/train/nul.txt')).toBeNull();
    expect(safeDestPath(dest, 'COM1')).toBeNull();
    expect(safeDestPath(dest, 'images/console/ok.jpg')).not.toBeNull();
  });

  it('safeDestSegments は検証済みセグメント列を返す（1段ずつ降りる用）', () => {
    expect(safeDestSegments(dest, 'images/train/a.jpg')).toEqual(['images', 'train', 'a.jpg']);
    expect(safeDestSegments(dest, 'data.yaml')).toEqual(['data.yaml']);
    expect(safeDestSegments(dest, '../x')).toBeNull();
    expect(safeDestSegments(dest, '/abs/x')).toBeNull();
    expect(safeDestSegments(dest, 'a//b')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// pathGuard: anno:// URL
// ---------------------------------------------------------------------------

describe('parseAnnoImageUrl', () => {
  it('組み立てた URL を元の dir / file に戻せる', () => {
    const dir = '/Users/現場/写真 2026';
    const file = 'IMG_0001.jpg';
    const parsed = parseAnnoImageUrl(buildAnnoImageUrl(dir, file));
    expect(parsed).toEqual({ dir, file });
  });

  it('Windows パスも往復できる', () => {
    const dir = 'C:\\Users\\genba\\写真';
    const parsed = parseAnnoImageUrl(buildAnnoImageUrl(dir, 'IMG_0002.JPG'));
    expect(parsed).toEqual({ dir, file: 'IMG_0002.JPG' });
  });

  it('スキーム・ホストが違うものを拒否する', () => {
    expect(parseAnnoImageUrl('file:///etc/passwd')).toBeNull();
    expect(parseAnnoImageUrl('https://example.com/image/a/b')).toBeNull();
    expect(parseAnnoImageUrl('anno://other/a/b')).toBeNull();
    expect(parseAnnoImageUrl('not a url')).toBeNull();
  });

  it('セグメント数が違うものを拒否する', () => {
    expect(parseAnnoImageUrl('anno://image/onlydir')).toBeNull();
    expect(parseAnnoImageUrl('anno://image/a/b/c')).toBeNull();
    expect(parseAnnoImageUrl('anno://image//b')).toBeNull();
    expect(parseAnnoImageUrl('anno://image/a/')).toBeNull();
  });

  it('ファイル名がトラバーサルなら拒否する', () => {
    expect(parseAnnoImageUrl(buildAnnoImageUrl('/tmp/x', '../../etc/passwd'))).toBeNull();
    expect(parseAnnoImageUrl(buildAnnoImageUrl('/tmp/x', '..'))).toBeNull();
    expect(parseAnnoImageUrl('anno://image/%2Ftmp/%2E%2E%2Fpasswd')).toBeNull();
  });

  it('クエリ・フラグメント付きを拒否する', () => {
    expect(parseAnnoImageUrl(`${buildAnnoImageUrl('/tmp/x', 'a.jpg')}?q=1`)).toBeNull();
    expect(parseAnnoImageUrl(`${buildAnnoImageUrl('/tmp/x', 'a.jpg')}#frag`)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// naturalSort
// ---------------------------------------------------------------------------

describe('naturalSort', () => {
  it('数字部分を数値として比較する', () => {
    const input = ['IMG_10.jpg', 'IMG_2.jpg', 'IMG_1.jpg', 'IMG_100.jpg', 'IMG_20.jpg'];
    expect([...input].sort(compareNatural)).toEqual([
      'IMG_1.jpg',
      'IMG_2.jpg',
      'IMG_10.jpg',
      'IMG_20.jpg',
      'IMG_100.jpg',
    ]);
  });

  it('ゼロ埋め・非ゼロ埋めが混在しても数値順', () => {
    expect(['frame_000010.png', 'frame_9.png', 'frame_000002.png'].sort(compareNatural)).toEqual([
      'frame_000002.png',
      'frame_9.png',
      'frame_000010.png',
    ]);
  });

  it('日本語ファイル名でも決定的に並ぶ', () => {
    const sorted = ['現場2.jpg', '現場10.jpg', '現場1.jpg'].sort(compareNatural);
    expect(sorted).toEqual(['現場1.jpg', '現場2.jpg', '現場10.jpg']);
  });

  it('同値のときもタイブレークして安定する（対称性）', () => {
    expect(compareNatural('a.jpg', 'a.jpg')).toBe(0);
    const c1 = compareNatural('A.jpg', 'a.jpg');
    const c2 = compareNatural('a.jpg', 'A.jpg');
    expect(c1).not.toBe(0);
    expect(Math.sign(c1)).toBe(-Math.sign(c2));
  });

  it('対応拡張子を大文字小文字無視で判定する', () => {
    for (const name of ['a.jpg', 'a.JPEG', 'a.Png', 'a.webp', 'a.BMP']) {
      expect(isImageFileName(name)).toBe(true);
    }
    for (const name of ['a.gif', 'a.tif', 'a.json', 'a', 'a.jpg.json']) {
      expect(isImageFileName(name)).toBe(false);
    }
  });

  it('ドットファイル・拡張子のみの名前を除外する', () => {
    for (const name of ['.DS_Store', '._IMG_0001.jpg', '.jpg', '.hidden.png']) {
      expect(isImageFileName(name)).toBe(false);
    }
  });

  it('filterAndSortImageNames は画像だけを自然順で返す', () => {
    expect(
      filterAndSortImageNames([
        'IMG_10.jpg',
        '.DS_Store',
        'notes.txt',
        'IMG_2.JPG',
        '_anno',
        'IMG_1.png',
      ]),
    ).toEqual(['IMG_1.png', 'IMG_2.JPG', 'IMG_10.jpg']);
  });
});

// ---------------------------------------------------------------------------
// ffmpegArgs
// ---------------------------------------------------------------------------

const baseVideoParams: VideoExtractParams = {
  videoPath: '/videos/site.mp4',
  destDir: '/out/frames',
  mode: 'fps',
  value: 2,
  format: 'jpg',
  quality: 2,
};

describe('ffmpegArgs', () => {
  it('filtergraph の区切り文字をエスケープする', () => {
    expect(escapeFilterValue('not(mod(n,5))')).toBe('not(mod(n\\,5))');
    expect(escapeFilterValue('a:b')).toBe('a\\:b');
    expect(escapeFilterValue('a\\b')).toBe('a\\\\b');
  });

  it('scale フィルタは長辺基準・アスペクト維持・偶数丸め', () => {
    expect(buildScaleFilter(1920)).toBe(
      'scale=w=if(gte(iw\\,ih)\\,min(iw\\,1920)\\,-2):h=if(gte(iw\\,ih)\\,-2\\,min(ih\\,1920))',
    );
  });

  it('fps モード: -vf fps=N（jpg は -qscale:v）', () => {
    const args = buildFfmpegArgs(baseVideoParams, '/out/frames/frame_%06d.jpg');
    expect(args).toEqual([
      '-hide_banner',
      '-nostdin',
      '-loglevel',
      'error',
      '-y',
      '-progress',
      'pipe:1',
      '-i',
      '/videos/site.mp4',
      '-vf',
      'fps=2',
      '-qscale:v',
      '2',
      '-f',
      'image2',
      '/out/frames/frame_%06d.jpg',
    ]);
  });

  it('every_n モード: select フィルタ + -fps_mode vfr（重複フレーム防止）', () => {
    const args = buildFfmpegArgs(
      { ...baseVideoParams, mode: 'every_n', value: 5, format: 'png' },
      '/out/frames/frame_%06d.png',
    );
    expect(args).toContain('-vf');
    expect(args[args.indexOf('-vf') + 1]).toBe('select=not(mod(n\\,5))');
    expect(args.join(' ')).toContain('-fps_mode vfr');
    // png は品質指定しない
    expect(args).not.toContain('-qscale:v');
  });

  it('maxLongEdge 指定時は scale をチェーンする', () => {
    const args = buildFfmpegArgs(
      { ...baseVideoParams, maxLongEdge: 1280 },
      '/out/frames/frame_%06d.jpg',
    );
    const filter = args[args.indexOf('-vf') + 1];
    expect(filter.startsWith('fps=2,scale=')).toBe(true);
    expect(filter).toContain('min(iw\\,1280)');
  });

  it('quality を 2..31 にクランプする', () => {
    expect(normalizeVideoParams({ ...baseVideoParams, quality: 0 }).quality).toBe(2);
    expect(normalizeVideoParams({ ...baseVideoParams, quality: 99 }).quality).toBe(31);
    expect(normalizeVideoParams({ ...baseVideoParams, quality: 7.4 }).quality).toBe(7);
  });

  it('every_n の値は 1 以上の整数へ丸める', () => {
    expect(normalizeVideoParams({ ...baseVideoParams, mode: 'every_n', value: 0.4 }).value).toBe(1);
    expect(normalizeVideoParams({ ...baseVideoParams, mode: 'every_n', value: 5.6 }).value).toBe(6);
  });

  it('不正なパラメータは例外', () => {
    expect(() => normalizeVideoParams({ ...baseVideoParams, value: 0 })).toThrow();
    expect(() => normalizeVideoParams({ ...baseVideoParams, value: Number.NaN })).toThrow();
    expect(() =>
      normalizeVideoParams({ ...baseVideoParams, mode: 'bogus' as 'fps' }),
    ).toThrow();
    expect(() =>
      normalizeVideoParams({ ...baseVideoParams, format: '../evil' as 'jpg' }),
    ).toThrow();
    expect(() => normalizeVideoParams({ ...baseVideoParams, maxLongEdge: 4 })).toThrow();
    expect(() => buildFfmpegArgs({ ...baseVideoParams, videoPath: '' }, '/out/x_%06d.jpg')).toThrow();
  });
});

describe('feedFfmpegProgress', () => {
  it('frame= を拾い progress=end で終了を検出する', () => {
    let state = INITIAL_PROGRESS_STATE;
    state = feedFfmpegProgress(state, 'frame=3\nfps=0.0\nprogress=continue\n');
    expect(state.framesWritten).toBe(3);
    expect(state.ended).toBe(false);

    state = feedFfmpegProgress(state, 'frame=12\nprogress=end\n');
    expect(state.framesWritten).toBe(12);
    expect(state.ended).toBe(true);
  });

  it('チャンクが行途中で切れても復元する', () => {
    let state = INITIAL_PROGRESS_STATE;
    state = feedFfmpegProgress(state, 'fra');
    expect(state.framesWritten).toBe(0);
    state = feedFfmpegProgress(state, 'me=7\nprog');
    expect(state.framesWritten).toBe(7);
    expect(state.ended).toBe(false);
    state = feedFfmpegProgress(state, 'ress=end\n');
    expect(state.ended).toBe(true);
  });

  it('CRLF・無関係なキーを無視する', () => {
    let state = INITIAL_PROGRESS_STATE;
    state = feedFfmpegProgress(state, 'out_time_ms=1000\r\nbitrate=N/A\r\nframe=4\r\n');
    expect(state.framesWritten).toBe(4);
    expect(state.ended).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sidecarSummary
// ---------------------------------------------------------------------------

describe('summarizeSidecar', () => {
  it('status と件数を取り出す', () => {
    expect(summarizeSidecar({ status: 'done', annotations: [1, 2, 3] })).toEqual({
      status: 'done',
      annotationCount: 3,
    });
  });

  it('未知の status は pending 扱い', () => {
    expect(summarizeSidecar({ status: 'weird', annotations: [] })).toEqual({
      status: 'pending',
      annotationCount: 0,
    });
  });

  it('壊れた値でも既定値を返す', () => {
    expect(summarizeSidecar(null).status).toBe('pending');
    expect(summarizeSidecar([]).annotationCount).toBe(0);
    expect(summarizeSidecar({ annotations: 'not-array' }).annotationCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// atomicWrite（実 tmpdir）
// ---------------------------------------------------------------------------

describe('atomicWrite', () => {
  let root: string;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'genba-anno-test-'));
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('親ディレクトリを作って書き込み、tmp を残さない', async () => {
    const target = path.join(root, 'a', 'b', 'note.json');
    await atomicWriteFile(target, '{"x":1}');
    expect(await fs.readFile(target, 'utf8')).toBe('{"x":1}');
    const siblings = await fs.readdir(path.dirname(target));
    expect(siblings).toEqual(['note.json']);
  });

  it('既存ファイルを置換できる（Uint8Array も可）', async () => {
    const target = path.join(root, 'bin.dat');
    await atomicWriteFile(target, new Uint8Array([1, 2, 3]));
    await atomicWriteFile(target, new Uint8Array([9]));
    expect([...(await fs.readFile(target))]).toEqual([9]);
  });

  it('backupExisting は対象が無ければ backups を作らない（lazy 作成）', async () => {
    const backups = path.join(root, 'lazy-backups');
    expect(await backupExisting(path.join(root, 'missing.json'), backups)).toBe(false);
    expect(await pathExists(backups)).toBe(false);
  });

  it('writeFileWithBackup は直前世代を backups へ退避する', async () => {
    const dir = path.join(root, 'proj', '_anno', 'annotations');
    const backups = path.join(root, 'proj', '_anno', 'backups');
    const target = path.join(dir, 'IMG_0001.jpg.json');

    await writeFileWithBackup(target, 'v1', backups);
    expect(await pathExists(backups)).toBe(false); // 初回は退避対象なし

    await writeFileWithBackup(target, 'v2', backups);
    expect(await fs.readFile(target, 'utf8')).toBe('v2');
    expect(await fs.readFile(path.join(backups, 'IMG_0001.jpg.json'), 'utf8')).toBe('v1');

    await writeFileWithBackup(target, 'v3', backups);
    expect(await fs.readFile(target, 'utf8')).toBe('v3');
    expect(await fs.readFile(path.join(backups, 'IMG_0001.jpg.json'), 'utf8')).toBe('v2');
  });

  it('preserveBeforeOverwrite: 正常な現行版 JSON・存在しないファイルでは何もしない', async () => {
    const dir = path.join(root, 'ok-json');
    const backups = path.join(dir, 'backups');
    const target = path.join(dir, 'project.json');
    await atomicWriteFile(target, '{"schema_version":1,"classes":[]}');

    expect(await preserveBeforeOverwrite(target, backups, 1)).toBeNull();
    expect(await preserveBeforeOverwrite(path.join(dir, 'missing.json'), backups, 1)).toBeNull();
    expect(await pathExists(backups)).toBe(false); // 余計なディレクトリを作らない
  });

  it('preserveBeforeOverwrite: 壊れた JSON は上書きされない名前で退避する', async () => {
    const dir = path.join(root, 'broken-json');
    const backups = path.join(dir, 'backups');
    const target = path.join(dir, 'project.json');
    await atomicWriteFile(target, '{"classes": [{"id":0,'); // 途中で切れている

    const preserved = await preserveBeforeOverwrite(target, backups, 1);
    expect(preserved?.reason).toBe('corrupt');
    expect(path.basename(preserved!.path).startsWith('project.json.corrupt-')).toBe(true);
    expect(await fs.readFile(preserved!.path, 'utf8')).toBe('{"classes": [{"id":0,');

    // BOM 付きの正常 JSON は「壊れている」と誤判定しない
    const bom = path.join(dir, 'bom.json');
    await atomicWriteFile(bom, '﻿{"schema_version":1}');
    expect(await preserveBeforeOverwrite(bom, backups, 1)).toBeNull();
  });

  it('preserveBeforeOverwrite: schema_version が現行より新しいファイルを退避する', async () => {
    // 将来版で作られたサイドカーを旧版が上書きすると未知フィールドが黙って消える
    const dir = path.join(root, 'newer-schema');
    const backups = path.join(dir, 'backups');
    const target = path.join(dir, 'IMG_0001.jpg.json');
    const future = '{"schema_version":2,"annotations":[],"future_field":{"keep":true}}';
    await atomicWriteFile(target, future);

    const preserved = await preserveBeforeOverwrite(target, backups, 1);
    expect(preserved?.reason).toBe('newer');
    expect(path.basename(preserved!.path).startsWith('IMG_0001.jpg.json.newer-')).toBe(true);
    expect(await fs.readFile(preserved!.path, 'utf8')).toBe(future);

    // 同版・旧版・型不正は退避しない（型不正は parse 可能な壊れデータとして通常扱い）
    for (const body of ['{"schema_version":1}', '{"schema_version":0}', '{"schema_version":"2"}']) {
      const f = path.join(dir, `v-${Buffer.from(body).toString('hex').slice(0, 8)}.json`);
      await atomicWriteFile(f, body);
      expect(await preserveBeforeOverwrite(f, backups, 1), body).toBeNull();
    }
  });

  it('preserveBeforeOverwrite: 同じ内容の退避を重複して作らない（開き直しでの増殖防止）', async () => {
    const dir = path.join(root, 'dedupe');
    const backups = path.join(dir, 'backups');
    const target = path.join(dir, 'project.json');
    await atomicWriteFile(target, '{"broken":');

    expect(await preserveBeforeOverwrite(target, backups, 1)).not.toBeNull();
    expect(await preserveBeforeOverwrite(target, backups, 1)).toBeNull(); // 2回目は作らない
    expect(await preserveBeforeOverwrite(target, backups, 1)).toBeNull();
    expect((await fs.readdir(backups)).filter((n) => n.includes('.corrupt-'))).toHaveLength(1);

    // 内容が変わったら別途退避する
    await atomicWriteFile(target, '{"broken-differently":');
    expect(await preserveBeforeOverwrite(target, backups, 1)).not.toBeNull();
    expect((await fs.readdir(backups)).filter((n) => n.includes('.corrupt-'))).toHaveLength(2);
  });

  it('壊れた project.json は 2 回保存しても原本が残る（1 世代 backups の押し出し対策）', async () => {
    // M2 指摘の消失経路の回帰テスト:
    //   壊れた project.json → 保存#1 で backups へ → 保存#2 で backups が上書き → 原本消失
    const anno = path.join(root, 'loss-path', '_anno');
    const backups = path.join(anno, 'backups');
    const target = path.join(anno, 'project.json');
    const original = '{"classes":[{"id":0,"name":"crack"},{"id":1,"name":"patch"}';
    await atomicWriteFile(target, original);

    // 保存#1（レンダラがデフォルト生成して保存した想定）
    await preserveBeforeOverwrite(target, backups, 1);
    await writeJsonWithBackup(target, { classes: [{ id: 0 }] }, backups);
    // 保存#2（設定変更・updatedAt 更新などで普通に起きる）
    await preserveBeforeOverwrite(target, backups, 1);
    await writeJsonWithBackup(target, { classes: [{ id: 0 }, { id: 9 }] }, backups);

    // 1 世代の backups は最新世代で押し出されている（従来どおり）
    expect(await fs.readFile(path.join(backups, 'project.json'), 'utf8')).toContain('"id": 0');
    expect(await fs.readFile(path.join(backups, 'project.json'), 'utf8')).not.toContain('crack');

    // 壊れた原本は corrupt- 側に必ず残っている
    const corruptFiles = (await fs.readdir(backups)).filter((n) =>
      n.startsWith('project.json.corrupt-'),
    );
    expect(corruptFiles).toHaveLength(1);
    expect(await fs.readFile(path.join(backups, corruptFiles[0]), 'utf8')).toBe(original);
  });

  it('atomicCopyFile はコピー先を原子的に置換し tmp を残さない', async () => {
    const dir = path.join(root, 'atomic-copy');
    await fs.mkdir(dir, { recursive: true });
    const src = path.join(dir, 'src.bin');
    const dest = path.join(dir, 'sub', 'dest.bin');
    await atomicWriteFile(src, new Uint8Array([1, 2, 3]));

    await atomicCopyFile(src, dest);
    expect([...(await fs.readFile(dest))]).toEqual([1, 2, 3]);
    expect((await fs.readdir(path.dirname(dest))).filter((n) => n.startsWith('.tmp-'))).toEqual([]);

    // コピー元が無い場合は tmp を残さず失敗する
    await expect(atomicCopyFile(path.join(dir, 'nope'), dest)).rejects.toBeTruthy();
    expect((await fs.readdir(path.dirname(dest))).filter((n) => n.startsWith('.tmp-'))).toEqual([]);
  });

  it('writeJsonWithBackup は 2 スペース + 末尾改行で書く', async () => {
    const target = path.join(root, 'proj2', '_anno', 'project.json');
    await writeJsonWithBackup(target, { a: 1 }, path.join(root, 'proj2', '_anno', 'backups'));
    expect(await fs.readFile(target, 'utf8')).toBe('{\n  "a": 1\n}\n');
  });

  it('書き込み失敗時に tmp ファイルを残さない', async () => {
    // ファイルをディレクトリとして開かせて失敗させる
    const dir = path.join(root, 'as-dir');
    await fs.mkdir(dir, { recursive: true });
    await expect(atomicWriteFile(dir, 'x')).rejects.toBeTruthy();
    const leftovers = (await fs.readdir(root)).filter((n) => n.startsWith('.tmp-'));
    expect(leftovers).toEqual([]);
  });

  it('isDirectory / pathExists が種別を見分ける', async () => {
    const file = path.join(root, 'plain.txt');
    await atomicWriteFile(file, 'x');
    expect(await pathExists(file)).toBe(true);
    expect(await isDirectory(file)).toBe(false);
    expect(await isDirectory(root)).toBe(true);
    expect(await pathExists(path.join(root, 'nope'))).toBe(false);
  });

  it('同時書き込みでも最終ファイルは常に完全な内容になる', async () => {
    const target = path.join(root, 'concurrent.json');
    const payloads = Array.from({ length: 12 }, (_, i) => `${JSON.stringify({ n: i })}\n`);
    await Promise.all(payloads.map((p) => atomicWriteFile(target, p)));
    const text = await fs.readFile(target, 'utf8');
    expect(payloads).toContain(text);
    // 途中経過の tmp が残っていないこと
    expect((await fs.readdir(root)).filter((n) => n.startsWith('.tmp-'))).toEqual([]);
  });

  it('tmp は対象と同一ディレクトリに作られる（rename の原子性の前提）', async () => {
    const dir = path.join(root, 'same-fs');
    await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, 'x.json');

    // 書込中（open〜rename の間）にディレクトリを覗いて .tmp- を確認する
    let settled = false;
    const writing = atomicWriteFile(target, 'x'.repeat(4 * 1024 * 1024)).finally(() => {
      settled = true;
    });
    let sawTmp = false;
    while (!settled && !sawTmp) {
      sawTmp = fsSync.readdirSync(dir).some((n) => n.startsWith('.tmp-'));
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
    }
    await writing;

    expect(sawTmp).toBe(true);
    // 完了後は tmp が消え、目的のファイルだけが残る
    expect(fsSync.readdirSync(dir)).toEqual(['x.json']);
  });
});

// ---------------------------------------------------------------------------
// fileLock（同一ファイルへの保存レース対策）
// ---------------------------------------------------------------------------

describe('withFileLock', () => {
  it('同じ key のタスクは開始順に直列実行される', async () => {
    const order: string[] = [];
    const task = (name: string, delay: number) => async () => {
      order.push(`${name}:start`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      order.push(`${name}:end`);
      return name;
    };

    // 遅い書込を先に投げても、後続が追い越さないこと
    const a = withFileLock('/same.json', task('a', 20));
    const b = withFileLock('/same.json', task('b', 1));
    const c = withFileLock('/same.json', task('c', 1));
    expect(await Promise.all([a, b, c])).toEqual(['a', 'b', 'c']);
    expect(order).toEqual([
      'a:start',
      'a:end',
      'b:start',
      'b:end',
      'c:start',
      'c:end',
    ]);
  });

  it('異なる key は並行に実行される', async () => {
    let running = 0;
    let maxConcurrent = 0;
    const task = async (): Promise<void> => {
      running += 1;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
    };
    await Promise.all([
      withFileLock('/a.json', task),
      withFileLock('/b.json', task),
      withFileLock('/c.json', task),
    ]);
    expect(maxConcurrent).toBe(3);
  });

  it('前のタスクが失敗しても後続は実行され、失敗は呼び出し側に伝わる', async () => {
    const failing = withFileLock('/err.json', () => Promise.reject(new Error('boom')));
    await expect(failing).rejects.toThrow('boom');
    await expect(withFileLock('/err.json', () => Promise.resolve('ok'))).resolves.toBe('ok');
  });

  it('完了後に key を保持し続けない（メモリリーク防止）', async () => {
    await withFileLock('/tmp-key.json', () => Promise.resolve());
    // 解放は tail の then で行われるのでマイクロタスクを 1 回回す
    await new Promise((resolve) => setImmediate(resolve));
    expect(pendingLockCount()).toBe(0);
  });

  it('保存レース: 直列化すると最後に投げた内容がディスクに残る', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ga-lock-'));
    const target = path.join(dir, 'IMG_0001.jpg.json');
    const backups = path.join(dir, 'backups');

    // 自動保存（重い・古い内容）と手動保存（軽い・新しい内容）が重なる状況
    const slow = withFileLock(target, async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      await writeFileWithBackup(target, 'auto-save(古い)', backups);
    });
    const fast = withFileLock(target, async () => {
      await writeFileWithBackup(target, 'manual-save(新しい)', backups);
    });
    await Promise.all([slow, fast]);

    expect(await fs.readFile(target, 'utf8')).toBe('manual-save(新しい)');
    // バックアップ世代も直前世代（自動保存の内容）で正しく積まれている
    expect(await fs.readFile(path.join(backups, 'IMG_0001.jpg.json'), 'utf8')).toBe(
      'auto-save(古い)',
    );
    await fs.rm(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// safeFs（シンボリックリンク脱出対策・実 symlink で検証）
// ---------------------------------------------------------------------------

describe('safeFs: symlink 脱出', () => {
  let root: string;
  let outside: string;
  let project: string;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ga-symlink-'));
    outside = path.join(root, 'outside');
    project = path.join(root, 'project');
    await fs.mkdir(outside, { recursive: true });
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(outside, 'secret.txt'), 'TOP SECRET');
    await fs.writeFile(path.join(project, 'real.jpg'), 'JPEGDATA');
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('statRegularFile は通常ファイルを許可し symlink を拒否する', async () => {
    const link = path.join(project, 'evil.jpg');
    await fs.symlink(path.join(outside, 'secret.txt'), link);

    expect(await statRegularFile(path.join(project, 'real.jpg'))).not.toBeNull();
    // 許可フォルダ直下に置かれた symlink 画像は「通常ファイル」ではないので弾かれる
    expect(await statRegularFile(link)).toBeNull();
    expect(await statRegularFile(path.join(project, 'missing.jpg'))).toBeNull();
    expect(await statRegularFile(project)).toBeNull(); // ディレクトリも false
    await fs.rm(link);
  });

  it('ディレクトリへの symlink も拒否する', async () => {
    const link = path.join(project, 'linkdir.jpg');
    await fs.symlink(outside, link);
    expect(await statRegularFile(link)).toBeNull();
    expect(await isSymbolicLink(link)).toBe(true);
    await fs.rm(link);
  });

  it('isRealPathInside は symlink 解決後の実体で判定する', async () => {
    const link = path.join(project, 'escape.jpg');
    await fs.symlink(path.join(outside, 'secret.txt'), link);

    expect(await isRealPathInside(project, path.join(project, 'real.jpg'))).toBe(true);
    expect(await isRealPathInside(project, project)).toBe(true);
    // 字句的には project 配下だが、実体は outside なので false
    expect(await isRealPathInside(project, link)).toBe(false);
    expect(await isRealPathInside(project, path.join(outside, 'secret.txt'))).toBe(false);
    await fs.rm(link);
  });

  it('resolveDestPathNoSymlink: 通常のパスは親を作って解決する', async () => {
    const dest = path.join(root, 'export1');
    await fs.mkdir(dest, { recursive: true });
    const real = await fs.realpath(dest);

    const target = await resolveDestPathNoSymlink(real, ['images', 'train', 'a.jpg']);
    expect(target).toBe(path.join(real, 'images', 'train', 'a.jpg'));
    expect(await isDirectory(path.join(real, 'images', 'train'))).toBe(true);

    // 出力先直下（サブフォルダ無し）も解決できる
    expect(await resolveDestPathNoSymlink(real, ['data.yaml'])).toBe(path.join(real, 'data.yaml'));
  });

  it('resolveDestPathNoSymlink: 途中の symlink ディレクトリを拒否し外部に書かせない', async () => {
    const dest = path.join(root, 'export2');
    await fs.mkdir(dest, { recursive: true });
    const real = await fs.realpath(dest);
    // 攻撃: 出力先に外部を指す symlink ディレクトリが置かれている
    await fs.symlink(outside, path.join(real, 'images'));

    await expect(
      resolveDestPathNoSymlink(real, ['images', 'train', 'a.jpg']),
    ).rejects.toBeInstanceOf(SymlinkRejectedError);
    // 拒否した時点で外部にディレクトリを作っていないこと
    expect(await pathExists(path.join(outside, 'train'))).toBe(false);
  });

  it('resolveDestPathNoSymlink: 書き込み先ファイルが既存 symlink なら拒否する', async () => {
    const dest = path.join(root, 'export3');
    await fs.mkdir(dest, { recursive: true });
    const real = await fs.realpath(dest);
    // 攻撃: 出力予定のファイル名が外部ファイルへの symlink になっている
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(real, 'data.yaml'));

    await expect(resolveDestPathNoSymlink(real, ['data.yaml'])).rejects.toBeInstanceOf(
      SymlinkRejectedError,
    );
    // リンク先の中身が壊れていないこと
    expect(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('TOP SECRET');
  });

  it('resolveDestPathNoSymlink: 途中がファイルなら拒否する', async () => {
    const dest = path.join(root, 'export4');
    await fs.mkdir(dest, { recursive: true });
    const real = await fs.realpath(dest);
    await fs.writeFile(path.join(real, 'images'), 'not a dir');

    await expect(resolveDestPathNoSymlink(real, ['images', 'a.jpg'])).rejects.toBeInstanceOf(
      SymlinkRejectedError,
    );
  });

  it('resolveDestPathNoSymlink: 既存の通常ディレクトリは再利用する', async () => {
    const dest = path.join(root, 'export5');
    const real = await fs.mkdir(dest, { recursive: true }).then(() => fs.realpath(dest));
    await fs.mkdir(path.join(real, 'labels'), { recursive: true });
    await fs.writeFile(path.join(real, 'labels', 'keep.txt'), 'keep');

    const target = await resolveDestPathNoSymlink(real, ['labels', 'new.txt']);
    expect(target).toBe(path.join(real, 'labels', 'new.txt'));
    expect(await fs.readFile(path.join(real, 'labels', 'keep.txt'), 'utf8')).toBe('keep');
  });
});
