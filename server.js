import express from 'express';
import session from 'express-session';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { User, Room, Request } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 3000;
const INACTIVITY_LIMIT = 20 * 60 * 1000;

app.set('view engine', 'ejs');
app.set('views', join(__dirname, 'views'));
app.locals.fmtDate = (d) => String(d).split('-').reverse().join('.');

app.use(express.urlencoded({ extended: true }));
app.use(express.static(join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-me-to-a-long-random-string',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 2 },
}));

app.use((req, res, next) => {
  if (req.session.user) {
    const now = Date.now();
    if (req.session.lastActivity && now - req.session.lastActivity > INACTIVITY_LIMIT)
      return req.session.destroy(() => res.redirect('/login'));
    req.session.lastActivity = now;
  }
  next();
});

app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.errors = [];
  res.locals.form = {};
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  next();
});

const requireAuth = (req, res, next) =>
  req.session.user ? next() : res.redirect('/login');
const requireAdmin = (req, res, next) =>
  req.session.user?.role === 'admin' ? next() : res.status(403).send('Нет доступа');

function normalizePhone(p = '') {
  let d = String(p).replace(/\D/g, '');
  if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
  if (d.length !== 11 || d[0] !== '7') return null;
  return `+7 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7, 9)}-${d.slice(9)}`;
}

const isConstraint = (e) => /constraint/i.test(String(e.message));

app.get('/', (req, res) => res.redirect('/rooms'));

app.get('/about', (req, res) => res.render('about', { title: 'О портале Конференции.РФ' }));

app.get('/rooms', (req, res) => {
  res.render('rooms', { title: 'Список помещений', rooms: Room.findAll() });
});

app.get('/rooms/type/:type', (req, res) => {
  res.render('rooms', { title: 'Список помещений', rooms: Room.findByType(req.params.type) });
});

app.get('/register', (req, res) => res.render('register', { title: 'Регистрация на портале' }));

app.post('/register', (req, res) => {
  const { login = '', password = '', confirm = '', fio = '', phone = '', email = '' } = req.body || {};
  const errors = [];
  if (!/^[A-Za-z0-9_]{3,20}$/.test(login)) errors.push('Логин: 3–20 символов, латиница, цифры и _');
  if (password.length < 6) errors.push('Пароль не короче 6 символов');
  if (password !== confirm) errors.push('Пароли не совпадают');
  if (fio.trim().length < 3) errors.push('Введите ФИО');
  const ph = normalizePhone(phone);
  if (!ph) errors.push('Некорректный телефон');
  if (!/^\S+@\S+\.\S+$/.test(email)) errors.push('Некорректный email');
  if (errors.length)
    return res.status(400).render('register', { title: 'Регистрация на портале', errors, form: req.body });
  try {
    User.create({ login, password, fio: fio.trim(), phone: ph, email: email.trim().toLowerCase() });
  } catch (e) {
    if (isConstraint(e))
      return res.status(400).render('register', {
        title: 'Регистрация на портале', errors: ['Логин уже занят'], form: req.body });
    throw e;
  }
  req.session.flash = { type: 'success', text: 'Регистрация успешна. Войдите' };
  res.redirect('/login');
});

app.get('/login', (req, res) => res.render('login', { title: 'Вход в систему' }));

app.post('/login', (req, res) => {
  const { login = '', password = '' } = req.body || {};
  const u = User.verify(login, password);
  if (!u)
    return res.status(401).render('login', {
      title: 'Вход в систему', errors: ['Неверный логин или пароль'], form: { login } });
  req.session.user = { id: u.id, fio: u.fio, role: u.role };
  res.redirect(u.role === 'admin' ? '/admin' : '/dashboard');
});

app.all('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

app.get('/dashboard', requireAuth, (req, res) => {
  if (req.session.user.role === 'admin') return res.redirect('/admin');
  res.render('dashboard', { title: 'Личный кабинет', requests: Request.findByUser(req.session.user.id) });
});

app.get('/admin', requireAuth, requireAdmin, (req, res) => {
  res.render('dashboard', { title: 'Все заявки', requests: Request.findAllDetailed() });
});

const renderCreate = (res, errors = [], status = 200) =>
  res.status(status).render('create_request', {
    title: 'Новая заявка',
    rooms: Room.findAll(),
    payments: Request.paymentMethods(),
    errors
  });

app.get('/create', requireAuth, (req, res) => renderCreate(res));

app.post('/create', requireAuth, (req, res) => {
  const { room_id = '', date_start = '', payment_id = '' } = req.body || {};
  const today = new Date().toLocaleDateString('sv-SE');
  const errors = [];
  if (!Room.findById(Number(room_id))) errors.push('Выберите помещение');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date_start) || date_start < today) errors.push('Дата не может быть в прошлом');
  if (!Request.paymentMethods().some((p) => String(p.id) === String(payment_id))) errors.push('Выберите способ оплаты');
  if (!errors.length) {
    try {
      Request.create({
        userId: req.session.user.id,
        roomId: Number(room_id),
        dateStart: date_start,
        paymentId: Number(payment_id)
      });
      return res.redirect('/dashboard');
    } catch (e) {
      if (isConstraint(e)) errors.push('Это помещение уже занято на выбранную дату');
      else throw e;
    }
  }
  renderCreate(res, errors, 400);
});

app.use((req, res) => res.status(404).send('Страница не найдена'));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('Ошибка сервера');
});

app.listen(PORT, () => console.log(`Сервер: http://localhost:${PORT}`));
