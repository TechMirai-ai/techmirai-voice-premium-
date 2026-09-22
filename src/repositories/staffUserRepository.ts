import type { Queryable } from '../db/pool.js';

export interface StaffUser {
  id: string;
  clientId: string;
  email: string;
  passwordHash: string;
  role: string;
  mustChangePassword: boolean;
  createdAt: Date;
}

export interface NewStaffUser {
  clientId: string;
  email: string;
  passwordHash: string;
  /** Defaults to 'admin' — see db/migrations/0004_staff_users.sql. */
  role?: string;
}

export interface StaffUserRepository {
  findByEmail(email: string): Promise<StaffUser | undefined>;
  findById(id: string): Promise<StaffUser | undefined>;
  create(user: NewStaffUser): Promise<StaffUser>;
  /**
   * Sets a new password hash and clears must_change_password in one
   * statement (§4.7): a crash between the two steps can never leave the
   * account in an inconsistent state, because there is only one step.
   */
  completePasswordChange(id: string, passwordHash: string): Promise<void>;
}

interface StaffUserRow {
  id: string;
  client_id: string;
  email: string;
  password_hash: string;
  role: string;
  must_change_password: boolean;
  created_at: Date;
}

function toStaffUser(row: StaffUserRow): StaffUser {
  return {
    id: row.id,
    clientId: row.client_id,
    email: row.email,
    passwordHash: row.password_hash,
    role: row.role,
    mustChangePassword: row.must_change_password,
    createdAt: row.created_at,
  };
}

const DEFAULT_ROLE = 'admin';

export class PgStaffUserRepository implements StaffUserRepository {
  constructor(private readonly db: Queryable) {}

  async findByEmail(email: string): Promise<StaffUser | undefined> {
    const { rows } = await this.db.query(
      'SELECT * FROM staff_users WHERE lower(email) = lower($1)',
      [email],
    );
    const row = rows[0] as StaffUserRow | undefined;
    return row ? toStaffUser(row) : undefined;
  }

  async findById(id: string): Promise<StaffUser | undefined> {
    const { rows } = await this.db.query('SELECT * FROM staff_users WHERE id = $1', [id]);
    const row = rows[0] as StaffUserRow | undefined;
    return row ? toStaffUser(row) : undefined;
  }

  async create(user: NewStaffUser): Promise<StaffUser> {
    const { rows } = await this.db.query(
      `INSERT INTO staff_users (client_id, email, password_hash, role)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [user.clientId, user.email, user.passwordHash, user.role ?? DEFAULT_ROLE],
    );
    const row = rows[0] as StaffUserRow | undefined;
    if (!row) throw new Error('staff_users insert returned no row');
    return toStaffUser(row);
  }

  async completePasswordChange(id: string, passwordHash: string): Promise<void> {
    await this.db.query(
      'UPDATE staff_users SET password_hash = $1, must_change_password = false WHERE id = $2',
      [passwordHash, id],
    );
  }
}
