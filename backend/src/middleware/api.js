import { randomUUID } from 'node:crypto';

export function apiRequestContext(req, res, next) {
  req.requestId = randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  res.setHeader('Cache-Control', 'no-store');
  next();
}

export function apiErrorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  const status = error.type === 'entity.parse.failed' ? 400
    : error.type === 'entity.too.large' ? 413 : 500;
  const message = status === 400 ? 'Invalid JSON request body.'
    : status === 413 ? 'Request body is too large.' : 'An unexpected server error occurred.';
  if (status === 500) console.error('API request failed', { requestId: req.requestId, method: req.method, path: req.path });
  return res.status(status).json({ error: message, ...(req.requestId ? { requestId: req.requestId } : {}) });
}

export function denyPrivateStaticPaths(req, res, next) {
  let pathname;
  try {
    pathname = decodeURIComponent(req.path);
  } catch {
    return res.status(404).end();
  }
  const privateSegments = new Set(['backend', 'invoices']);
  if (pathname.split('/').some(segment => privateSegments.has(segment.toLowerCase()))) {
    return res.status(404).end();
  }
  return next();
}