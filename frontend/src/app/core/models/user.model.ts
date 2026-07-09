export interface Organization {
  id: string;
  name: string;
  slug: string;
}

export interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  isSuperAdmin?: boolean;
  notifyByEmail?: boolean;
  organization?: Organization;
}

export interface ApiResponse<T> {
  success: boolean;
  data: T;
}

export interface AuthTokens {
  token: string;
  refreshToken: string;
  user: User;
}
