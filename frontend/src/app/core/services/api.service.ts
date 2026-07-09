import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, map } from 'rxjs';
import { environment } from '../../../environments/environment';
import { ApiResponse } from '../models/user.model';

/**
 * Thin wrapper around HttpClient. Every backend response has the shape
 * `{ success: boolean, data: T }` — these helpers unwrap `data` for callers.
 */
@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);
  private baseUrl = environment.apiUrl;

  private toHttpParams(params?: Record<string, any>): HttpParams {
    let httpParams = new HttpParams();
    if (!params) return httpParams;
    for (const key of Object.keys(params)) {
      const value = params[key];
      if (value !== undefined && value !== null && value !== '') {
        httpParams = httpParams.set(key, String(value));
      }
    }
    return httpParams;
  }

  get<T>(path: string, params?: Record<string, any>): Observable<T> {
    return this.http
      .get<ApiResponse<T>>(`${this.baseUrl}${path}`, { params: this.toHttpParams(params) })
      .pipe(map(res => res.data));
  }

  post<T>(path: string, body: unknown = {}): Observable<T> {
    return this.http
      .post<ApiResponse<T>>(`${this.baseUrl}${path}`, body)
      .pipe(map(res => res.data));
  }

  patch<T>(path: string, body: unknown = {}): Observable<T> {
    return this.http
      .patch<ApiResponse<T>>(`${this.baseUrl}${path}`, body)
      .pipe(map(res => res.data));
  }

  delete<T>(path: string): Observable<T> {
    return this.http
      .delete<ApiResponse<T>>(`${this.baseUrl}${path}`)
      .pipe(map(res => res.data));
  }

  /** Absolute URL helper for requests that need raw fetch (e.g. SSE streams). */
  url(path: string): string {
    return `${this.baseUrl}${path}`;
  }
}
