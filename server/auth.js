import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-fallback-secret-change-me';

export default function createAuth(db) {
  function loginHandler(req, res) {
    const { username, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: 'ユーザー名またはパスワードが正しくありません' });
    }
    const token = jwt.sign(
      { userId: user.id, username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.json({
      token,
      user: { id: user.id, username: user.username, displayName: user.display_name, role: user.role }
    });
  }

  function authMiddleware(req, res, next) {
    if (!req.path.startsWith('/api/')) return next();

    const exemptPaths = ['/api/line/webhook', '/api/auth/login'];
    if (exemptPaths.some(p => req.path === p)) return next();

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    try {
      const token = authHeader.split(' ')[1];
      const decoded = jwt.verify(token, JWT_SECRET);
      req.user = { id: decoded.userId, username: decoded.username, role: decoded.role };
      next();
    } catch (err) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  }

  return { loginHandler, authMiddleware };
}
