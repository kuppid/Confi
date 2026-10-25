import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const sqlite = new DatabaseSync(join(dirname(fileURLToPath(import.meta.url)), 'conf.db'));

const db = {
  exec: (sql) => sqlite.exec(sql),
  prepare: (sql) => sqlite.prepare(sql),
  pragma: (sql) => sqlite.exec(`PRAGMA ${sql}`),
  transaction: (fn) => (...args) => {
    sqlite.exec('BEGIN');
    try {
      const result = fn(...args);
      sqlite.exec('COMMIT');
      return result;
    } catch (e) {
      sqlite.exec('ROLLBACK');
      throw e;
    }
  }
};

const ROOM_TYPES = ['конференц-зал', 'переговорная', 'опенспейс'];
const PAYMENT_METHODS = ['При очном посещении', 'Перевод по СБП'];
const REQUEST_STATUSES = ['Новая', 'Одобрена', 'Проведена'];

const columns = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

const createSchema = () => db.exec(`
  CREATE TABLE IF NOT EXISTS room_types (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
  );

  CREATE TABLE IF NOT EXISTS payment_methods (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
  );

  CREATE TABLE IF NOT EXISTS request_statuses (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
  );

  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    login      TEXT NOT NULL UNIQUE,
    password   TEXT NOT NULL,
    fio        TEXT NOT NULL,
    phone      TEXT NOT NULL,
    email      TEXT NOT NULL,
    role       TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS rooms (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    name     TEXT NOT NULL UNIQUE,
    type_id  INTEGER NOT NULL,
    capacity INTEGER NOT NULL CHECK (capacity > 0),
    FOREIGN KEY (type_id) REFERENCES room_types(id) ON DELETE RESTRICT
  );

  CREATE TABLE IF NOT EXISTS requests (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id           INTEGER NOT NULL,
    room_id           INTEGER NOT NULL,
    date_start        TEXT NOT NULL,
    payment_method_id INTEGER NOT NULL,
    status_id         INTEGER NOT NULL,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id)           REFERENCES users(id)            ON DELETE CASCADE,
    FOREIGN KEY (room_id)           REFERENCES rooms(id)            ON DELETE RESTRICT,
    FOREIGN KEY (payment_method_id) REFERENCES payment_methods(id)  ON DELETE RESTRICT,
    FOREIGN KEY (status_id)         REFERENCES request_statuses(id) ON DELETE RESTRICT
  );

  CREATE UNIQUE INDEX IF NOT EXISTS ux_room_date ON requests(room_id, date_start);

  CREATE TABLE IF NOT EXISTS reviews (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id INTEGER NOT NULL,
    rating     INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    text       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (request_id) REFERENCES requests(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS ix_reviews_request ON reviews(request_id);
`);

const seedLookups = () => {
  const addType = db.prepare('INSERT OR IGNORE INTO room_types (name) VALUES (?)');
  const addPayment = db.prepare('INSERT OR IGNORE INTO payment_methods (name) VALUES (?)');
  const addStatus = db.prepare('INSERT OR IGNORE INTO request_statuses (name) VALUES (?)');
  ROOM_TYPES.forEach((n) => addType.run(n));
  PAYMENT_METHODS.forEach((n) => addPayment.run(n));
  REQUEST_STATUSES.forEach((n) => addStatus.run(n));
};

const migrateLegacy = db.transaction(() => {
  const roleExpr = columns('users').includes('role') ? 'role' : `'user'`;

  db.exec(`
    DROP INDEX IF EXISTS ux_room_date;
    DROP INDEX IF EXISTS ix_reviews_request;
    ALTER TABLE reviews RENAME TO reviews_old;
    ALTER TABLE requests RENAME TO requests_old;
    ALTER TABLE rooms RENAME TO rooms_old;
    ALTER TABLE users RENAME TO users_old;
  `);

  createSchema();
  seedLookups();

  db.exec(`
    INSERT OR IGNORE INTO room_types (name) SELECT type FROM rooms_old GROUP BY type ORDER BY MIN(id);
    INSERT OR IGNORE INTO payment_methods (name) SELECT payment FROM requests_old GROUP BY payment ORDER BY MIN(id);
    INSERT OR IGNORE INTO request_statuses (name) SELECT status FROM requests_old GROUP BY status ORDER BY MIN(id);

    INSERT INTO users (id, login, password, fio, phone, email, role, created_at)
    SELECT id, login, password, fio, phone, email, ${roleExpr}, created_at FROM users_old;

    INSERT INTO rooms (id, name, type_id, capacity)
    SELECT o.id, o.name, t.id, o.capacity
    FROM rooms_old o JOIN room_types t ON t.name = o.type;

    INSERT INTO requests (id, user_id, room_id, date_start, payment_method_id, status_id, created_at)
    SELECT o.id, o.user_id, o.room_id, o.date_start, p.id, s.id, o.created_at
    FROM requests_old o
    JOIN payment_methods p ON p.name = o.payment
    JOIN request_statuses s ON s.name = o.status;

    INSERT INTO reviews (id, request_id, rating, text, created_at)
    SELECT id, request_id, rating, text, created_at FROM reviews_old;

    DROP TABLE reviews_old;
    DROP TABLE requests_old;
    DROP TABLE rooms_old;
    DROP TABLE users_old;
  `);

  const plain = db.prepare(`SELECT id, password FROM users WHERE password NOT LIKE '$2%'`).all();
  const setHash = db.prepare('UPDATE users SET password = ? WHERE id = ?');
  plain.forEach((u) => setHash.run(bcrypt.hashSync(u.password, 10), u.id));
});

if (columns('requests').includes('payment')) {
  db.pragma('foreign_keys = OFF');
  try {
    migrateLegacy();
  } catch (e) {
    throw new Error(`Не удалось перенести данные из старого conf.db: ${e.message}`);
  } finally {
    db.pragma('foreign_keys = ON');
  }
} else {
  db.pragma('foreign_keys = ON');
  createSchema();
  seedLookups();
}

const isEmpty = (table) => db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c === 0;
const idByName = (table, name) => db.prepare(`SELECT id FROM ${table} WHERE name = ?`).get(name).id;

const seed = db.transaction(() => {
  if (isEmpty('users')) {
    const s = db.prepare(`
      INSERT INTO users (login, password, fio, phone, email)
      VALUES (?, ?, ?, ?, ?)
    `);
    const h = (p) => bcrypt.hashSync(p, 10);
    s.run('ivan', h('demo'), 'Иванов Иван', '8(999)123-45-67', 'ivan@example.com');
    s.run('petr', h('demo'), 'Петров Пётр', '8(999)123-33-33', 'petr@example.com');
    s.run('anna', h('demo'), 'Сидорова Анна', '8(950)432-45-67', 'anna@example.com');
  }

  if (isEmpty('rooms')) {
    const s = db.prepare('INSERT INTO rooms (name, type_id, capacity) VALUES (?, ?, ?)');
    s.run('Конференц-зал "Горизонт"', idByName('room_types', 'конференц-зал'), 20);
    s.run('Переговорная №1', idByName('room_types', 'переговорная'), 6);
    s.run('Опенспейс разработки', idByName('room_types', 'опенспейс'), 12);
  }

  if (isEmpty('requests')) {
    const s = db.prepare(`
      INSERT INTO requests (user_id, room_id, date_start, payment_method_id, status_id)
      VALUES (?, ?, ?, ?, ?)
    `);
    const status = idByName('request_statuses', 'Новая');
    const onSite = idByName('payment_methods', 'При очном посещении');
    const sbp = idByName('payment_methods', 'Перевод по СБП');
    s.run(1, 1, '2027-03-15', onSite, status);
    s.run(1, 3, '2027-03-20', sbp, status);
    s.run(2, 2, '2027-04-10', onSite, status);
  }

  if (isEmpty('reviews')) {
    const s = db.prepare('INSERT INTO reviews (request_id, rating, text) VALUES (?, ?, ?)');
    s.run(1, 5, 'Отличный зал, всё понравилось.');
    s.run(2, 4, 'Хорошее помещение.');
    s.run(2, 5, 'Всё прошло отлично.');
  }
});
seed();

class UserModel {
  findById(id)       { return db.prepare('SELECT * FROM users WHERE id = ?').get(id); }
  findByLogin(login) { return db.prepare('SELECT * FROM users WHERE login = ?').get(login); }
  findAll()          { return db.prepare('SELECT * FROM users ORDER BY id').all(); }
  count()            { return db.prepare('SELECT COUNT(*) AS c FROM users').get().c; }
  exists(login)      { return !!db.prepare('SELECT 1 FROM users WHERE login = ?').get(login); }

  create({ login, password, fio, phone, email }) {
    const r = db.prepare(`
      INSERT INTO users (login, password, fio, phone, email)
      VALUES (?, ?, ?, ?, ?)
    `).run(login, bcrypt.hashSync(password, 10), fio, phone, email);
    return this.findById(r.lastInsertRowid);
  }

  verify(login, password) {
    const user = this.findByLogin(login);
    return user && bcrypt.compareSync(password, user.password) ? user : null;
  }
}

class RoomModel {
  #select = `
    SELECT r.id, r.name, r.capacity, r.type_id, t.name AS type
    FROM rooms r
    JOIN room_types t ON t.id = r.type_id
  `;
  findAll()        { return db.prepare(`${this.#select} ORDER BY r.name`).all(); }
  findById(id)     { return db.prepare(`${this.#select} WHERE r.id = ?`).get(id); }
  findByType(type) { return db.prepare(`${this.#select} WHERE t.name = ? ORDER BY r.name`).all(type); }
  count()          { return db.prepare('SELECT COUNT(*) AS c FROM rooms').get().c; }
  types()          { return db.prepare('SELECT * FROM room_types ORDER BY name').all(); }
}

class RequestModel {
  #select = `
    SELECT r.id, r.user_id, r.room_id, r.date_start, r.created_at,
           rm.name AS room_name,
           pm.name AS payment,
           st.name AS status
    FROM requests r
    JOIN rooms             rm ON rm.id = r.room_id
    JOIN payment_methods   pm ON pm.id = r.payment_method_id
    JOIN request_statuses  st ON st.id = r.status_id
  `;

  findById(id) { return db.prepare(`${this.#select} WHERE r.id = ?`).get(id); }
  count()      { return db.prepare('SELECT COUNT(*) AS c FROM requests').get().c; }

  findByUser(userId) {
    return db.prepare(`
      SELECT r.id, r.date_start, pm.name AS payment, st.name AS status,
             rm.name AS room_name
      FROM requests r
      JOIN rooms             rm ON rm.id = r.room_id
      JOIN payment_methods   pm ON pm.id = r.payment_method_id
      JOIN request_statuses  st ON st.id = r.status_id
      WHERE r.user_id = ?
      ORDER BY r.date_start DESC
    `).all(userId);
  }

  findAllDetailed() {
    return db.prepare(`
      SELECT r.id, r.date_start, pm.name AS payment, st.name AS status,
             u.fio, u.phone, rm.name AS room_name
      FROM requests r
      JOIN users             u  ON u.id  = r.user_id
      JOIN rooms             rm ON rm.id = r.room_id
      JOIN payment_methods   pm ON pm.id = r.payment_method_id
      JOIN request_statuses  st ON st.id = r.status_id
      ORDER BY r.created_at DESC, r.id DESC
    `).all();
  }

  create({ userId, roomId, dateStart, paymentId }) {
    const r = db.prepare(`
      INSERT INTO requests (user_id, room_id, date_start, payment_method_id, status_id)
      VALUES (?, ?, ?, ?, (SELECT id FROM request_statuses WHERE name = 'Новая'))
    `).run(userId, roomId, dateStart, paymentId);
    return this.findById(r.lastInsertRowid);
  }

  updateStatus(id, statusName) {
    return db.prepare(`
      UPDATE requests
      SET status_id = (SELECT id FROM request_statuses WHERE name = ?)
      WHERE id = ?
    `).run(statusName, id);
  }

  paymentMethods() { return db.prepare('SELECT * FROM payment_methods ORDER BY id').all(); }
  statuses()       { return db.prepare('SELECT * FROM request_statuses ORDER BY id').all(); }
}

class ReviewModel {
  findByRequest(requestId) {
    return db.prepare('SELECT * FROM reviews WHERE request_id = ? ORDER BY id').all(requestId);
  }

  findAll() {
    return db.prepare(`
      SELECT rv.*, u.fio AS user_fio, rm.name AS room_name
      FROM reviews rv
      JOIN requests r ON r.id = rv.request_id
      JOIN users u    ON u.id = r.user_id
      JOIN rooms rm   ON rm.id = r.room_id
      ORDER BY rv.created_at DESC, rv.id DESC
    `).all();
  }

  create({ requestId, rating, text }) {
    const r = db.prepare('INSERT INTO reviews (request_id, rating, text) VALUES (?, ?, ?)')
      .run(requestId, rating, text);
    return db.prepare('SELECT * FROM reviews WHERE id = ?').get(r.lastInsertRowid);
  }
}

export const User = new UserModel();
export const Room = new RoomModel();
export const Request = new RequestModel();
export const Review = new ReviewModel();
export default db;
