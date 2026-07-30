import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable, tap } from 'rxjs';
import { AuthTokens, User } from '../models/user.model';
import { ApiService } from './api.service';

export interface LoginCredentials {
  email: string;
  password: string;
}

export interface RegisterData {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  organizationName: string;
}

export interface ProfileUpdate {
  firstName?: string;
  lastName?: string;
  email?: string;
  /** Required only when changing the email address. */
  currentPassword?: string;
}

/**
 * Endpoints that rotate the token version (email change, password change)
 * return a fresh pair alongside the user so the caller stays signed in.
 */
interface UserWithTokens {
  user: User;
  token?: string;
  refreshToken?: string;
}

const TOKEN_KEY = 'token';
const REFRESH_TOKEN_KEY = 'refreshToken';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private api = inject(ApiService);

  private readonly currentUserSignal = signal<User | null>(null);
  readonly currentUser = this.currentUserSignal.asReadonly();
  readonly isLoggedIn = computed(() => !!this.currentUserSignal());

  constructor() {
    const storedUser = localStorage.getItem('user');
    if (storedUser) {
      try {
        this.currentUserSignal.set(JSON.parse(storedUser));
      } catch {
        localStorage.removeItem('user');
      }
    }
  }

  get token(): string | null {
    return localStorage.getItem(TOKEN_KEY);
  }

  get refreshToken(): string | null {
    return localStorage.getItem(REFRESH_TOKEN_KEY);
  }

  login(credentials: LoginCredentials): Observable<AuthTokens> {
    return this.api.post<AuthTokens>('/api/auth/login', credentials).pipe(
      tap(data => this.setAuthData(data))
    );
  }

  register(data: RegisterData): Observable<AuthTokens> {
    return this.api.post<AuthTokens>('/api/auth/register', data).pipe(
      tap(res => this.setAuthData(res))
    );
  }

  me(): Observable<User> {
    return this.api.get<User>('/api/auth/me').pipe(
      tap(user => {
        localStorage.setItem('user', JSON.stringify(user));
        this.currentUserSignal.set(user);
      })
    );
  }

  updateProfile(update: ProfileUpdate): Observable<UserWithTokens> {
    return this.api.patch<UserWithTokens>('/api/auth/me', update).pipe(
      tap(res => this.applyUserWithTokens(res))
    );
  }

  changePassword(currentPassword: string, newPassword: string): Observable<UserWithTokens> {
    return this.api
      .post<UserWithTokens>('/api/auth/me/password', { currentPassword, newPassword })
      .pipe(tap(res => this.applyUserWithTokens(res)));
  }

  updateNotifications(notifyByEmail: boolean): Observable<User> {
    return this.api.patch<User>('/api/auth/me/notifications', { notifyByEmail }).pipe(
      tap(user => {
        localStorage.setItem('user', JSON.stringify(user));
        this.currentUserSignal.set(user);
      })
    );
  }

  refreshAccessToken(): Observable<{ token: string; refreshToken: string }> {
    return this.api
      .post<{ token: string; refreshToken: string }>('/api/auth/refresh', {
        refreshToken: this.refreshToken
      })
      .pipe(
        tap(tokens => {
          localStorage.setItem(TOKEN_KEY, tokens.token);
          localStorage.setItem(REFRESH_TOKEN_KEY, tokens.refreshToken);
        })
      );
  }

  logout(): void {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_TOKEN_KEY);
    localStorage.removeItem('user');
    this.currentUserSignal.set(null);
  }

  isAuthenticated(): boolean {
    return !!this.token;
  }

  /** Store the updated user, plus rotated tokens when the server sent some. */
  private applyUserWithTokens(res: UserWithTokens): void {
    if (res.token && res.refreshToken) {
      localStorage.setItem(TOKEN_KEY, res.token);
      localStorage.setItem(REFRESH_TOKEN_KEY, res.refreshToken);
    }
    localStorage.setItem('user', JSON.stringify(res.user));
    this.currentUserSignal.set(res.user);
  }

  private setAuthData(data: AuthTokens): void {
    localStorage.setItem(TOKEN_KEY, data.token);
    localStorage.setItem(REFRESH_TOKEN_KEY, data.refreshToken);
    localStorage.setItem('user', JSON.stringify(data.user));
    this.currentUserSignal.set(data.user);
  }
}
