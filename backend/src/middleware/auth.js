import { getAdminUserByEmail, issueAdminSession, verifyAdminSession, verifyClientSession } from '../services/store.js';

export function requireAdmin(req, res, next) {
  const authHeader = req.headers.authorization ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : '';
  const session = token ? verifyAdminSession(token) : null;

  if (!session) {
    return res.status(401).json({ error: 'Admin authentication required.' });
  }

  req.admin = { id: session.adminId, email: session.email };
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
  const authHeader = req.headers.authorization ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : '';
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
