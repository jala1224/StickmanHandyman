import { getAdminUserByEmail, issueAdminSession, verifyAdminSession, verifyClientSession } from '../services/store.js';

export function readBearerToken(req) {
  return /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''))?.[1] || '';
}

export function requireAdmin(req, res, next) {
  const token = readBearerToken(req);
  const session = token ? verifyAdminSession(token) : null;

  if (!session) {
    return res.status(401).json({ error: 'Admin authentication required.' });
  }

  req.admin = { id: session.adminId, email: session.email, expiresAt: session.expiresAt };
  next();
}

export function authenticateAdminLogin(email, password) {
  const adminUser = getAdminUserByEmail(email);
  if (!adminUser) {
    return null;
  }

  if (adminUser.password !== password) {
    return null;
  }

  const session = issueAdminSession(adminUser);

  return {
    id: adminUser.id,
    email: adminUser.email,
    token: session.token,
    expiresAt: session.expiresAt,
  };
}

export function requireClient(req, res, next) {
  const token = readBearerToken(req);
  const session = token ? verifyClientSession(token) : null;

  if (!session) {
    return res.status(401).json({ error: 'Client authentication required.' });
  }

  req.clientUser = {
    id: session.clientUserId,
    accountId: session.accountId,
    email: session.email,
  };
  next();
}
