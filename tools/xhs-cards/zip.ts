/**
 * 极简 ZIP 打包(store 模式,不压缩)。
 *
 * 为什么不引第三方库:本项目的硬约束是**运行时零依赖**
 * (`package.json` 只有 devDependencies,生产是 esbuild 打的单文件)。
 *
 * 为什么选 store 而不是 deflate:PNG 自身已经压缩过,再 deflate 几乎不减小体积,
 * 白白增加复杂度。store 模式的 ZIP 结构简单到可以手写,而且 Windows / macOS /
 * Linux 的资源管理器都原生能打开。
 *
 * ZIP 结构(三部分,均小端序):
 *
 *   1. 每个文件:Local File Header(30 字节 + 文件名) + 原始数据
 *   2. 中央目录:每个文件一条 Central Directory Header(46 字节 + 文件名),
 *      记录它在第 1 部分里的偏移
 *   3. 末尾:EOCD(22 字节),记录中央目录的条数、大小、偏移
 */

/** 校验用的标准 CRC-32 多项式(反射形式) */
const POLY = 0xedb88320;

/** 256 项查表,惰性构建一次 */
let crcTable: Uint32Array | null = null;

function table(): Uint32Array {
  if (crcTable !== null) return crcTable;
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? (POLY ^ (c >>> 1)) >>> 0 : c >>> 1;
    }
    t[i] = c >>> 0;
  }
  crcTable = t;
  return t;
}

/** 标准 CRC-32,返回值范围 0..2^32-1 */
export function crc32(data: Uint8Array): number {
  const t = table();
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    const idx = (crc ^ (data[i] ?? 0)) & 0xff;
    crc = ((t[idx] ?? 0) ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  /** 压缩包内的文件名(只用 ASCII,避免编码问题) */
  name: string;
  data: Uint8Array;
}

/** 小端写入辅助 */
function u16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value & 0xffff, true);
}
function u32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true);
}

/** MS-DOS 日期/时间(固定用 1980-01-01 00:00,够用且可复现) */
const DOS_TIME = 0;
const DOS_DATE = 0x0021; // 1980-01-01

/**
 * 把若干文件打成一个 ZIP(store)。返回完整字节,可直接 `new Blob([...])`。
 */
export function buildZip(entries: readonly ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();

  // 预先把每项的编码后文件名、CRC、以及它在包内的偏移算好。
  // 用 for-of 而不是 names[i] —— 本仓库开了 noUncheckedIndexedAccess,
  // 随机下标一律是 `T | undefined`,会逼出一堆无意义的判空。
  interface Prepared {
    nameBytes: Uint8Array;
    data: Uint8Array;
    crc: number;
    offset: number;
  }
  const prepared: Prepared[] = entries.map((entry) => ({
    nameBytes: encoder.encode(entry.name),
    data: entry.data,
    crc: crc32(entry.data),
    offset: 0,
  }));

  let localSize = 0;
  let centralSize = 0;
  for (const item of prepared) {
    localSize += 30 + item.nameBytes.length + item.data.length;
    centralSize += 46 + item.nameBytes.length;
  }
  const total = localSize + centralSize + 22;

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);

  // ---- 第一部分:Local File Header + 数据 ----
  let pos = 0;
  for (const item of prepared) {
    item.offset = pos;
    u32(view, pos, 0x04034b50);              // 签名
    u16(view, pos + 4, 20);                  // 解压所需版本
    u16(view, pos + 6, 0x0800);              // 通用标志位:文件名 UTF-8
    u16(view, pos + 8, 0);                   // 压缩方法:0 = store
    u16(view, pos + 10, DOS_TIME);
    u16(view, pos + 12, DOS_DATE);
    u32(view, pos + 14, item.crc);
    u32(view, pos + 18, item.data.length);   // 压缩后大小(= 原始大小)
    u32(view, pos + 22, item.data.length);   // 原始大小
    u16(view, pos + 26, item.nameBytes.length);
    u16(view, pos + 28, 0);                  // 扩展字段长度
    pos += 30;
    out.set(item.nameBytes, pos);
    pos += item.nameBytes.length;
    out.set(item.data, pos);
    pos += item.data.length;
  }

  // ---- 第二部分:Central Directory ----
  const centralStart = pos;
  for (const item of prepared) {
    u32(view, pos, 0x02014b50);              // 签名
    u16(view, pos + 4, 20);                  // 创建版本
    u16(view, pos + 6, 20);                  // 解压所需版本
    u16(view, pos + 8, 0x0800);
    u16(view, pos + 10, 0);
    u16(view, pos + 12, DOS_TIME);
    u16(view, pos + 14, DOS_DATE);
    u32(view, pos + 16, item.crc);
    u32(view, pos + 20, item.data.length);
    u32(view, pos + 24, item.data.length);
    u16(view, pos + 28, item.nameBytes.length);
    u16(view, pos + 30, 0);                  // 扩展字段
    u16(view, pos + 32, 0);                  // 注释
    u16(view, pos + 34, 0);                  // 起始磁盘号
    u16(view, pos + 36, 0);                  // 内部属性
    u32(view, pos + 38, 0);                  // 外部属性
    u32(view, pos + 42, item.offset);        // 对应 local header 的偏移
    pos += 46;
    out.set(item.nameBytes, pos);
    pos += item.nameBytes.length;
  }

  // ---- 第三部分:EOCD ----
  u32(view, pos, 0x06054b50);
  u16(view, pos + 4, 0);                     // 当前磁盘号
  u16(view, pos + 6, 0);                     // 中央目录所在磁盘号
  u16(view, pos + 8, prepared.length);       // 本磁盘条目数
  u16(view, pos + 10, prepared.length);      // 总条目数
  u32(view, pos + 12, pos - centralStart);   // 中央目录大小
  u32(view, pos + 16, centralStart);         // 中央目录偏移
  u16(view, pos + 20, 0);                    // 注释长度

  return out;
}
