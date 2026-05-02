require("dotenv").config();
require("express-async-errors");

const path = require("path");
const bcrypt = require("bcryptjs");
const cors = require("cors");
const express = require("express");
const helmet = require("helmet");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const { newDb } = require("pg-mem");
const { z } = require("zod");

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "replace-this-secret-before-production";
const DATABASE_URL = process.env.DATABASE_URL;

const pool = createPool();

function createPool() {
  if (DATABASE_URL) {
    return new Pool({
      connectionString: DATABASE_URL,
      ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
    });
  }

  const db = newDb({ autoCreateForeignKeyIndices: true });
  db.public.registerFunction({
    name: "now",
    returns: "timestamptz",
    implementation: () => new Date()
  });
  const adapter = db.adapters.createPg();
  console.warn("DATABASE_URL is not set. Using an in-memory local demo database.");
  return new adapter.Pool();
}

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const signupSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().email().max(160),
  password: z.string().min(6).max(100),
  role: z.enum(["admin", "member"]).optional()
});

const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1)
});

const projectSchema = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(1000).optional().default("")
});

const memberSchema = z.object({
  userId: z.coerce.number().int().positive(),
  role: z.enum(["admin", "member"]).default("member")
});

const taskSchema = z.object({
  title: z.string().trim().min(2).max(160),
  description: z.string().trim().max(2000).optional().default(""),
  assigneeId: z.coerce.number().int().positive().optional().nullable(),
  status: z.enum(["todo", "in_progress", "done"]).default("todo"),
  priority: z.enum(["low", "medium", "high"]).default("medium"),
  dueDate: z.string().date().optional().nullable()
});

const statusSchema = z.object({
  status: z.enum(["todo", "in_progress", "done"])
});

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, name: user.name, role: user.role },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function sendValidationError(res, error) {
  return res.status(400).json({
    error: "Validation failed",
    details: error.errors.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message
    }))
  });
}

async function query(text, params = []) {
  const result = await pool.query(text, params);
  return result;
}

async function initDb() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name VARCHAR(80) NOT NULL,
      email VARCHAR(160) NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role VARCHAR(20) NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS projects (
      id SERIAL PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS project_members (
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role VARCHAR(20) NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (project_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title VARCHAR(160) NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status VARCHAR(20) NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'in_progress', 'done')),
      priority VARCHAR(20) NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high')),
      due_date DATE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Authentication required" });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const { rows } = await query("SELECT id, name, email, role FROM users WHERE id = $1", [payload.id]);
    if (!rows[0]) return res.status(401).json({ error: "Invalid session" });
    req.user = rows[0];
    next();
  } catch (error) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

async function projectAccess(req, res, next) {
  const projectId = Number(req.params.projectId);
  if (!Number.isInteger(projectId) || projectId < 1) {
    return res.status(400).json({ error: "Invalid project id" });
  }

  const { rows } = await query(
    `SELECT p.*, pm.role AS member_role
     FROM projects p
     JOIN project_members pm ON pm.project_id = p.id
     WHERE p.id = $1 AND pm.user_id = $2`,
    [projectId, req.user.id]
  );

  if (!rows[0]) return res.status(404).json({ error: "Project not found" });
  req.project = rows[0];
  next();
}

function requireProjectAdmin(req, res, next) {
  if (req.user.role !== "admin" && req.project.member_role !== "admin") {
    return res.status(403).json({ error: "Admin access required for this project" });
  }
  next();
}

app.get("/api/health", async (_req, res) => {
  await query("SELECT 1");
  res.json({ ok: true });
});

app.post("/api/auth/signup", async (req, res) => {
  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error);

  const existing = await query("SELECT id FROM users WHERE email = $1", [parsed.data.email.toLowerCase()]);
  if (existing.rows[0]) return res.status(409).json({ error: "Email is already registered" });

  const passwordHash = await bcrypt.hash(parsed.data.password, 12);
  const { rows } = await query(
    `INSERT INTO users (name, email, password_hash, role)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, email, role`,
    [
      parsed.data.name,
      parsed.data.email.toLowerCase(),
      passwordHash,
      parsed.data.role || "member"
    ]
  );

  res.status(201).json({ user: rows[0], token: signToken(rows[0]) });
});

app.post("/api/auth/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error);

  const { rows } = await query("SELECT * FROM users WHERE email = $1", [parsed.data.email.toLowerCase()]);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(parsed.data.password, user.password_hash))) {
    return res.status(401).json({ error: "Invalid email or password" });
  }

  const publicUser = { id: user.id, name: user.name, email: user.email, role: user.role };
  res.json({ user: publicUser, token: signToken(publicUser) });
});

app.get("/api/me", auth, (req, res) => {
  res.json({ user: req.user });
});

app.get("/api/users", auth, async (_req, res) => {
  const { rows } = await query("SELECT id, name, email, role FROM users ORDER BY name ASC");
  res.json({ users: rows });
});

app.get("/api/projects", auth, async (req, res) => {
  const { rows } = await query(
    `SELECT p.id, p.name, p.description, p.owner_id, p.created_at, pm.role AS member_role,
            COUNT(t.id)::int AS task_count,
            COUNT(t.id) FILTER (WHERE t.status = 'done')::int AS done_count
     FROM projects p
     JOIN project_members pm ON pm.project_id = p.id
     LEFT JOIN tasks t ON t.project_id = p.id
     WHERE pm.user_id = $1
     GROUP BY p.id, p.name, p.description, p.owner_id, p.created_at, pm.role
     ORDER BY p.created_at DESC`,
    [req.user.id]
  );
  res.json({ projects: rows });
});

app.post("/api/projects", auth, async (req, res) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Only admins can create projects" });
  }

  const parsed = projectSchema.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const project = await client.query(
      `INSERT INTO projects (name, description, owner_id)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [parsed.data.name, parsed.data.description, req.user.id]
    );
    await client.query(
      `INSERT INTO project_members (project_id, user_id, role)
       VALUES ($1, $2, 'admin')`,
      [project.rows[0].id, req.user.id]
    );
    await client.query("COMMIT");
    res.status(201).json({ project: { ...project.rows[0], member_role: "admin" } });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

app.get("/api/projects/:projectId/members", auth, projectAccess, async (req, res) => {
  const { rows } = await query(
    `SELECT u.id, u.name, u.email, u.role AS global_role, pm.role AS project_role
     FROM project_members pm
     JOIN users u ON u.id = pm.user_id
     WHERE pm.project_id = $1
     ORDER BY u.name ASC`,
    [req.project.id]
  );
  res.json({ members: rows });
});

app.post("/api/projects/:projectId/members", auth, projectAccess, requireProjectAdmin, async (req, res) => {
  const parsed = memberSchema.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error);

  const user = await query("SELECT id FROM users WHERE id = $1", [parsed.data.userId]);
  if (!user.rows[0]) return res.status(404).json({ error: "User not found" });

  const { rows } = await query(
    `INSERT INTO project_members (project_id, user_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role
     RETURNING project_id, user_id, role`,
    [req.project.id, parsed.data.userId, parsed.data.role]
  );
  res.status(201).json({ member: rows[0] });
});

app.get("/api/projects/:projectId/tasks", auth, projectAccess, async (req, res) => {
  const { rows } = await query(
    `SELECT t.*, assignee.name AS assignee_name, creator.name AS creator_name
     FROM tasks t
     LEFT JOIN users assignee ON assignee.id = t.assignee_id
     JOIN users creator ON creator.id = t.created_by
     WHERE t.project_id = $1
     ORDER BY
       CASE t.status WHEN 'todo' THEN 1 WHEN 'in_progress' THEN 2 ELSE 3 END,
       t.due_date ASC NULLS LAST,
       t.created_at DESC`,
    [req.project.id]
  );
  res.json({ tasks: rows });
});

app.post("/api/projects/:projectId/tasks", auth, projectAccess, requireProjectAdmin, async (req, res) => {
  const parsed = taskSchema.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error);

  if (parsed.data.assigneeId) {
    const member = await query(
      "SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2",
      [req.project.id, parsed.data.assigneeId]
    );
    if (!member.rows[0]) return res.status(400).json({ error: "Assignee must be a project member" });
  }

  const { rows } = await query(
    `INSERT INTO tasks (project_id, title, description, assignee_id, created_by, status, priority, due_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      req.project.id,
      parsed.data.title,
      parsed.data.description,
      parsed.data.assigneeId || null,
      req.user.id,
      parsed.data.status,
      parsed.data.priority,
      parsed.data.dueDate || null
    ]
  );
  res.status(201).json({ task: rows[0] });
});

app.patch("/api/projects/:projectId/tasks/:taskId/status", auth, projectAccess, async (req, res) => {
  const parsed = statusSchema.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error);

  const taskId = Number(req.params.taskId);
  if (!Number.isInteger(taskId) || taskId < 1) return res.status(400).json({ error: "Invalid task id" });

  const existing = await query("SELECT * FROM tasks WHERE id = $1 AND project_id = $2", [taskId, req.project.id]);
  const task = existing.rows[0];
  if (!task) return res.status(404).json({ error: "Task not found" });

  const isAssigned = task.assignee_id === req.user.id;
  const isAdmin = req.user.role === "admin" || req.project.member_role === "admin";
  if (!isAdmin && !isAssigned) {
    return res.status(403).json({ error: "Only admins or assignees can update task status" });
  }

  const { rows } = await query(
    `UPDATE tasks
     SET status = $1, updated_at = NOW()
     WHERE id = $2
     RETURNING *`,
    [parsed.data.status, taskId]
  );
  res.json({ task: rows[0] });
});

app.get("/api/dashboard", auth, async (req, res) => {
  const { rows } = await query(
    `SELECT
       COUNT(t.id)::int AS total,
       COUNT(t.id) FILTER (WHERE t.status = 'todo')::int AS todo,
       COUNT(t.id) FILTER (WHERE t.status = 'in_progress')::int AS in_progress,
       COUNT(t.id) FILTER (WHERE t.status = 'done')::int AS done,
       COUNT(t.id) FILTER (WHERE t.due_date < CURRENT_DATE AND t.status <> 'done')::int AS overdue,
       COUNT(t.id) FILTER (WHERE t.assignee_id = $1 AND t.status <> 'done')::int AS assigned_open
     FROM tasks t
     JOIN project_members pm ON pm.project_id = t.project_id
     WHERE pm.user_id = $1`,
    [req.user.id]
  );

  const upcoming = await query(
    `SELECT t.id, t.title, t.status, t.priority, t.due_date, p.name AS project_name
     FROM tasks t
     JOIN projects p ON p.id = t.project_id
     JOIN project_members pm ON pm.project_id = p.id
     WHERE pm.user_id = $1 AND t.status <> 'done'
     ORDER BY t.due_date ASC NULLS LAST, t.priority DESC
     LIMIT 8`,
    [req.user.id]
  );

  res.json({ stats: rows[0], upcoming: upcoming.rows });
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: "Something went wrong" });
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Team Task Manager running on port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Failed to initialize database", error);
    process.exit(1);
  });
