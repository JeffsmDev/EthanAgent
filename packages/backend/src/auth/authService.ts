import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';

// Login mínimo para pocos usuarios fijos (el acceso real lo limita el firewall por IP).
// Usuarios en AUTH_USERS del .env ("Nombre:clave,Nombre:clave"); el primero es el administrador.
// Sesión = cookie HttpOnly firmada con HMAC (sin estado en el servidor: sobrevive a reinicios)

export interface AuthUser {
  id: string; // en minúsculas: nombre de carpeta en data/users/<id>
  name: string;
  isAdmin: boolean;
}

interface StoredUser extends AuthUser {
  salt: Buffer;
  hash: Buffer;
}

export const SESSION_COOKIE = 'ethan_session';
const SESSION_DAYS = 30;
const USER_ID_PATTERN = /^[a-z0-9_-]{2,32}$/;
// Freno a la fuerza bruta: N fallos por IP en la ventana bloquean el login hasta que expire
const MAX_FAILED_LOGINS = 10;
const FAILED_WINDOW_MS = 15 * 60 * 1000;

const hashPassword = (password: string, salt: Buffer) => crypto.scryptSync(password, salt, 32);

function parseUsers(raw: string | undefined): StoredUser[] {
  const users: StoredUser[] = [];
  for (const entry of (raw || '').split(',')) {
    const separator = entry.indexOf(':');
    if (separator <= 0) continue;
    const name = entry.slice(0, separator).trim();
    const password = entry.slice(separator + 1).trim();
    const id = name.toLowerCase();
    if (!USER_ID_PATTERN.test(id) || !password) {
      console.warn(`⚠️ AUTH_USERS: entrada ignorada ("${name}"): nombre inválido o sin contraseña`);
      continue;
    }
    if (users.some(u => u.id === id)) continue;
    const salt = crypto.randomBytes(16);
    users.push({ id, name, isAdmin: users.length === 0, salt, hash: hashPassword(password, salt) });
  }
  return users;
}

// AUTH_SECRET del .env o, si no hay, uno aleatorio persistido en data/ (así las sesiones sobreviven a reinicios)
function loadSecret(dataDir: string): Buffer {
  if (process.env.AUTH_SECRET && process.env.AUTH_SECRET.length >= 32) {
    return Buffer.from(process.env.AUTH_SECRET, 'utf8');
  }
  const file = path.join(dataDir, 'auth-secret');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 64) return Buffer.from(existing, 'hex');
  } catch {
    /* no existe todavía */
  }
  const secret = crypto.randomBytes(32);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, secret.toString('hex'), { mode: 0o600 });
  return secret;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header || '').split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    try {
      cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      /* cookie malformada: se ignora */
    }
  }
  return cookies;
}

export class AuthService {
  private readonly users: StoredUser[];
  private readonly secret: Buffer;
  private readonly failedLogins = new Map<string, { count: number; firstAt: number }>();

  constructor(dataDir: string) {
    this.users = parseUsers(process.env.AUTH_USERS);
    this.secret = loadSecret(dataDir);
    if (this.users.length === 0) {
      console.error('❌ AUTH_USERS vacío en .env: nadie podrá iniciar sesión (formato "Nombre:clave,Nombre:clave")');
    }
  }

  get userIds(): string[] {
    return this.users.map(u => u.id);
  }

  get adminId(): string | null {
    return this.users[0]?.id ?? null;
  }

  private publicUser(user: StoredUser): AuthUser {
    return { id: user.id, name: user.name, isAdmin: user.isAdmin };
  }

  private sign(payload: string): string {
    return crypto.createHmac('sha256', this.secret).update(payload).digest('base64url');
  }

  isLockedOut(ip: string): boolean {
    const entry = this.failedLogins.get(ip);
    if (!entry) return false;
    if (Date.now() - entry.firstAt > FAILED_WINDOW_MS) {
      this.failedLogins.delete(ip);
      return false;
    }
    return entry.count >= MAX_FAILED_LOGINS;
  }

  // Compara siempre en tiempo constante (también con usuarios inexistentes) para no filtrar qué nombres existen
  verify(name: unknown, password: unknown, ip: string): AuthUser | null {
    const id = typeof name === 'string' ? name.trim().toLowerCase() : '';
    const pass = typeof password === 'string' ? password : '';
    const user = this.users.find(u => u.id === id);
    const salt = user?.salt ?? crypto.randomBytes(16);
    const candidate = hashPassword(pass, salt);
    const ok = !!user && crypto.timingSafeEqual(candidate, user.hash);
    if (ok) {
      this.failedLogins.delete(ip);
      return this.publicUser(user);
    }
    const entry = this.failedLogins.get(ip);
    if (entry && Date.now() - entry.firstAt <= FAILED_WINDOW_MS) entry.count += 1;
    else this.failedLogins.set(ip, { count: 1, firstAt: Date.now() });
    return null;
  }

  createToken(user: AuthUser): string {
    const payload = `${user.id}.${Date.now() + SESSION_DAYS * 86400000}`;
    return `${payload}.${this.sign(payload)}`;
  }

  // Token válido, firmado, sin caducar y de un usuario que sigue en AUTH_USERS
  userFromRequest(req: Request): AuthUser | null {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!token) return null;
    const [id, expires, signature] = token.split('.');
    if (!id || !expires || !signature) return null;
    const expected = Buffer.from(this.sign(`${id}.${expires}`));
    const received = Buffer.from(signature);
    if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) return null;
    if (!(Number(expires) > Date.now())) return null;
    const user = this.users.find(u => u.id === id);
    return user ? this.publicUser(user) : null;
  }

  setSessionCookie(req: Request, res: Response, user: AuthUser): void {
    res.cookie(SESSION_COOKIE, this.createToken(user), {
      httpOnly: true,
      sameSite: 'lax',
      // Detrás de Nginx con HTTPS (trust proxy); en local por http la cookie no puede ser Secure
      secure: req.secure,
      maxAge: SESSION_DAYS * 86400000,
      path: '/'
    });
  }

  clearSessionCookie(req: Request, res: Response): void {
    res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/' });
  }

  // Middleware: exige sesión y deja el usuario en res.locals.user
  requireUser = (req: Request, res: Response, next: NextFunction): void => {
    const user = this.userFromRequest(req);
    if (!user) {
      res.status(401).json({ error: 'Please sign in.', code: 'UNAUTHENTICATED' });
      return;
    }
    res.locals.user = user;
    next();
  };

  requireAdmin = (req: Request, res: Response, next: NextFunction): void => {
    if (!(res.locals.user as AuthUser | undefined)?.isAdmin) {
      res.status(403).json({ error: 'Only the admin can change this.', code: 'FORBIDDEN' });
      return;
    }
    next();
  };
}
