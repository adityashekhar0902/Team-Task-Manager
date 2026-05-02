# Team Task Manager

A full-stack web app for managing projects, teams, tasks, assignments, and progress with role-based access control.

## Features

- Signup and login with JWT authentication
- Global roles: `admin` and `member`
- Project roles: `admin` and `member`
- Admin project creation and team management
- Task creation, assignment, priority, due dates, and status tracking
- Member task status updates for assigned work
- Dashboard with total, status, overdue, and upcoming task summaries
- PostgreSQL schema with proper relationships and constraints

## Tech Stack

- Backend: Node.js, Express
- Database: PostgreSQL
- Auth: JWT, bcrypt password hashing
- Validation: Zod
- Frontend: HTML, CSS, vanilla JavaScript
- Deployment: Railway

## Local Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create `.env` from the example:

   ```bash
   cp .env.example .env
   ```

3. Update `DATABASE_URL` and `JWT_SECRET` in `.env`.

4. Start the app:

   ```bash
   npm run dev
   ```

5. Open `http://localhost:3000`.

The app creates the required tables automatically on startup.

## Railway Deployment

1. Push this project to GitHub.
2. Create a new Railway project from the GitHub repository.
3. Add a PostgreSQL service in the same Railway project.
4. In the web service variables, set:

   ```text
   DATABASE_URL=${{Postgres.DATABASE_URL}}
   JWT_SECRET=<a-long-random-secret>
   NODE_ENV=production
   ```

5. Deploy. Railway will run `npm start` through the included `railway.json`.

## REST API

| Method | Endpoint | Access |
| --- | --- | --- |
| `POST` | `/api/auth/signup` | Public |
| `POST` | `/api/auth/login` | Public |
| `GET` | `/api/me` | Authenticated |
| `GET` | `/api/users` | Authenticated |
| `GET` | `/api/dashboard` | Authenticated |
| `GET` | `/api/projects` | Authenticated |
| `POST` | `/api/projects` | Global admin |
| `GET` | `/api/projects/:projectId/members` | Project member |
| `POST` | `/api/projects/:projectId/members` | Project admin |
| `GET` | `/api/projects/:projectId/tasks` | Project member |
| `POST` | `/api/projects/:projectId/tasks` | Project admin |
| `PATCH` | `/api/projects/:projectId/tasks/:taskId/status` | Project admin or assignee |

## Demo Flow

1. Sign up as an Admin.
2. Create a project.
3. Sign up one or more Members.
4. Login as the Admin, add Members to the project, and create assigned tasks.
5. Login as a Member to update assigned task statuses and view the dashboard.
