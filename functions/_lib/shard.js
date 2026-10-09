// 分片（shard）二进制协议
//
// 浏览器端把「多个小文件」打包进同一个分片，大文件则按 SEG 大小切成多片，
// 使每个 HTTP 请求体都远小于 Cloudflare Worker 的请求体上限（默认 4MB/片）。
//
// 分片格式：
//   [0..4)      uint32 BE —— manifest JSON 的字节长度
//   [4..4+n)    manifest JSON（UTF-8）
//   [4+n..)     所有文件/片段的字节，按 manifest.f 顺序紧密排列
//
// manifest: { u: uploadId, i: shardIndex, f: [ { p, l, i, s, t } ] }
//   p = 文件相对路径, l = 本片内该文件的字节数,
//   i = 文件序号, s = 片段序号(完整文件为 0), t = 该文件总片段数(完整文件为 1)

export const DEFAULT_SHARD_SIZE = 4 * 1024 * 1024;
export const SHARD_OVERHEAD = 2 * 1024 * 1024; // manifest 允许的额外开销

export function shardLimit(env) {
  const n = Number(env.SHARD_SIZE);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SHARD_SIZE;
}

export async function parseShard(buffer, limitBytes) {
  if (buffer.byteLength < 4) throw new Error('分片数据不完整');
  if (limitBytes && buffer.byteLength > limitBytes + SHARD_OVERHEAD) {
    throw new Error(`分片过大：${buffer.byteLength} > ${limitBytes + SHARD_OVERHEAD}`);
  }
  const dv = new DataView(buffer);
  const len = dv.getUint32(0);
  if (len + 4 > buffer.byteLength) throw new Error('分片 manifest 长度非法');

  const manifest = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, len)));
  if (!manifest || !Array.isArray(manifest.f)) throw new Error('分片 manifest 结构非法');

  let pos = 4 + len;
  const files = manifest.f.map((e) => {
    const size = e.l | 0;
    if (pos + size > buffer.byteLength) {
      throw new Error(
        `分片数据长度与 manifest 不一致：文件 ${e.p} 需要 ${size} 字节，剩余 ${buffer.byteLength - pos} 字节（分片共 ${buffer.byteLength} 字节）`,
      );
    }
    const bytes = new Uint8Array(buffer, pos, size);
    pos += size;
    return { entry: e, bytes };
  });

  return { manifest, files };
}
