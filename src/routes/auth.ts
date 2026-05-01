import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma } from '../server';
import { authenticateToken, AuthRequest } from '../middleware/auth';

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
    const { email, password, name, referralCode }: SignupBody = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, contraseña y nombre requeridos' });
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
        referredBy: referralCode,
      },
    });

    const token = jwt.sign(
      { userId: newUser.id, email: newUser.email },
      process.env.JWT_SECRET || 'secret',
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
    const { email, password }: LoginBody = req.body;

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
      process.env.JWT_SECRET || 'secret',
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

export default router;
