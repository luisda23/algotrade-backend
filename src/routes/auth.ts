import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma } from '../server';
import { authenticateToken, AuthRequest, JWT_SECRET } from '../middleware/auth';

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
    const newUser = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        name,
        referredBy: referralCode || null,
      },
    });

    const token = jwt.sign(
      { userId: newUser.id, email: newUser.email },
      JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRATION || '7d' } as any
    );

    res.status(201).json({
      message: 'Usuario creado exitosamente',
      user: { id: newUser.id, email: newUser.email, name: newUser.name },
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
      user: { id: user.id, email: user.email, name: user.name },
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
      select: { id: true, email: true, name: true, createdAt: true },
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
      select: { id: true, email: true, name: true, createdAt: true },
    });

    res.json({ message: 'Perfil actualizado', user });
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
