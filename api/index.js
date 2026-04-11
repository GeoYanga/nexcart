const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');
const multer = require('multer');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── DB CONNECTION (uses env vars) ───────────────────────────────────────────
let pool;
function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host:     process.env.DB_HOST,
      user:     process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      port:     parseInt(process.env.DB_PORT || '3306'),
      ssl:      process.env.DB_SSL === 'true' ? { rejectUnauthorized: true } : undefined,
      waitForConnections: true,
      connectionLimit: 5,
      queueLimit: 0,
    });
  }
  return pool;
}

const JWT_SECRET = process.env.JWT_SECRET || 'nexcart_jwt_secret_change_me';

// ─── DB TEST ENDPOINT ─────────────────────────────────────────────────────────
app.get('/api/test', async (req, res) => {
  try {
    const [rows] = await getPool().query('SELECT 1 as ok');
    res.json({ 
      status: 'DB connected!', 
      rows,
      env: {
        DB_HOST: process.env.DB_HOST,
        DB_PORT: process.env.DB_PORT,
        DB_USER: process.env.DB_USER,
        DB_NAME: process.env.DB_NAME,
        DB_SSL: process.env.DB_SSL,
        JWT_SECRET: process.env.JWT_SECRET ? 'SET' : 'NOT SET'
      }
    });
  } catch (err) {
    res.status(500).json({ 
      status: 'DB FAILED', 
      error: err.message,
      code: err.code,
      env: {
        DB_HOST: process.env.DB_HOST,
        DB_PORT: process.env.DB_PORT,
        DB_USER: process.env.DB_USER,
        DB_NAME: process.env.DB_NAME,
        DB_SSL: process.env.DB_SSL,
      }
    });
  }
});

// ─── AUTH HELPERS ─────────────────────────────────────────────────────────────
function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized. Please log in.' });
  try {
    req.user = jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'Session expired. Please log in again.' }); }
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only.' });
    next();
  });
}

// ─── MULTER (memory storage for Vercel — no filesystem) ───────────────────────
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ─── AUTO-MIGRATE ─────────────────────────────────────────────────────────────
let migrated = false;
async function migrate() {
  if (migrated) return;
  migrated = true;
  const db = getPool();
  try {
    await db.query(`CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(100) NOT NULL UNIQUE,
      email VARCHAR(150) NOT NULL UNIQUE,
      password VARCHAR(255) NOT NULL,
      role ENUM('user','admin') DEFAULT 'user',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    await db.query(`CREATE TABLE IF NOT EXISTS products (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(200) NOT NULL,
      description TEXT,
      price DECIMAL(10,2) NOT NULL,
      stock INT DEFAULT 0,
      image_url VARCHAR(500),
      category VARCHAR(100) DEFAULT 'other',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    await db.query(`CREATE TABLE IF NOT EXISTS orders (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      total_amount DECIMAL(10,2) NOT NULL,
      status ENUM('pending','shipped','completed','cancelled') DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`);
    await db.query(`CREATE TABLE IF NOT EXISTS order_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      order_id INT NOT NULL,
      product_id INT NOT NULL,
      quantity INT NOT NULL,
      price DECIMAL(10,2) NOT NULL,
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
    )`);
    await db.query(`CREATE TABLE IF NOT EXISTS cart (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      product_id INT NOT NULL,
      quantity INT DEFAULT 1,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
    )`);
    // Add category column if missing (for existing DBs)
    try { await db.query("ALTER TABLE products ADD COLUMN category VARCHAR(100) DEFAULT 'other'"); } catch (_) {}
    // Seed admin
    const [admins] = await db.query("SELECT id FROM users WHERE email = 'admin@nexcart.com'");
    if (!admins.length) {
      const hashed = await bcrypt.hash('admin123', 10);
      await db.query("INSERT INTO users (username,email,password,role) VALUES ('Admin','admin@nexcart.com',?,'admin')", [hashed]);
    }
  } catch (e) { console.error('Migration error:', e.message); }
}

// Run migration on cold start
migrate();

// ─── AUTH ROUTES ──────────────────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) return res.status(400).json({ error: 'All fields required.' });
  try {
    const hashed = await bcrypt.hash(password, 10);
    await getPool().query('INSERT INTO users (username,email,password) VALUES (?,?,?)', [username, email, hashed]);
    res.json({ message: 'Registered successfully.' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Username or email already exists.' });
    res.status(500).json({ error: 'Server error.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'All fields required.' });
  try {
    const [rows] = await getPool().query('SELECT * FROM users WHERE email = ?', [email]);
    if (!rows.length) return res.status(401).json({ error: 'Invalid credentials.' });
    const user = rows[0];
    if (!await bcrypt.compare(password, user.password)) return res.status(401).json({ error: 'Invalid credentials.' });
    const token = signToken(user);
    res.json({ message: 'Login successful.', token, user: { id: user.id, username: user.username, email: user.email, role: user.role } });
  } catch (err) { res.status(500).json({ error: 'Server error.' }); }
});

app.post('/api/auth/logout', (req, res) => res.json({ message: 'Logged out.' }));

app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: req.user }));

// ─── PRODUCTS ROUTES ──────────────────────────────────────────────────────────
app.get('/api/products', async (req, res) => {
  const { search = '', page = 1, limit = 12, category = '', min_price = '', max_price = '', sort = '' } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  try {
    let where = '(name LIKE ? OR description LIKE ?)';
    let params = [`%${search}%`, `%${search}%`];
    if (category && category !== 'all') { where += ' AND category = ?'; params.push(category); }
    if (min_price !== '') { where += ' AND price >= ?'; params.push(parseFloat(min_price)); }
    if (max_price !== '') { where += ' AND price <= ?'; params.push(parseFloat(max_price)); }
    let orderBy = 'id DESC';
    if (sort === 'price_asc') orderBy = 'price ASC';
    else if (sort === 'price_desc') orderBy = 'price DESC';
    else if (sort === 'newest') orderBy = 'created_at DESC';
    else if (sort === 'name_asc') orderBy = 'name ASC';
    const [rows] = await getPool().query(`SELECT * FROM products WHERE ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`, [...params, parseInt(limit), offset]);
    const [[{ total }]] = await getPool().query(`SELECT COUNT(*) as total FROM products WHERE ${where}`, params);
    res.json({ products: rows, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error.' }); }
});

app.get('/api/products/:id', async (req, res) => {
  try {
    const [rows] = await getPool().query('SELECT * FROM products WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found.' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: 'Server error.' }); }
});

app.post('/api/products', requireAdmin, upload.single('image'), async (req, res) => {
  const { name, description, price, stock, image_url, category } = req.body;
  // For Vercel: file uploads go to image_url (use Cloudinary/external). 
  // If file uploaded, use provided image_url since we can't store files.
  const imgUrl = image_url || null;
  try {
    await getPool().query('INSERT INTO products (name,description,price,stock,image_url,category) VALUES (?,?,?,?,?,?)',
      [name, description, parseFloat(price), parseInt(stock) || 0, imgUrl, category || 'other']);
    res.json({ message: 'Product created.' });
  } catch (err) { res.status(500).json({ error: 'Server error.' }); }
});

app.put('/api/products/:id', requireAdmin, upload.single('image'), async (req, res) => {
  const { name, description, price, stock, image_url, category } = req.body;
  const imgUrl = image_url || null;
  try {
    await getPool().query('UPDATE products SET name=?,description=?,price=?,stock=?,image_url=?,category=? WHERE id=?',
      [name, description, parseFloat(price), parseInt(stock), imgUrl, category || 'other', req.params.id]);
    res.json({ message: 'Product updated.' });
  } catch (err) { res.status(500).json({ error: 'Server error.' }); }
});

app.delete('/api/products/:id', requireAdmin, async (req, res) => {
  try {
    await getPool().query('DELETE FROM products WHERE id = ?', [req.params.id]);
    res.json({ message: 'Deleted.' });
  } catch (err) { res.status(500).json({ error: 'Server error.' }); }
});

// ─── CART ROUTES ──────────────────────────────────────────────────────────────
app.get('/api/cart', requireAuth, async (req, res) => {
  try {
    const [rows] = await getPool().query(
      `SELECT c.id, c.quantity, p.id as product_id, p.name, p.price, p.image_url, p.stock
       FROM cart c JOIN products p ON c.product_id = p.id WHERE c.user_id = ?`,
      [req.user.id]
    );
    const total = rows.reduce((sum, r) => sum + r.price * r.quantity, 0);
    res.json({ items: rows, total: total.toFixed(2) });
  } catch (err) { res.status(500).json({ error: 'Server error.' }); }
});

app.post('/api/cart/add', requireAuth, async (req, res) => {
  const { product_id, quantity = 1 } = req.body;
  const userId = req.user.id;
  try {
    const [existing] = await getPool().query('SELECT * FROM cart WHERE user_id=? AND product_id=?', [userId, product_id]);
    if (existing.length) {
      await getPool().query('UPDATE cart SET quantity=quantity+? WHERE user_id=? AND product_id=?', [quantity, userId, product_id]);
    } else {
      await getPool().query('INSERT INTO cart (user_id,product_id,quantity) VALUES (?,?,?)', [userId, product_id, quantity]);
    }
    res.json({ message: 'Added to cart.' });
  } catch (err) { res.status(500).json({ error: 'Server error.' }); }
});

app.put('/api/cart/:id', requireAuth, async (req, res) => {
  const { quantity } = req.body;
  try {
    if (quantity < 1) await getPool().query('DELETE FROM cart WHERE id=?', [req.params.id]);
    else await getPool().query('UPDATE cart SET quantity=? WHERE id=?', [quantity, req.params.id]);
    res.json({ message: 'Updated.' });
  } catch (err) { res.status(500).json({ error: 'Server error.' }); }
});

app.delete('/api/cart/:id', requireAuth, async (req, res) => {
  try {
    await getPool().query('DELETE FROM cart WHERE id=?', [req.params.id]);
    res.json({ message: 'Removed.' });
  } catch (err) { res.status(500).json({ error: 'Server error.' }); }
});

// ─── ORDERS ROUTES ────────────────────────────────────────────────────────────
app.post('/api/orders/checkout', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const [cartItems] = await conn.query(
      `SELECT c.quantity, p.id as product_id, p.price, p.stock FROM cart c JOIN products p ON c.product_id=p.id WHERE c.user_id=?`,
      [userId]
    );
    if (!cartItems.length) { await conn.rollback(); return res.status(400).json({ error: 'Cart is empty.' }); }
    for (const item of cartItems) {
      if (item.stock < item.quantity) { await conn.rollback(); return res.status(400).json({ error: `Insufficient stock for a product.` }); }
    }
    const total = cartItems.reduce((s, i) => s + i.price * i.quantity, 0);
    const [result] = await conn.query('INSERT INTO orders (user_id,total_amount) VALUES (?,?)', [userId, total.toFixed(2)]);
    const orderId = result.insertId;
    for (const item of cartItems) {
      await conn.query('INSERT INTO order_items (order_id,product_id,quantity,price) VALUES (?,?,?,?)',
        [orderId, item.product_id, item.quantity, item.price]);
      await conn.query('UPDATE products SET stock=stock-? WHERE id=?', [item.quantity, item.product_id]);
    }
    await conn.query('DELETE FROM cart WHERE user_id=?', [userId]);
    await conn.commit();
    res.json({ message: 'Order placed!', orderId });
  } catch (err) { await conn.rollback(); res.status(500).json({ error: 'Server error.' }); }
  finally { conn.release(); }
});

app.get('/api/orders/my', requireAuth, async (req, res) => {
  try {
    const [orders] = await getPool().query('SELECT * FROM orders WHERE user_id=? ORDER BY created_at DESC', [req.user.id]);
    for (const o of orders) {
      const [items] = await getPool().query(
        'SELECT oi.*,p.name,p.image_url FROM order_items oi JOIN products p ON oi.product_id=p.id WHERE oi.order_id=?', [o.id]
      );
      o.items = items;
    }
    res.json(orders);
  } catch (err) { res.status(500).json({ error: 'Server error.' }); }
});

app.get('/api/orders/all', requireAdmin, async (req, res) => {
  try {
    const [orders] = await getPool().query(
      'SELECT o.*,u.email as user_email FROM orders o JOIN users u ON o.user_id=u.id ORDER BY o.created_at DESC'
    );
    for (const o of orders) {
      const [items] = await getPool().query(
        'SELECT oi.*,p.name,p.image_url FROM order_items oi JOIN products p ON oi.product_id=p.id WHERE oi.order_id=?', [o.id]
      );
      o.items = items;
    }
    res.json(orders);
  } catch (err) { res.status(500).json({ error: 'Server error.' }); }
});

app.put('/api/orders/:id/status', requireAdmin, async (req, res) => {
  try {
    await getPool().query('UPDATE orders SET status=? WHERE id=?', [req.body.status, req.params.id]);
    res.json({ message: 'Status updated.' });
  } catch (err) { res.status(500).json({ error: 'Server error.' }); }
});

// ─── USERS ROUTES ─────────────────────────────────────────────────────────────
app.get('/api/users', requireAdmin, async (req, res) => {
  try {
    const [rows] = await getPool().query('SELECT id,username,email,role,created_at FROM users ORDER BY id DESC');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Server error.' }); }
});

app.get('/api/users/me', requireAuth, async (req, res) => {
  try {
    const [rows] = await getPool().query('SELECT id,username,email,role,created_at FROM users WHERE id=?', [req.user.id]);
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: 'Server error.' }); }
});

app.put('/api/users/me/password', requireAuth, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) return res.status(400).json({ error: 'Both passwords required.' });
  if (new_password.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters.' });
  try {
    const [rows] = await getPool().query('SELECT password FROM users WHERE id=?', [req.user.id]);
    if (!await bcrypt.compare(current_password, rows[0].password)) return res.status(401).json({ error: 'Current password is incorrect.' });
    const hashed = await bcrypt.hash(new_password, 10);
    await getPool().query('UPDATE users SET password=? WHERE id=?', [hashed, req.user.id]);
    res.json({ message: 'Password updated.' });
  } catch (err) { res.status(500).json({ error: 'Server error.' }); }
});

app.post('/api/users', requireAdmin, async (req, res) => {
  const { username, email, password, role } = req.body;
  if (!username || !email || !password) return res.status(400).json({ error: 'All fields required.' });
  try {
    const hashed = await bcrypt.hash(password, 10);
    await getPool().query('INSERT INTO users (username,email,password,role) VALUES (?,?,?,?)', [username, email, hashed, role || 'user']);
    res.json({ message: 'User created.' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Username or email already exists.' });
    res.status(500).json({ error: 'Server error.' });
  }
});

app.put('/api/users/:id', requireAdmin, async (req, res) => {
  const { username, email, role, password } = req.body;
  if (!username || !email) return res.status(400).json({ error: 'Username and email required.' });
  try {
    if (password) {
      const hashed = await bcrypt.hash(password, 10);
      await getPool().query('UPDATE users SET username=?,email=?,role=?,password=? WHERE id=?', [username, email, role || 'user', hashed, req.params.id]);
    } else {
      await getPool().query('UPDATE users SET username=?,email=?,role=? WHERE id=?', [username, email, role || 'user', req.params.id]);
    }
    res.json({ message: 'User updated.' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Username or email already in use.' });
    res.status(500).json({ error: 'Server error.' });
  }
});

app.delete('/api/users/:id', requireAdmin, async (req, res) => {
  if (req.user.id == req.params.id) return res.status(400).json({ error: 'Cannot delete yourself.' });
  try {
    await getPool().query('DELETE FROM users WHERE id=?', [req.params.id]);
    res.json({ message: 'User deleted.' });
  } catch (err) { res.status(500).json({ error: 'Server error.' }); }
});

module.exports = app;
