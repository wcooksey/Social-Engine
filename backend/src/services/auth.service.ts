import bcrypt from 'bcrypt';
import { prisma } from '../config/database';
import { AppError } from '../middleware/error.middleware';
import { JwtPayload, signAccessToken, signRefreshToken, verifyRefreshToken } from '../utils/jwt';
import { isSuperAdmin } from './settings.service';

const SALT_ROUNDS = 10;

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function serializeUser(user: {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  organization: { id: string; name: string; slug: string };
}) {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    role: user.role,
    isSuperAdmin: isSuperAdmin(user.email),
    organization: {
      id: user.organization.id,
      name: user.organization.name,
      slug: user.organization.slug,
    },
  };
}

function issueTokens(payload: JwtPayload) {
  return {
    token: signAccessToken(payload),
    refreshToken: signRefreshToken(payload),
  };
}

class AuthService {
  async register(input: {
    email: string;
    password: string;
    firstName: string;
    lastName: string;
    organizationName: string;
  }) {
    const email = input.email.toLowerCase().trim();
    if (!email || !input.password || !input.firstName || !input.organizationName) {
      throw new AppError('Missing required fields');
    }
    if (input.password.length < 8) {
      throw new AppError('Password must be at least 8 characters');
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) throw new AppError('An account with this email already exists', 409);

    let slug = slugify(input.organizationName) || 'org';
    const slugTaken = await prisma.organization.findUnique({ where: { slug } });
    if (slugTaken) slug = `${slug}-${Math.random().toString(36).slice(2, 8)}`;

    const passwordHash = await bcrypt.hash(input.password, SALT_ROUNDS);

    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        firstName: input.firstName.trim(),
        lastName: (input.lastName || '').trim(),
        role: 'OWNER',
        organization: {
          create: { name: input.organizationName.trim(), slug },
        },
      },
      include: { organization: true },
    });

    const payload: JwtPayload = {
      userId: user.id,
      email: user.email,
      organizationId: user.organizationId,
      role: user.role,
    };
    return { ...issueTokens(payload), user: serializeUser(user) };
  }

  async login(email: string, password: string) {
    const user = await prisma.user.findUnique({
      where: { email: (email || '').toLowerCase().trim() },
      include: { organization: true },
    });
    if (!user || !user.isActive) throw new AppError('Invalid email or password', 401);

    const valid = await bcrypt.compare(password || '', user.passwordHash);
    if (!valid) throw new AppError('Invalid email or password', 401);

    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

    const payload: JwtPayload = {
      userId: user.id,
      email: user.email,
      organizationId: user.organizationId,
      role: user.role,
    };
    return { ...issueTokens(payload), user: serializeUser(user) };
  }

  async refresh(refreshToken: string) {
    let payload: JwtPayload;
    try {
      payload = verifyRefreshToken(refreshToken);
    } catch {
      throw new AppError('Invalid refresh token', 401);
    }
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      include: { organization: true },
    });
    if (!user || !user.isActive) throw new AppError('Invalid refresh token', 401);

    const fresh: JwtPayload = {
      userId: user.id,
      email: user.email,
      organizationId: user.organizationId,
      role: user.role,
    };
    return { ...issueTokens(fresh), user: serializeUser(user) };
  }

  async me(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { organization: true },
    });
    if (!user) throw new AppError('User not found', 404);
    return serializeUser(user);
  }
}

export const authService = new AuthService();
