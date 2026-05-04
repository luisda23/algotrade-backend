import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma } from '../server';
import { authenticateToken, AuthRequest, JWT_SECRET } from '../middleware/auth';
import { sendVerificationEmail, generateVerificationCode } from '../utils/email';

const router = Router();

interface SignupBody {
  email: string;
  password: string;
  name: string;
  referralCode?: string;
}

interface LoginBody {
  email: string;
  password: string;
}

router.post('/signup', async (req: Request, res: Response) => {
  try {
    const raw: SignupBody = req.body || {};
    const email = typeof raw.email === 'string' ? raw.email.trim().toLowerCase() : '';
    const password = typeof raw.password === 'string' ? raw.password : '';
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    const referralCode = typeof raw.referralCode === 'string' ? raw.referralCode.trim() : undefined;

    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, contraseña y nombre requeridos' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Email no válido' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    }
    if (name.length > 80) {
      return res.status(400).json({ error: 'El nombre es demasiado largo' });
    }

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return res.status(409).json({ error: 'El usuario ya existe' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const code = generateVerificationCode();
    const codeHash = await bcrypt.hash(code, 10);
    const expires = new Date(Date.now() + 15 * 60 * 1000); // 15 min

    const newUser = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        name,
        referredBy: referralCode || null,
        emailVerified: false,
        verificationCode: codeHash,
        verificationCodeExpires: expires,
        verificationAttempts: 0,
      },
    });

    // Enviar email de verificación. Si falla, dejamos al usuario creado pero
    // le devolvemos un error claro para que pida un reenvío desde el frontend.
    try {
      await sendVerificationEmail(email, name, code);
    } catch (mailErr: any) {
      console.error('Email send error:', mailErr);
      // El usuario existe pero el email no se envió — frontend mostrará UI para reenviar
    }

    const token = jwt.sign(
      { userId: newUser.id, email: newUser.email },
      JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRATION || '7d' } as any
    );

    res.status(201).json({
      message: 'Usuario creado exitosamente',
      user: {
        id: newUser.id,
        email: newUser.email,
        name: newUser.name,
        emailVerified: newUser.emailVerified,
      },
      token,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error en el servidor' });
  }
});

router.post('/login', async (req: Request, res: Response) => {
  try {
    const raw: LoginBody = req.body || {};
    const email = typeof raw.email === 'string' ? raw.email.trim().toLowerCase() : '';
    const password = typeof raw.password === 'string' ? raw.password : '';

    if (!email || !password) {
      return res.status(400).json({ error: 'Email y contraseña requeridos' });
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const passwordMatch = await bcrypt.compare(password, user.password);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const token = jwt.sign(
      { userId: user.id, email: user.email },
      JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRATION || '7d' } as any
    );

    res.json({
      message: 'Login exitoso',
      user: { id: user.id, email: user.email, name: user.name, emailVerified: user.emailVerified },
      token,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error en el servidor' });
  }
});

router.get('/me', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { id: true, email: true, name: true, emailVerified: true, createdAt: true },
    });

    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    res.json(user);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error en el servidor' });
  }
});

// Actualizar perfil (nombre y/o email)
router.put('/me', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const raw = req.body || {};
    const data: any = {};

    if (typeof raw.name === 'string') {
      const name = raw.name.trim();
      if (name.length < 2 || name.length > 80) {
        return res.status(400).json({ error: 'Nombre inválido (2-80 caracteres)' });
      }
      data.name = name;
    }

    if (typeof raw.email === 'string') {
      const email = raw.email.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Email no válido' });
      }
      // Verificar que no esté en uso por otro usuario
      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing && existing.id !== req.userId) {
        return res.status(409).json({ error: 'Ese email ya está en uso' });
      }
      data.email = email;
    }

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: 'Nada que actualizar' });
    }

    const user = await prisma.user.update({
      where: { id: req.userId },
      data,
      select: { id: true, email: true, name: true, emailVerified: true, createdAt: true },
    });

    res.json({ message: 'Perfil actualizado', user });
  } catch (error: any) {
    console.error(error);
    res.status(500).json({ error: 'Error en el servidor' });
  }
});

// Verificar email con código
router.post('/verify', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
    if (!/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: 'Código inválido (debe tener 6 dígitos)' });
    }

    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    if (user.emailVerified) {
      return res.json({ message: 'Email ya verificado', verified: true });
    }

    if (!user.verificationCode || !user.verificationCodeExpires) {
      return res.status(400).json({ error: 'No hay código pendiente. Pide uno nuevo.' });
    }

    if (user.verificationCodeExpires.getTime() < Date.now()) {
      return res.status(400).json({ error: 'El código ha caducado. Pide uno nuevo.' });
    }

    if ((user.verificationAttempts || 0) >= 5) {
      return res.status(429).json({ error: 'Demasiados intentos. Pide un código nuevo.' });
    }

    const match = await bcrypt.compare(code, user.verificationCode);
    if (!match) {
      await prisma.user.update({
        where: { id: user.id },
        data: { verificationAttempts: { increment: 1 } },
      });
      return res.status(401).json({ error: 'Código incorrecto' });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerified: true,
        verificationCode: null,
        verificationCodeExpires: null,
        verificationAttempts: 0,
      },
    });

    res.json({ message: 'Email verificado correctamente', verified: true });
  } catch (error: any) {
    console.error(error);
    res.status(500).json({ error: 'Error en el servidor' });
  }
});

// Reenviar código de verificación
router.post('/resend-verification', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (user.emailVerified) return res.json({ message: 'Ya verificado' });

    // Rate limit: solo se puede pedir reenvío si el código actual lleva > 60s emitido
    if (user.verificationCodeExpires) {
      const issuedAt = user.verificationCodeExpires.getTime() - 15 * 60 * 1000;
      const sinceIssued = Date.now() - issuedAt;
      if (sinceIssued < 60 * 1000) {
        return res.status(429).json({ error: 'Espera un minuto antes de pedir otro código' });
      }
    }

    const code = generateVerificationCode();
    const codeHash = await bcrypt.hash(code, 10);
    const expires = new Date(Date.now() + 15 * 60 * 1000);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        verificationCode: codeHash,
        verificationCodeExpires: expires,
        verificationAttempts: 0,
      },
    });

    try {
      await sendVerificationEmail(user.email, user.name, code);
    } catch (mailErr: any) {
      console.error('Email resend error:', mailErr);
      return res.status(500).json({ error: 'No se pudo enviar el email. Intenta de nuevo.' });
    }

    res.json({ message: 'Código enviado' });
  } catch (error: any) {
    console.error(error);
    res.status(500).json({ error: 'Error en el servidor' });
  }
});

// Cambiar contraseña
router.post('/change-password', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
      return res.status(400).json({ error: 'Contraseña actual y nueva son requeridas' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 8 caracteres' });
    }
    if (!/[A-Z]/.test(newPassword) || !/\d/.test(newPassword)) {
      return res.status(400).json({ error: 'La nueva contraseña necesita una mayúscula y un número' });
    }
    if (currentPassword === newPassword) {
      return res.status(400).json({ error: 'La nueva contraseña debe ser distinta de la actual' });
    }

    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    const match = await bcrypt.compare(currentPassword, user.password);
    if (!match) return res.status(401).json({ error: 'La contraseña actual no es correcta' });

    const hashed = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({ where: { id: req.userId }, data: { password: hashed } });

    res.json({ message: 'Contraseña actualizada' });
  } catch (error: any) {
    console.error(error);
    res.status(500).json({ error: 'Error en el servidor' });
  }
});

export default router;
