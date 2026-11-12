/** Serve dist/ locally: node scripts/serve.ts [port] */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { DIST_DIR } from '../lib/paths.ts'

const port = Number(process.argv[2] ?? 4173)
const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.toml': 'text/plain; charset=utf-8' }
http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname).replace(/^\/+/, '') || 'index.html'
  const file = path.join(DIST_DIR, rel)
  if (!file.startsWith(DIST_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return void res.writeHead(404).end('not found')
  res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' }).end(fs.readFileSync(file))
}).listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}/`))
