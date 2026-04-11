# NexCart — Deployment Guide

## 🚀 Deploy to Vercel + Railway (Free)

---

## Step 1 — Get a Free Cloud MySQL Database on Railway

1. Go to **https://railway.app** and sign up (free)
2. Click **New Project → Deploy MySQL**
3. After it provisions, click the MySQL service → **Variables** tab
4. Copy these values (you'll need them soon):
   - `MYSQLHOST`
   - `MYSQLUSER`
   - `MYSQLPASSWORD`
   - `MYSQLDATABASE`
   - `MYSQLPORT`

---

## Step 2 — Push to GitHub

1. Create a new repo on **https://github.com** (can be private)
2. In your project folder, run:

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/nexcart.git
git push -u origin main
```

---

## Step 3 — Deploy to Vercel

1. Go to **https://vercel.com** and sign up with GitHub
2. Click **Add New → Project**
3. Import your **nexcart** GitHub repo
4. Vercel will auto-detect the `vercel.json` — click **Deploy**
5. After first deploy, go to **Project Settings → Environment Variables**
6. Add these variables (use values from Railway Step 1):

| Name | Value |
|------|-------|
| `DB_HOST` | your Railway MYSQLHOST |
| `DB_USER` | your Railway MYSQLUSER |
| `DB_PASSWORD` | your Railway MYSQLPASSWORD |
| `DB_NAME` | your Railway MYSQLDATABASE |
| `DB_PORT` | your Railway MYSQLPORT |
| `DB_SSL` | `false` |
| `JWT_SECRET` | any long random string (e.g. `nexcart_abc123xyz_secret_2024`) |

7. Go to **Deployments → Redeploy** (so the env vars take effect)

---

## Step 4 — Done! 🎉

Your app is live. On first visit, the backend will:
- Auto-create all database tables
- Auto-create the default admin account

**Default Admin Login:**
- Email: `admin@nexcart.com`
- Password: `admin123`

> ⚠️ **Change the admin password immediately after first login!**

---

## Project Structure

```
nexcart/
├── api/
│   └── index.js          ← All backend API routes (serverless)
├── public/
│   ├── index.html        ← Home / product listing
│   ├── login.html        ← Login & register
│   ├── cart.html         ← Shopping cart & checkout
│   ├── profile.html      ← User profile & order history
│   ├── admin.html        ← Admin dashboard
│   ├── auth.js           ← Shared JWT auth helpers
│   └── css/
│       └── style.css     ← All styles
├── vercel.json           ← Vercel routing config
├── package.json          ← Dependencies
└── .env.example          ← Environment variable template
```

---

## Notes

- **Image uploads**: Vercel has no persistent filesystem. Use image URLs when adding products (e.g. Unsplash, Imgur).
- **Sessions**: Replaced with JWT tokens stored in `localStorage` — fully stateless and compatible with Vercel.
- **Database**: Auto-migrates on first cold start — no need to import SQL manually.
