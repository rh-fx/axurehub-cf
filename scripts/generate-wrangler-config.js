// 部署前由环境变量生成 wrangler 配置（wrangler.generated.json），
// 这样 KV namespace id / D1 database id 等资源 id 不必写进仓库文件。
//
// 需要的环境变量：
//   KV_NAMESPACE_ID  -> KV 命名空间 id
//   D1_DATABASE_ID   -> D1 数据库 id（可选，未设置时去掉 D1 绑定，程序自动回退 KV）
//
// 用法：node scripts/generate-wrangler-config.js && wrangler deploy -c wrangler.generated.json
// （package.json 的 deploy 脚本已串联好；本地手动部署前先 export 这两个变量）

import { writeFileSync } from 'node:fs';

const KV_NAMESPACE_ID = process.env.KV_NAMESPACE_ID?.trim();
const D1_DATABASE_ID = process.env.D1_DATABASE_ID?.trim();

if (!KV_NAMESPACE_ID) {
  console.error('[generate-config] 缺少环境变量 KV_NAMESPACE_ID（KV namespace id）');
  process.exit(1);
}

const config = {
  name: 'axurehub-cf',
  main: 'src/index.js',
  compatibility_date: '2026-10-09',
  assets: {
    directory: './public',
    binding: 'ASSETS',
    // 全站访问密码校验需要拦在静态资源之前，因此让 Worker 先跑
    run_worker_first: true,
  },
  kv_namespaces: [{ binding: 'KV', id: KV_NAMESPACE_ID }],
  r2_buckets: [{ binding: 'BUCKET', bucket_name: 'axurehub-protos' }],
  vars: {
    // 分片大小上限（字节），Worker 请求体有限制，默认 4MB 一片
    SHARD_SIZE: '4194304',
    // 会话有效期（秒），默认 7 天
    SESSION_TTL: '604800',
  },
};

if (D1_DATABASE_ID) {
  config.d1_databases = [{ binding: 'DB', database_name: 'axurehub-db', database_id: D1_DATABASE_ID }];
}

writeFileSync(
  new URL('../wrangler.generated.json', import.meta.url),
  JSON.stringify(config, null, 2) + '\n',
);
console.log(`[generate-config] 已生成 wrangler.generated.json（KV=${KV_NAMESPACE_ID}${D1_DATABASE_ID ? `, D1=${D1_DATABASE_ID}` : '，未绑定 D1'}）`);
