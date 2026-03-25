import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { createServer as createViteServer } from 'vite';
import { ensureTreeFile, getTreeFilePath, readTree, writeTree } from './tree-store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const isProd = process.env.NODE_ENV === 'production';
const host = process.env.HOST ?? '0.0.0.0';
const port = Number(process.env.PORT ?? 5173);

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

// ── Client error buffer ────────────────────────────────────────────────────────
const MAX_CLIENT_ERRORS = 100;
const clientErrors = [];

const sendJson = (res, statusCode, payload) => {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
};

const readBody = (req) => new Promise((resolve, reject) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 1024 * 1024) {
      reject(new Error('Request body too large.'));
      req.destroy();
    }
  });
  req.on('end', () => resolve(body));
  req.on('error', reject);
});

const createApiHandler = () => async (req, res) => {
  if (!req.url?.startsWith('/api/tree') && !req.url?.startsWith('/api/client-error')) return false;

  try {
    if (req.url?.startsWith('/api/tree')) {
      if (req.method === 'GET') {
        const tree = await readTree();
        sendJson(res, 200, { tree, treeFile: getTreeFilePath() });
        return true;
      }

      if (req.method === 'PUT') {
        const body = await readBody(req);
        const parsed = JSON.parse(body || '{}');
        const tree = await writeTree(parsed.tree);
        sendJson(res, 200, { tree, savedAt: new Date().toISOString() });
        return true;
      }

      sendJson(res, 405, { error: 'Method not allowed.' });
      return true;
    }

    // POST /api/client-error — log client-side errors
    if (req.url?.startsWith('/api/client-error') && req.method === 'POST') {
      const body = await readBody(req);
      const parsed = JSON.parse(body || '{}');
      const entry = {
        timestamp: new Date().toISOString(),
        message: parsed.message,
        source: parsed.source,
        lineno: parsed.lineno,
        colno: parsed.colno,
        stack: parsed.stack,
        url: parsed.url,
        userAgent: req.headers['user-agent'],
      };
      clientErrors.unshift(entry);
      if (clientErrors.length > MAX_CLIENT_ERRORS) clientErrors.pop();
      console.error('[ClientError]', JSON.stringify(entry));
      sendJson(res, 202, { ok: true });
      return true;
    }

    // GET /api/client-errors — retrieve buffered client errors
    if (req.url?.startsWith('/api/client-errors') && req.method === 'GET') {
      sendJson(res, 200, clientErrors);
      return true;
    }

    sendJson(res, 405, { error: 'Method not allowed.' });
    return true;
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : 'Unexpected server error.' });
    return true;
  }
};

const safeJoin = (base, requestPath) => {
  const target = path.resolve(base, `.${requestPath}`);
  return target.startsWith(base) ? target : null;
};

const serveFile = async (res, filePath) => {
  const data = await readFile(filePath);
  res.statusCode = 200;
  res.setHeader('Content-Type', mimeTypes[path.extname(filePath)] ?? 'application/octet-stream');
  res.end(data);
};

const start = async () => {
  await ensureTreeFile();
  const handleApi = createApiHandler();
  const vite = isProd
    ? null
    : await createViteServer({
        root,
        server: { middlewareMode: true, host, port },
        appType: 'spa',
      });

  const server = http.createServer(async (req, res) => {
    if (await handleApi(req, res)) return;

    try {
      if (isProd) {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        const requestPath = url.pathname === '/' ? '/index.html' : url.pathname;
        const distPath = safeJoin(path.join(root, 'dist'), requestPath);
        const publicPath = safeJoin(path.join(root, 'public'), requestPath);

        if (distPath) {
          try {
            await serveFile(res, distPath);
            return;
          } catch {
            // fall through to SPA index
          }
        }

        if (publicPath) {
          try {
            await serveFile(res, publicPath);
            return;
          } catch {
            // fall through to SPA index
          }
        }

        await serveFile(res, path.join(root, 'dist', 'index.html'));
        return;
      }

      vite.middlewares(req, res, async () => {
        try {
          const indexPath = path.join(root, 'index.html');
          let template = await readFile(indexPath, 'utf8');
          template = await vite.transformIndexHtml(req.url ?? '/', template);
          res.statusCode = 200;
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(template);
        } catch (error) {
          vite.ssrFixStacktrace(error);
          res.statusCode = 500;
          res.end(error instanceof Error ? error.message : 'Unexpected server error.');
        }
      });
    } catch (error) {
      res.statusCode = 500;
      res.end(error instanceof Error ? error.message : 'Unexpected server error.');
    }
  });

  server.listen(port, host, () => {
    console.log(`Family tree app listening on http://${host}:${port}`);
    console.log(`Shared tree file: ${getTreeFilePath()}`);
  });
};

start();
