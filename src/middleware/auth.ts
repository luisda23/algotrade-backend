import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
// Import directo desde ./db para evitar el circular: server.ts → routes/*
// → middleware/auth.ts. Si importáramos `prisma` de server.ts, durante el
// registro de rutas el middleware se cargaría antes de que server.ts haya
// terminado de inicializar, y el proceso crashearía al arrancar.
import { prisma } from '../db';
import { errResp, RC } from '../utils/responses';

interface AuthRequest extends Request {
  userId?: string;
}

export const JWT_SECRET = (() => {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 16) {
    // Fail loud at boot — no silent 'secret' fallback that lets anyone forge tokens.
    throw new Error('JWT_SECRET environment variable is required and must be at least 16 chars long');
  }
  return s;
})();

// Helper para emitir el JWT de sesión con tokenVersion. Centralizado aquí
// para que /login, /verify-login y /reset-password emitan tokens compatibles
// con el middleware sin duplicar el shape del payload.
export function issueSessionToken(user: { id: string; email: string; tokenVersion?: number }) {
  return jwt.sign(
    { userId: user.id, email: user.email, type: 'session', tv: user.tokenVersion ?? 0 },
    JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRATION || '7d' } as any
  );
}

export const authenticateToken = async (req: AuthRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json(errResp(RC.AUTH_TOKEN_REQUIRED, 'Token required'));
  }

  let decoded: any;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(403).json(errResp(RC.AUTH_TOKEN_INVALID, 'Invalid token'));
  }

  // Rechaza tokens pre-MFA: el pendingToken solo sirve para /verify-login
  // y /resend-login-code, no para autenticarse en el resto de la API.
  if (decoded?.type === 'pending-login') {
    return res.status(403).json(errResp(RC.AUTH_TOKEN_PENDING, 'Pending login token. Complete verification first.'));
  }

  if (!decoded?.userId) {
    return res.status(403).json(errResp(RC.AUTH_TOKEN_INVALID, 'Invalid token'));
  }

  // Validación de tokenVersion: invalida sesiones tras cambio de contraseña /
  // email / logout-everywhere. Tokens antiguos (sin tv en el payload) se
  // consideran tv=0 y siguen siendo válidos solo si el user nunca ha
  // bumpeado tokenVersion. Una vez bumpeado, esos tokens pasan a inválidos.
  const tokenTv = typeof decoded.tv === 'number' ? decoded.tv : 0;
  try {
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: { tokenVersion: true },
    });
    if (!user) return res.status(403).json(errResp(RC.AUTH_SESSION_EXPIRED, 'Session expired'));
    if ((user.tokenVersion ?? 0) !== tokenTv) {
      return res.status(403).json(errResp(RC.AUTH_SESSION_EXPIRED, 'Session expired. Sign in again.'));
    }
  } catch (err) {
    console.error('Token version check error:', err);
    return res.status(500).json(errResp(RC.AUTH_SESSION_VALIDATION_ERROR, 'Failed to validate session'));
  }

  req.userId = decoded.userId;
  next();
};

export { AuthRequest };
