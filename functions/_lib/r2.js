// R2 文件层：分片写入、按 parts 顺序流式读取、按前缀删除

/** 原型正式文件键：p/<protoId>/v<version>/<相对路径> */
export function fileKey(protoId, version, path) {
  return `p/${protoId}/v${version}/${path}`;
}

/** 大文件被切分后的分片键 */
export function partKey(protoId, version, fileIndex, seq) {
  return `p/${protoId}/v${version}/.parts/${fileIndex}/${String(seq).padStart(6, '0')}`;
}

/** 上传中转区键 */
export function tmpKey(uploadId, name) {
  return `tmp/${uploadId}/${name}`;
}

export async function putObject(env, key, data, httpMetadata = {}) {
  return env.BUCKET.put(key, data, {
    httpMetadata: { contentType: httpMetadata.contentType || 'application/octet-stream' },
  });
}

export async function getObject(env, key) {
  return env.BUCKET.get(key);
}

export async function listPrefix(env, prefix) {
  const keys = [];
  let cursor;
  do {
    const res = await env.BUCKET.list({ prefix, cursor, limit: 1000 });
    for (const o of res.objects) keys.push(o.key);
    cursor = res.truncated ? res.cursor : undefined;
  } while (cursor);
  return keys;
}

export async function deletePrefix(env, prefix) {
  const keys = await listPrefix(env, prefix);
  for (let i = 0; i < keys.length; i += 100) {
    await env.BUCKET.delete(keys.slice(i, i + 100));
  }
  return keys.length;
}

/**
 * 按 parts 顺序拼接输出流。绝大多数文件只有 1 个 part，直接透传 R2 的 body，
 * 零拷贝；跨片文件则顺序拉取各 part，不占用内存。
 */
export function openStream(env, keys, totalSize) {
  if (!keys || keys.length === 0) return null;
  if (keys.length === 1) {
    return (async () => {
      const obj = await env.BUCKET.get(keys[0]);
      if (!obj) return null;
      return { body: obj.body, size: totalSize || obj.size, etag: obj.httpEtag || obj.etag };
    })();
  }
  let i = 0;
  let reader = null;
  const stream = new ReadableStream({
    async pull(ctrl) {
      // 必须一直循环到「真的吐出一段数据」或关闭，否则流会因为没写入而永久挂起
      for (;;) {
        if (!reader) {
          if (i >= keys.length) {
            ctrl.close();
            return;
          }
          const key = keys[i];
          i += 1;
          const obj = await env.BUCKET.get(key);
          if (!obj) throw new Error(`缺失文件分片: ${key}`);
          reader = obj.body.getReader();
        }
        const { done, value } = await reader.read();
        if (done) {
          reader = null;
          continue;
        }
        ctrl.enqueue(value);
        return;
      }
    },
  });
  return Promise.resolve({ body: stream, size: totalSize, etag: null });
}
