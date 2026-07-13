const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json({ limit: '12mb' }));
app.use(express.static(__dirname)); // serves index.html, student.html, admin.html

// ===================== DATABASE CONNECTION =====================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Create tables if they don't exist yet, and seed a default admin
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admins (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS students (
      id SERIAL PRIMARY KEY,
      name TEXT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      date TEXT,
      last_date TEXT,
      department TEXT,
      coordinator TEXT,
      location TEXT,
      max_seats INTEGER
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS registrations (
      id SERIAL PRIMARY KEY,
      name TEXT,
      reg_no TEXT,
      branch TEXT,
      event_title TEXT,
      reg_date TEXT,
      reg_time TEXT
    );
  `);

  // Seed default admin (admin / admin123) only if the admins table is empty
  const { rows } = await pool.query('SELECT COUNT(*) FROM admins');
  if (parseInt(rows[0].count, 10) === 0) {
    await pool.query(
      'INSERT INTO admins (username, password) VALUES ($1, $2)',
      ['admin', 'admin123']
    );
    console.log('Seeded default admin -> username: admin, password: admin123');
  }

  // Migrations for existing databases created before these features were added
  await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS image_url TEXT;`);
  await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS price NUMERIC DEFAULT 0;`);
  await pool.query(`ALTER TABLE registrations ADD COLUMN IF NOT EXISTS transaction_id TEXT;`);
  await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS email TEXT;`);
  await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS mobile TEXT;`);
}

// ===================== AUTH =====================

// LOGIN (used by student.html's login form)
// Admin credentials are checked against the admins table.
// Student login uses a simple rule instead of a real password check:
// the password must be the username spelled backwards.
app.post('/login', async (req, res) => {
  const { username, password } = req.body;

  const result = await pool.query(
    'SELECT * FROM admins WHERE username = $1 AND password = $2',
    [username, password]
  );
  if (result.rows.length > 0) return res.json({ role: 'admin' });

  const reversed = (username || '').split('').reverse().join('');
  if (username && password && password === reversed) {
    return res.json({ role: 'student' });
  }

  return res.json({}); // no role -> login failed
});

// ADMIN LOGIN (separate gate used by admin.html)
app.post('/admin-login', async (req, res) => {
  const { username, password } = req.body;
  const result = await pool.query(
    'SELECT * FROM admins WHERE username = $1 AND password = $2',
    [username, password]
  );
  res.json({ success: result.rows.length > 0 });
});

// STUDENT SIGN UP
app.post('/signup', async (req, res) => {
  const { name, username, password, email, mobile } = req.body;

  if (!username || !password) {
    return res.status(400).json({ success: false, error: 'Username and password are required' });
  }

  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const mobilePattern = /^[6-9]\d{9}$/; // 10-digit Indian mobile number

  if (!email || !emailPattern.test(email)) {
    return res.status(400).json({ success: false, error: 'Please provide a valid email address' });
  }

  if (!mobile || !mobilePattern.test(mobile)) {
    return res.status(400).json({ success: false, error: 'Please provide a valid 10-digit mobile number' });
  }

  const existingUsername = await pool.query('SELECT * FROM students WHERE username = $1', [username]);
  if (existingUsername.rows.length > 0) {
    return res.status(400).json({ success: false, error: 'Username already taken' });
  }

  const existingEmail = await pool.query('SELECT * FROM students WHERE email = $1', [email]);
  if (existingEmail.rows.length > 0) {
    return res.status(400).json({ success: false, error: 'Email already registered' });
  }

  await pool.query(
    'INSERT INTO students (name, username, password, email, mobile) VALUES ($1, $2, $3, $4, $5)',
    [name, username, password, email, mobile]
  );
  res.json({ success: true, message: 'Student registered' });
});

// ===================== EVENTS =====================

function rowToEvent(row) {
  return {
    title: row.title,
    desc: row.description,
    date: row.date,
    lastDate: row.last_date,
    department: row.department,
    coordinator: row.coordinator,
    location: row.location,
    maxSeats: row.max_seats,
    image: row.image_url,
    price: row.price ? parseFloat(row.price) : 0
  };
}

// GET EVENTS
app.get('/events', async (req, res) => {
  const result = await pool.query('SELECT * FROM events ORDER BY id');
  res.json(result.rows.map(rowToEvent));
});

// ADD EVENT
app.post('/add-event', async (req, res) => {
  const { title, desc, date, lastDate, department, coordinator, location, maxSeats, imageUrl, price } = req.body;
  await pool.query(
    `INSERT INTO events (title, description, date, last_date, department, coordinator, location, max_seats, image_url, price)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [title, desc, date, lastDate, department, coordinator, location, maxSeats || null, imageUrl || null, price || 0]
  );
  res.json({ message: 'Event added' });
});

// DELETE EVENT
app.post('/delete-event', async (req, res) => {
  await pool.query('DELETE FROM events WHERE title = $1', [req.body.title]);
  res.json({ message: 'Deleted' });
});

// ===================== REGISTRATIONS =====================

// STUDENT EVENT REGISTRATION
app.post('/register', async (req, res) => {
  const { name, regNo, branch, event, transactionId } = req.body;

  const eventResult = await pool.query('SELECT * FROM events WHERE title = $1', [event]);
  const e = eventResult.rows[0];
  if (!e) return res.status(404).json({ error: 'Event not found' });

  const eventPrice = e.price ? parseFloat(e.price) : 0;
  if (eventPrice > 0 && !transactionId) {
    return res.status(400).json({ error: 'Transaction ID is required for paid events' });
  }

  const countResult = await pool.query(
    'SELECT COUNT(*) FROM registrations WHERE event_title = $1',
    [event]
  );
  const registeredCount = parseInt(countResult.rows[0].count, 10);

  if (e.max_seats && registeredCount >= e.max_seats) {
    return res.status(400).json({ error: 'Registration full' });
  }

  const now = new Date();
  await pool.query(
    `INSERT INTO registrations (name, reg_no, branch, event_title, reg_date, reg_time, transaction_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [name, regNo, branch, event, now.toLocaleDateString(), now.toLocaleTimeString(), transactionId || null]
  );

  res.json({ message: 'Registered' });
});

// GET REGISTRATIONS (joined with events so price is available per row)
app.get('/registrations', async (req, res) => {
  const result = await pool.query(`
    SELECT r.*, e.price AS event_price
    FROM registrations r
    LEFT JOIN events e ON r.event_title = e.title
    ORDER BY r.id
  `);
  res.json(result.rows.map(r => ({
    name: r.name,
    regNo: r.reg_no,
    branch: r.branch,
    event: r.event_title,
    date: r.reg_date,
    time: r.reg_time,
    transactionId: r.transaction_id,
    price: r.event_price ? parseFloat(r.event_price) : 0
  })));
});

// ===================== START SERVER =====================
initDB()
  .then(() => {
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  })
  .catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
