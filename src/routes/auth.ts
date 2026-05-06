import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { prisma } from '../server';
import { authenticateToken, AuthRequest, JWT_SECRET, issueSessionToken } from '../middleware/auth';
import { sendWelcomeEmail, sendLoginCodeEmail, sendEmailChangeCode, sendPasswordResetEmail, generateVerificationCode, generateResetToken } from '../utils/email';
import { errResp, okResp, RC } from '../utils/responses';

const router = Router();

// Cost factor para bcrypt en passwords. 12 = ~250ms en hardware moderno (2026),
// equilibrio entre seguridad contra brute-force y latencia perceptible en login.
// 10 era estándar 2017 pero hoy se craquea demasiado rápido en GPU.
const BCRYPT_PASSWORD_COST = 12;
// Para los códigos de 6 dígitos seguimos usando bcrypt (entropía baja —
// stretching ayuda) pero con cost 10 porque el código vive solo 10-15 min
// y el rate limit ya bloquea brute-force.
const BCRYPT_CODE_COST = 10;

// Hash de tokens de reset. Como el token es 32 bytes random (entropía 256
// bits ya), bcrypt no aporta seguridad — solo añade ~80ms de CPU en cada
// /reset-password, lo que era un vector de DoS por CPU. SHA-256 es O(1) y
// suficiente: el hash en BD es preimage-resistente y un atacante con la BD
// robada no puede revertirlo a un token usable.
function hashResetToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// ───── Rate limits ─────
// Cada IP solo puede hacer N intentos dentro de la ventana. Mensajes en JSON
// para que el frontend pueda mostrarlos.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8, // 8 intentos / 15 min / IP
  standardHeaders: true,
  legacyHeaders: false,
  message: errResp(RC.RL_LOGIN, 'Too many login attempts. Wait 15 minutes before trying again.'),
});

const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5, // 5 cuentas/hora/IP
  standardHeaders: true,
  legacyHeaders: false,
  message: errResp(RC.RL_SIGNUP, 'Too many accounts created from this IP. Wait one hour.'),
});

const forgotLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3, // 3 solicitudes de reset/hora/IP
  standardHeaders: true,
  legacyHeaders: false,
  message: errResp(RC.RL_FORGOT, 'Too many requests. Wait one hour.'),
});

const codeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5, // 5 verificaciones de código / 15 min / IP
  standardHeaders: true,
  legacyHeaders: false,
  message: errResp(RC.RL_CODE, 'Too many code attempts. Wait a few minutes.'),
});

// ───── Password policy unificada ─────
// Devuelve { code, fallback } si hay error, o null si la contraseña es válida.
type PwError = { code: string; fallback: string };
function validatePassword(pw: string): PwError | null {
  if (typeof pw !== 'string') return { code: RC.AUTH_PASSWORD_REQUIRED, fallback: 'Password required' };
  if (pw.length < 8) return { code: RC.AUTH_PASSWORD_TOO_SHORT, fallback: 'Password must be at least 8 characters' };
  if (pw.length > 128) return { code: RC.AUTH_PASSWORD_TOO_LONG, fallback: 'Password is too long' };
  if (!/[A-Z]/.test(pw)) return { code: RC.AUTH_PASSWORD_NEEDS_UPPER, fallback: 'Password must contain at least one uppercase letter' };
  if (!/[a-z]/.test(pw)) return { code: RC.AUTH_PASSWORD_NEEDS_LOWER, fallback: 'Password must contain at least one lowercase letter' };
  if (!/\d/.test(pw)) return { code: RC.AUTH_PASSWORD_NEEDS_DIGIT, fallback: 'Password must contain at least one number' };
  return null;
}

// Oculta el email para mostrarlo en la UI (juan@gmail.com → j***n@gmail.com)
function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return email;
  if (local.length <= 2) return local[0] + '***@' + domain;
  return local[0] + '***' + local[local.length - 1] + '@' + domain;
}

interface SignupBody {
  email: string;
  password: string;
  name: string;
  referralCode?: string;
  lang?: string;
}

interface LoginBody {
  email: string;
  password: string;
}

// Normaliza el lang recibido del cliente. Acepta solo 'es' o 'en'; cualquier
// otra cosa cae a 'es' como default.
function normalizeLang(raw: unknown): 'es' | 'en' {
  return raw === 'en' ? 'en' : 'es';
}

router.post('/signup', signupLimiter, async (req: Request, res: Response) => {
  // Respuesta ÚNICA para evitar enumeración de emails: el atacante no puede
  // distinguir entre "email nuevo creado" y "email ya existe".
  const SAFE_OK = okResp(RC.AUTH_SIGNUP_OK, 'Account created. Sign in to verify your email.', { requiresLogin: true });

  try {
    const raw: SignupBody = req.body || {};
    const email = typeof raw.email === 'string' ? raw.email.trim().toLowerCase() : '';
    const password = typeof raw.password === 'string' ? raw.password : '';
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    const referralCode = typeof raw.referralCode === 'string' ? raw.referralCode.trim() : undefined;
    const lang = normalizeLang(raw.lang);

    if (!email || !password || !name) {
      return res.status(400).json(errResp(RC.AUTH_EMAIL_PASSWORD_NAME_REQUIRED, 'Email, password and name required'));
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json(errResp(RC.AUTH_EMAIL_INVALID, 'Invalid email'));
    }
    if (email.length > 254) {
      return res.status(400).json(errResp(RC.AUTH_EMAIL_TOO_LONG, 'Email too long'));
    }
    const pwError = validatePassword(password);
    if (pwError) return res.status(400).json(errResp(pwError.code, pwError.fallback));
    if (name.length < 2 || name.length > 80) {
      return res.status(400).json(errResp(RC.AUTH_NAME_INVALID, 'Invalid name (2-80 characters)'));
    }

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      // No revelamos al atacante que el email ya existe.
      // Tampoco enviamos email para no quemar cuota de Resend con spam.
      return res.status(201).json(SAFE_OK);
    }

    const hashedPassword = await bcrypt.hash(password, BCRYPT_PASSWORD_COST);

    try {
      await prisma.user.create({
        data: {
          email,
          password: hashedPassword,
          name,
          lang,
          referredBy: referralCode || null,
          emailVerified: false,  // Se verifica en el primer login con un código
        },
      });
    } catch (e: any) {
      // P2002 = race entre el findUnique de arriba y el create. Otro request
      // creó el usuario en medio. Devolvemos SAFE_OK igual que en la rama
      // existingUser para no filtrar al atacante que el email ya existe vía
      // un 500.
      if (e?.code === 'P2002') return res.status(201).json(SAFE_OK);
      throw e;
    }

    // Email de bienvenida (no bloqueante — si falla seguimos)
    try {
      await sendWelcomeEmail(email, name, lang);
    } catch (mailErr: any) {
      console.error('Welcome email send error:', mailErr);
    }

    return res.status(201).json(SAFE_OK);
  } catch (error) {
    console.error(error);
    return res.status(500).json(errResp(RC.SERVER_ERROR, 'Server error'));
  }
});

router.post('/login', loginLimiter, async (req: Request, res: Response) => {
  try {
    const raw: LoginBody = req.body || {};
    const email = typeof raw.email === 'string' ? raw.email.trim().toLowerCase() : '';
    const password = typeof raw.password === 'string' ? raw.password : '';

    if (!email || !password) {
      return res.status(400).json(errResp(RC.AUTH_EMAIL_PASSWORD_REQUIRED, 'Email and password required'));
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res.status(401).json(errResp(RC.AUTH_INVALID_CREDENTIALS, 'Invalid credentials'));
    }

    const passwordMatch = await bcrypt.compare(password, user.password);
    if (!passwordMatch) {
      return res.status(401).json(errResp(RC.AUTH_INVALID_CREDENTIALS, 'Invalid credentials'));
    }

    // Si el email aún no está verificado, mandamos código y pedimos verificación
    // (esto solo ocurre en el primer login tras crear la cuenta)
    if (!user.emailVerified) {
      const code = generateVerificationCode();
      const codeHash = await bcrypt.hash(code, BCRYPT_CODE_COST);
      const issuedAt = new Date();
      const expires = new Date(Date.now() + 15 * 60 * 1000);

      await prisma.user.update({
        where: { id: user.id },
        data: {
          verificationCode: codeHash,
          verificationCodeIssuedAt: issuedAt,
          verificationCodeExpires: expires,
          verificationAttempts: 0,
        },
      });

      try {
        await sendLoginCodeEmail(user.email, user.name, code, user.lang as any);
      } catch (mailErr: any) {
        console.error('Login code email error:', mailErr);
        return res.status(500).json(errResp(RC.AUTH_CODE_SEND_FAIL, 'Could not send the code. Try again.'));
      }

      const pendingToken = jwt.sign(
        { type: 'pending-login', userId: user.id },
        JWT_SECRET,
        { expiresIn: '15m' }
      );

      return res.json({
        requiresMFA: true,
        pendingToken,
        emailHint: maskEmail(user.email),
      });
    }

    // Email ya verificado: login normal, token directo
    const token = issueSessionToken({ id: user.id, email: user.email, tokenVersion: user.tokenVersion });

    res.json({
      ...okResp(RC.AUTH_LOGIN_OK, 'Login successful'),
      user: { id: user.id, email: user.email, name: user.name, emailVerified: user.emailVerified },
      token,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json(errResp(RC.SERVER_ERROR, 'Server error'));
  }
});

router.get('/me', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { id: true, email: true, name: true, emailVerified: true, createdAt: true },
    });

    if (!user) {
      return res.status(404).json(errResp(RC.USER_NOT_FOUND, 'User not found'));
    }

    res.json(user);
  } catch (error) {
    console.error(error);
    res.status(500).json(errResp(RC.SERVER_ERROR, 'Server error'));
  }
});

// Actualizar perfil. Solo el nombre cambia inmediatamente; el email exige
// confirmar con un código enviado al NUEVO email antes de aplicarse.
router.put('/me', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const raw = req.body || {};

    // Nombre: cambio directo si llega
    let nameUpdated = false;
    if (typeof raw.name === 'string') {
      const name = raw.name.trim();
      if (name.length < 2 || name.length > 80) {
        return res.status(400).json(errResp(RC.AUTH_NAME_INVALID, 'Invalid name (2-80 characters)'));
      }
      await prisma.user.update({ where: { id: req.userId }, data: { name } });
      nameUpdated = true;
    }

    // Email: NO se cambia aún, se envía código al nuevo email para confirmar
    let emailChangeRequested = false;
    let emailHint: string | undefined;
    if (typeof raw.email === 'string') {
      const newEmail = raw.email.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
        return res.status(400).json(errResp(RC.AUTH_EMAIL_INVALID, 'Invalid email'));
      }

      const me = await prisma.user.findUnique({ where: { id: req.userId } });
      if (!me) return res.status(404).json(errResp(RC.USER_NOT_FOUND, 'User not found'));

      // Si el usuario "cambia" al mismo que ya tiene, no hacemos nada
      if (newEmail === me.email) {
        // No es error pero no toca el email
      } else {
        const existing = await prisma.user.findUnique({ where: { email: newEmail } });
        if (existing && existing.id !== req.userId) {
          return res.status(409).json(errResp(RC.AUTH_EMAIL_IN_USE, 'That email is already in use'));
        }

        const code = generateVerificationCode();
        const codeHash = await bcrypt.hash(code, BCRYPT_CODE_COST);
        const issuedAt = new Date();
        const expires = new Date(Date.now() + 15 * 60 * 1000);

        await prisma.user.update({
          where: { id: req.userId },
          data: {
            pendingEmail: newEmail,
            verificationCode: codeHash,
            verificationCodeIssuedAt: issuedAt,
            verificationCodeExpires: expires,
            verificationAttempts: 0,
          },
        });

        try {
          await sendEmailChangeCode(newEmail, me.name, code, me.email, me.lang as any);
        } catch (mailErr: any) {
          console.error('Email change code send error:', mailErr);
          // Limpiamos para no dejar estado inconsistente
          await prisma.user.update({
            where: { id: req.userId },
            data: { pendingEmail: null, verificationCode: null, verificationCodeIssuedAt: null, verificationCodeExpires: null },
          });
          return res.status(500).json(errResp(RC.AUTH_CODE_SEND_FAIL, 'Could not send the code to the new email'));
        }

        emailChangeRequested = true;
        emailHint = maskEmail(newEmail);
      }
    }

    if (!nameUpdated && !emailChangeRequested) {
      return res.status(400).json(errResp(RC.AUTH_NOTHING_TO_UPDATE, 'Nothing to update'));
    }

    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { id: true, email: true, name: true, emailVerified: true, createdAt: true },
    });

    res.json({
      ...okResp(
        emailChangeRequested ? RC.AUTH_EMAIL_CHANGE_REQUESTED : RC.AUTH_PROFILE_UPDATED,
        emailChangeRequested ? 'We sent a code to your new email' : 'Profile updated',
      ),
      user,
      emailChangeRequested,
      emailHint,
    });
  } catch (error: any) {
    console.error(error);
    res.status(500).json(errResp(RC.SERVER_ERROR, 'Server error'));
  }
});

// Confirmar cambio de email con el código enviado al nuevo
router.post('/verify-email-change', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
    if (!/^\d{6}$/.test(code)) {
      return res.status(400).json(errResp(RC.AUTH_CODE_INVALID_FORMAT, 'Invalid code (6 digits)'));
    }

    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user) return res.status(404).json(errResp(RC.USER_NOT_FOUND, 'User not found'));

    if (!user.pendingEmail || !user.verificationCode || !user.verificationCodeExpires) {
      return res.status(400).json(errResp(RC.AUTH_NO_PENDING_EMAIL_CHANGE, 'No pending email change'));
    }
    if (user.verificationCodeExpires.getTime() < Date.now()) {
      return res.status(400).json(errResp(RC.AUTH_CODE_EXPIRED, 'The code has expired. Request the change again.'));
    }
    if ((user.verificationAttempts || 0) >= 5) {
      return res.status(429).json(errResp(RC.AUTH_CODE_TOO_MANY_ATTEMPTS, 'Too many attempts. Request the change again.'));
    }

    const match = await bcrypt.compare(code, user.verificationCode);
    if (!match) {
      await prisma.user.update({
        where: { id: user.id },
        data: { verificationAttempts: { increment: 1 } },
      });
      return res.status(401).json(errResp(RC.AUTH_CODE_INCORRECT, 'Incorrect code'));
    }

    // Verificar de nuevo que el email no haya sido tomado mientras tanto
    const taken = await prisma.user.findUnique({ where: { email: user.pendingEmail } });
    if (taken && taken.id !== user.id) {
      await prisma.user.update({
        where: { id: user.id },
        data: { pendingEmail: null, verificationCode: null, verificationCodeIssuedAt: null, verificationCodeExpires: null, verificationAttempts: 0 },
      });
      return res.status(409).json(errResp(RC.AUTH_EMAIL_TAKEN_DURING_CHANGE, 'That email was registered while you waited. Try another.'));
    }

    // Bumpeamos tokenVersion para invalidar todas las sesiones existentes:
    // si el email cambia (puede ser señal de cuenta comprometida), forzamos
    // re-login en todos los dispositivos del usuario.
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        email: user.pendingEmail,
        pendingEmail: null,
        verificationCode: null,
        verificationCodeIssuedAt: null,
        verificationCodeExpires: null,
        verificationAttempts: 0,
        tokenVersion: { increment: 1 },
      },
      select: { id: true, email: true, name: true, emailVerified: true, createdAt: true, tokenVersion: true },
    });

    // Token nuevo con la nueva tokenVersion para que el cliente no se quede
    // fuera tras el bump (los demás dispositivos sí caen, este sigue dentro).
    const token = issueSessionToken({ id: updated.id, email: updated.email, tokenVersion: updated.tokenVersion });

    res.json({ ...okResp(RC.AUTH_EMAIL_UPDATED, 'Email updated'), user: updated, token });
  } catch (error: any) {
    console.error(error);
    res.status(500).json(errResp(RC.SERVER_ERROR, 'Server error'));
  }
});

// Verificar el código del login (MFA) y devolver el token de sesión real
router.post('/verify-login', codeLimiter, async (req: Request, res: Response) => {
  try {
    const pendingToken = typeof req.body?.pendingToken === 'string' ? req.body.pendingToken : '';
    const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';

    if (!pendingToken) return res.status(400).json(errResp(RC.AUTH_LOGIN_PENDING_REQUIRED, 'Login token required'));
    if (!/^\d{6}$/.test(code)) {
      return res.status(400).json(errResp(RC.AUTH_CODE_INVALID_FORMAT, 'Invalid code (must be 6 digits)'));
    }

    let payload: any;
    try {
      payload = jwt.verify(pendingToken, JWT_SECRET);
    } catch {
      return res.status(401).json(errResp(RC.AUTH_LOGIN_PENDING_EXPIRED, 'Login attempt has expired. Sign in again.'));
    }
    if (payload?.type !== 'pending-login' || !payload.userId) {
      return res.status(401).json(errResp(RC.AUTH_LOGIN_PENDING_INVALID, 'Invalid login token'));
    }

    const user = await prisma.user.findUnique({ where: { id: payload.userId } });
    if (!user) return res.status(404).json(errResp(RC.USER_NOT_FOUND, 'User not found'));

    if (!user.verificationCode || !user.verificationCodeExpires) {
      return res.status(400).json(errResp(RC.AUTH_NO_PENDING_CODE, 'No pending code. Sign in again.'));
    }
    if (user.verificationCodeExpires.getTime() < Date.now()) {
      return res.status(400).json(errResp(RC.AUTH_CODE_EXPIRED, 'The code has expired. Sign in again.'));
    }
    if ((user.verificationAttempts || 0) >= 5) {
      return res.status(429).json(errResp(RC.AUTH_CODE_TOO_MANY_ATTEMPTS, 'Too many attempts. Sign in again.'));
    }

    const match = await bcrypt.compare(code, user.verificationCode);
    if (!match) {
      await prisma.user.update({
        where: { id: user.id },
        data: { verificationAttempts: { increment: 1 } },
      });
      return res.status(401).json(errResp(RC.AUTH_CODE_INCORRECT, 'Incorrect code'));
    }

    // Marca el email como verificado, limpia el código y emite el token real
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerified: true,
        verificationCode: null,
        verificationCodeIssuedAt: null,
        verificationCodeExpires: null,
        verificationAttempts: 0,
      },
    });

    const token = issueSessionToken({ id: updated.id, email: updated.email, tokenVersion: updated.tokenVersion });

    res.json({
      ...okResp(RC.AUTH_LOGIN_COMPLETE, 'Login complete'),
      user: { id: updated.id, email: updated.email, name: updated.name, emailVerified: updated.emailVerified },
      token,
    });
  } catch (error: any) {
    console.error(error);
    res.status(500).json(errResp(RC.SERVER_ERROR, 'Server error'));
  }
});

// Reenviar el código del login
router.post('/resend-login-code', codeLimiter, async (req: Request, res: Response) => {
  try {
    const pendingToken = typeof req.body?.pendingToken === 'string' ? req.body.pendingToken : '';
    if (!pendingToken) return res.status(400).json(errResp(RC.AUTH_LOGIN_PENDING_REQUIRED, 'Login token required'));

    let payload: any;
    try {
      payload = jwt.verify(pendingToken, JWT_SECRET);
    } catch {
      return res.status(401).json(errResp(RC.AUTH_LOGIN_PENDING_EXPIRED, 'Login attempt has expired. Sign in again.'));
    }
    if (payload?.type !== 'pending-login' || !payload.userId) {
      return res.status(401).json(errResp(RC.AUTH_LOGIN_PENDING_INVALID, 'Invalid login token'));
    }

    const user = await prisma.user.findUnique({ where: { id: payload.userId } });
    if (!user) return res.status(404).json(errResp(RC.USER_NOT_FOUND, 'User not found'));

    // Rate limit: si el código se emitió hace < 60s, bloquea reenvío. Antes
    // calculábamos issuedAt como expires-10min, lo que daba false positives
    // cada vez que cambiábamos la duración del código (login emite a 15min,
    // resend emite a 10min — los cálculos quedaban fuera de fase).
    if (user.verificationCodeIssuedAt) {
      const sinceIssued = Date.now() - user.verificationCodeIssuedAt.getTime();
      if (sinceIssued < 60 * 1000) {
        return res.status(429).json(errResp(RC.AUTH_CODE_RESEND_COOLDOWN, 'Wait a minute before requesting another code'));
      }
    }

    const code = generateVerificationCode();
    const codeHash = await bcrypt.hash(code, BCRYPT_CODE_COST);
    const issuedAt = new Date();
    const expires = new Date(Date.now() + 10 * 60 * 1000);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        verificationCode: codeHash,
        verificationCodeIssuedAt: issuedAt,
        verificationCodeExpires: expires,
        verificationAttempts: 0,
      },
    });

    try {
      await sendLoginCodeEmail(user.email, user.name, code, user.lang as any);
    } catch (mailErr: any) {
      console.error('Login code resend error:', mailErr);
      return res.status(500).json(errResp(RC.AUTH_CODE_SEND_FAIL, 'Could not send the email. Try again.'));
    }

    res.json(okResp(RC.AUTH_CODE_SENT, 'Code sent'));
  } catch (error: any) {
    console.error(error);
    res.status(500).json(errResp(RC.SERVER_ERROR, 'Server error'));
  }
});

// Solicitar reset de contraseña — envía email con enlace
router.post('/forgot-password', forgotLimiter, async (req: Request, res: Response) => {
  // Respuesta SIEMPRE igual (haya o no usuario) para evitar enumeración de emails
  const SAFE_OK = okResp(RC.AUTH_FORGOT_OK, 'If that email is registered, you will receive a link shortly.');

  try {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.json(SAFE_OK);
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.json(SAFE_OK);

    // Rate limit: si hay un token vivo emitido hace < 60s, no reenviamos.
    // Calculamos issuedAt como expires-1h (la duración fija del token de reset).
    if (user.resetTokenExpires) {
      const issuedAtMs = user.resetTokenExpires.getTime() - 60 * 60 * 1000;
      if (Date.now() - issuedAtMs < 60 * 1000) {
        return res.json(SAFE_OK);
      }
    }

    const token = generateResetToken();
    const tokenHash = hashResetToken(token); // SHA-256: el token ya tiene 256 bits de entropía
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hora

    await prisma.user.update({
      where: { id: user.id },
      data: { resetToken: tokenHash, resetTokenExpires: expires },
    });

    const frontendBase = process.env.FRONTEND_URL || 'https://yudbot.com';
    // El reset URL apunta al app del idioma del usuario para que la pantalla
    // donde introduzca la contraseña esté en su idioma.
    const appPath = user.lang === 'en' ? '/en/app' : '/app';
    const resetUrl = `${frontendBase}${appPath}?reset=${token}&id=${user.id}`;

    try {
      await sendPasswordResetEmail(user.email, user.name, resetUrl, user.lang as any);
    } catch (mailErr: any) {
      console.error('Reset email send error:', mailErr);
      // Limpiar token para no dejar estado inconsistente
      await prisma.user.update({
        where: { id: user.id },
        data: { resetToken: null, resetTokenExpires: null },
      });
      return res.status(500).json(errResp(RC.AUTH_RESET_EMAIL_FAIL, 'Could not send the email'));
    }

    return res.json(SAFE_OK);
  } catch (error: any) {
    console.error(error);
    // Mismo mensaje seguro
    return res.json(SAFE_OK);
  }
});

// Aplicar nueva contraseña usando el token del email.
// IMPORTANTE: lookup por hash (SHA-256), no bcrypt-compare. El token de 32
// bytes random ya tiene 256 bits de entropía — bcrypt no añade seguridad y
// hace cada request 80ms+ de CPU, lo que sin rate limit era un vector de
// DoS. Aplicamos forgotLimiter (3/h por IP) además.
router.post('/reset-password', forgotLimiter, async (req: Request, res: Response) => {
  try {
    const userId = typeof req.body?.userId === 'string' ? req.body.userId : '';
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';

    if (!userId || !token) {
      return res.status(400).json(errResp(RC.AUTH_RESET_LINK_INVALID, 'Invalid link'));
    }
    // Validamos formato del token antes de tocar la BD: 64 chars hex (32 bytes).
    if (!/^[a-f0-9]{64}$/i.test(token)) {
      return res.status(400).json(errResp(RC.AUTH_RESET_LINK_INVALID, 'Invalid link'));
    }
    if (newPassword.length < 8) {
      return res.status(400).json(errResp(RC.AUTH_PASSWORD_TOO_SHORT, 'Password must be at least 8 characters'));
    }
    if (!/[A-Z]/.test(newPassword) || !/\d/.test(newPassword)) {
      return res.status(400).json(errResp(RC.AUTH_PASSWORD_NEEDS_UPPER_DIGIT, 'Password must contain an uppercase letter and a number'));
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.resetToken || !user.resetTokenExpires) {
      return res.status(400).json(errResp(RC.AUTH_RESET_LINK_INVALID, 'Link invalid or already used. Request a new one.'));
    }
    if (user.resetTokenExpires.getTime() < Date.now()) {
      return res.status(400).json(errResp(RC.AUTH_RESET_LINK_EXPIRED, 'The link has expired. Request a new one.'));
    }

    // Comparación timing-safe sobre el hash. Si la BD aún tiene un hash
    // bcrypt heredado (antes de la migración a SHA-256), caemos al
    // bcrypt-compare como compatibilidad. Tras este endpoint el campo se
    // sobrescribirá con null, así que cada usuario solo paga ese coste una vez.
    const candidateHash = hashResetToken(token);
    const storedHashIsBcrypt = user.resetToken.startsWith('$2');
    let match = false;
    if (storedHashIsBcrypt) {
      match = await bcrypt.compare(token, user.resetToken);
    } else {
      const a = Buffer.from(candidateHash, 'utf8');
      const b = Buffer.from(user.resetToken, 'utf8');
      match = a.length === b.length && crypto.timingSafeEqual(a, b);
    }
    if (!match) {
      return res.status(400).json(errResp(RC.AUTH_RESET_LINK_INVALID, 'Link invalid or already used. Request a new one.'));
    }

    const hashed = await bcrypt.hash(newPassword, BCRYPT_PASSWORD_COST);
    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashed,
        resetToken: null,
        resetTokenExpires: null,
        // Invalidar también cualquier MFA pendiente para forzar login limpio
        verificationCode: null,
        verificationCodeIssuedAt: null,
        verificationCodeExpires: null,
        verificationAttempts: 0,
        // Cambio de contraseña → invalidar todas las sesiones existentes
        tokenVersion: { increment: 1 },
      },
    });

    res.json(okResp(RC.AUTH_PASSWORD_RESET_OK, 'Password reset. You can sign in now.'));
  } catch (error: any) {
    console.error(error);
    res.status(500).json(errResp(RC.SERVER_ERROR, 'Server error'));
  }
});

// Cambiar contraseña
router.post('/change-password', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
      return res.status(400).json(errResp(RC.AUTH_PASSWORDS_REQUIRED, 'Current and new password are required'));
    }
    if (newPassword.length < 8) {
      return res.status(400).json(errResp(RC.AUTH_PASSWORD_TOO_SHORT, 'New password must be at least 8 characters'));
    }
    if (!/[A-Z]/.test(newPassword) || !/\d/.test(newPassword)) {
      return res.status(400).json(errResp(RC.AUTH_PASSWORD_NEEDS_UPPER_DIGIT, 'New password must contain an uppercase letter and a number'));
    }
    if (currentPassword === newPassword) {
      return res.status(400).json(errResp(RC.AUTH_PASSWORD_SAME_AS_CURRENT, 'New password must differ from the current one'));
    }

    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user) return res.status(404).json(errResp(RC.USER_NOT_FOUND, 'User not found'));

    const match = await bcrypt.compare(currentPassword, user.password);
    if (!match) return res.status(401).json(errResp(RC.AUTH_CURRENT_PASSWORD_WRONG, 'Current password is incorrect'));

    const hashed = await bcrypt.hash(newPassword, BCRYPT_PASSWORD_COST);
    // Cambio de contraseña → invalidar todas las sesiones existentes salvo
    // ésta. Devolvemos un token nuevo con la nueva tokenVersion.
    const updated = await prisma.user.update({
      where: { id: req.userId },
      data: { password: hashed, tokenVersion: { increment: 1 } },
      select: { id: true, email: true, tokenVersion: true },
    });
    const token = issueSessionToken({ id: updated.id, email: updated.email, tokenVersion: updated.tokenVersion });

    res.json({ ...okResp(RC.AUTH_PASSWORD_UPDATED, 'Password updated'), token });
  } catch (error: any) {
    console.error(error);
    res.status(500).json(errResp(RC.SERVER_ERROR, 'Server error'));
  }
});

// Cambia el idioma preferido para los emails. El frontend llama a este
// endpoint cuando el usuario pulsa el toggle ES/EN en la cuenta. La sesión
// no se invalida (no es un cambio sensible).
router.post('/lang', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const lang = normalizeLang(req.body?.lang);
    await prisma.user.update({ where: { id: req.userId }, data: { lang } });
    res.json({ ...okResp(RC.AUTH_LANG_UPDATED, 'Language updated'), lang });
  } catch (error: any) {
    console.error(error);
    res.status(500).json(errResp(RC.SERVER_ERROR, 'Server error'));
  }
});

export default router;
