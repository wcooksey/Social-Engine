import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth.service';

export const authGuard: CanActivateFn = (route, state) => {
  const authService = inject(AuthService);
  const router = inject(Router);

  if (authService.isAuthenticated()) {
    return true;
  }

  router.navigate([state.url.startsWith('/crm') ? '/crm/login' : '/login'], { queryParams: { returnUrl: state.url } });
  return false;
};

/**
 * Keeps the Admin page out of the router for everyone but the super admin.
 * Cosmetic only — /api/admin enforces the same rule server-side.
 */
export const superAdminGuard: CanActivateFn = () => {
  const authService = inject(AuthService);
  const router = inject(Router);

  if (authService.isAuthenticated() && authService.currentUser()?.isSuperAdmin) {
    return true;
  }

  router.navigate([authService.isAuthenticated() ? '/dashboard' : '/login']);
  return false;
};

export const guestGuard: CanActivateFn = () => {
  const authService = inject(AuthService);
  const router = inject(Router);

  if (!authService.isAuthenticated()) {
    return true;
  }

  router.navigate([authService.currentUser()?.role === 'CALLER' ? '/crm' : '/groups']);
  return false;
};

export const workspaceGuard: CanActivateFn = () => {
  const auth = inject(AuthService), router = inject(Router);
  return auth.currentUser()?.role === 'CALLER' ? router.parseUrl('/crm') : true;
};
