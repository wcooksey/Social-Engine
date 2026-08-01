import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, switchMap, throwError } from 'rxjs';
import { AuthService } from '../services/auth.service';

/**
 * Attaches the access token, and keeps the session alive across its expiry.
 *
 * Access tokens are deliberately short-lived (an hour by default) while the
 * refresh token lasts thirty days — which only works if something actually
 * spends the refresh token. Nothing did: every 401 signed the user out on the
 * spot, so a session ended exactly one hour after signing in no matter how
 * actively it was being used, with a valid refresh token sitting unused in
 * local storage the whole time.
 *
 * Now a 401 tries the refresh first and replays the original request with the
 * new token. Signing out is the fallback for when the refresh itself fails — an
 * expired or revoked refresh token, or a password change that bumped the token
 * version — which is the only case where the session is genuinely over.
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const authService = inject(AuthService);
  const router = inject(Router);

  const isApiRequest = req.url.includes('/api/');
  // The auth endpoints are excluded from BOTH the header and the retry: a 401
  // from login means bad credentials, and a 401 from refresh is what ends the
  // session — retrying either would be a loop or a lie.
  const isAuthEndpoint =
    req.url.includes('/api/auth/login') ||
    req.url.includes('/api/auth/register') ||
    req.url.includes('/api/auth/refresh');

  const token = authService.token;
  const authed =
    isApiRequest && !isAuthEndpoint && token
      ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } })
      : req;

  const endSession = (error: unknown) => {
    authService.logout();
    void router.navigate(['/login']);
    return throwError(() => error);
  };

  return next(authed).pipe(
    catchError((error: HttpErrorResponse) => {
      const recoverable = error.status === 401 && isApiRequest && !isAuthEndpoint;
      if (!recoverable) return throwError(() => error);

      // Nothing to refresh with — this is a genuine sign-out.
      if (!authService.refreshToken) return endSession(error);

      return authService.refreshAccessTokenShared().pipe(
        switchMap(tokens =>
          // Replay the original request with the new token. This goes straight
          // to `next`, so a second 401 falls to the catch below rather than
          // starting another refresh round.
          next(req.clone({ setHeaders: { Authorization: `Bearer ${tokens.token}` } }))
        ),
        catchError(() => endSession(error))
      );
    })
  );
};
