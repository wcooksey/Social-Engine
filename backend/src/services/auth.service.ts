import bcrypt from 'bcrypt';
import { prisma } from '../config/database';
import { AppError } from '../middleware/error.middleware';
import { JwtPayload, signAccessToken, signRefreshToken, verifyRefreshToken } from '../utils/jwt';
import { isSuperAdmin } from './settings.service';
import { forgetUserState } from '../middleware/auth.middleware';

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
  notifyByEmail?: boolean;
  organization: { id: string; name: string; slug: string };
}) {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    role: user.role,
    isSuperAdmin: isSuperAdmin(user.email),
    notifyByEmail: user.notifyByEmail ?? true,
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
      tv: user.tokenVersion,
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
      tv: user.tokenVersion,
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
    // Reject tokens issued before a logout / password change bumped the version.
    if ((payload.tv ?? 0) !== user.tokenVersion) {
      throw new AppError('Session expired, please sign in again', 401);
    }

    const fresh: JwtPayload = {
      userId: user.id,
      email: user.email,
      organizationId: user.organizationId,
      role: user.role,
      tv: user.tokenVersion,
    };
    return { ...issueTokens(fresh), user: serializeUser(user) };
  }

  /** Invalidate all issued tokens for a user (logout-everywhere / password change). */
  async revokeTokens(userId: string): Promise<void> {
    await prisma.user.update({
      where: { id: userId },
      data: { tokenVersion: { increment: 1 } },
    });
    // The auth middleware caches this for a few seconds; clear it so the
    // revocation bites on the very next request rather than after the window.
    forgetUserState(userId);
  }

  /**
   * Update the signed-in user's own name and email. Changing the email rotates
   * the login identity, so it requires the current password and invalidates
   * every issued token — the caller gets a fresh pair back.
   */
  async updateProfile(
    userId: string,
    input: { firstName?: string; lastName?: string; email?: string; currentPassword?: string }
  ) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new AppError('User not found', 404);

    const data: { firstName?: string; lastName?: string; email?: string; tokenVersion?: { increment: number } } = {};

    if (input.firstName !== undefined) {
      const firstName = input.firstName.trim();
      if (!firstName) throw new AppError('First name cannot be empty');
      data.firstName = firstName;
    }
    if (input.lastName !== undefined) data.lastName = input.lastName.trim();

    const newEmail = input.email?.toLowerCase().trim();
    const emailChanged = !!newEmail && newEmail !== user.email;
    if (emailChanged) {
      if (!newEmail!.includes('@')) throw new AppError('Enter a valid email address');
      const valid = await bcrypt.compare(input.currentPassword || '', user.passwordHash);
      if (!valid) throw new AppError('Current password is incorrect', 401);

      // Super admin is decided by email match, so letting any account rename
      // itself into SUPER_ADMIN_EMAIL would be a free privilege escalation.
      // (Claiming it at registration is the intended bootstrap and still works.)
      if (isSuperAdmin(newEmail) && !isSuperAdmin(user.email)) {
        throw new AppError('That email address is reserved', 403);
      }

      const taken = await prisma.user.findUnique({ where: { email: newEmail! } });
      if (taken) throw new AppError('An account with this email already exists', 409);

      data.email = newEmail;
      data.tokenVersion = { increment: 1 };
    }

    const updated = await prisma.user.update({
      where: { id: user.id },
      data,
      include: { organization: true },
    });

    const serialized = serializeUser(updated);
    if (!emailChanged) return { user: serialized };

    // Re-issue on the new token version so the caller isn't logged out.
    const payload: JwtPayload = {
      userId: updated.id,
      email: updated.email,
      organizationId: updated.organizationId,
      role: updated.role,
      tv: updated.tokenVersion,
    };
    return { ...issueTokens(payload), user: serialized };
  }

  /**
   * Change the signed-in user's password. Bumps the token version so sessions
   * on other devices die, then re-issues tokens for the caller.
   */
  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new AppError('User not found', 404);

    const valid = await bcrypt.compare(currentPassword || '', user.passwordHash);
    if (!valid) throw new AppError('Current password is incorrect', 401);
    if (!newPassword || newPassword.length < 8) {
      throw new AppError('New password must be at least 8 characters');
    }
    if (newPassword === currentPassword) {
      throw new AppError('New password must be different from the current one');
    }

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await bcrypt.hash(newPassword, SALT_ROUNDS),
        tokenVersion: { increment: 1 },
      },
      include: { organization: true },
    });
    forgetUserState(user.id);

    const payload: JwtPayload = {
      userId: updated.id,
      email: updated.email,
      organizationId: updated.organizationId,
      role: updated.role,
      tv: updated.tokenVersion,
    };
    return { ...issueTokens(payload), user: serializeUser(updated) };
  }

  async setNotifyByEmail(userId: string, enabled: boolean) {
    const user = await prisma.user.update({
      where: { id: userId },
      data: { notifyByEmail: enabled },
      include: { organization: true },
    });
    return serializeUser(user);
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
