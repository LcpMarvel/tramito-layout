// 本地预览 demo/dist：bun run demo:serve（默认 4173，PORT 可覆盖）。
import { join } from 'node:path';

const root = join(import.meta.dir, '..', 'demo', 'dist');
const port = Number(process.env.PORT ?? 4173);

Bun.serve({
  port,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = Bun.file(join(root, rel));
    if (await file.exists()) return new Response(file);
    return new Response('not found', { status: 404 });
  },
});

console.log(`demo serving at http://localhost:${port}/`);
