const app = document.querySelector("#app");
const state = {
  token: localStorage.getItem("ttm_token"),
  user: JSON.parse(localStorage.getItem("ttm_user") || "null"),
  view: "dashboard",
  projects: [],
  selectedProjectId: null,
  users: [],
  members: [],
  tasks: [],
  taskSearch: "",
  taskStatus: "all",
  refreshTimer: null
};

const statusLabels = {
  todo: "To do",
  in_progress: "In progress",
  done: "Done"
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      ...(options.headers || {})
    }
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "Request failed");
  }
  return data;
}

function saveSession(payload) {
  state.token = payload.token;
  state.user = payload.user;
  localStorage.setItem("ttm_token", payload.token);
  localStorage.setItem("ttm_user", JSON.stringify(payload.user));
}

function clearSession() {
  stopAutoRefresh();
  state.token = null;
  state.user = null;
  state.selectedProjectId = null;
  state.projects = [];
  state.members = [];
  state.tasks = [];
  localStorage.removeItem("ttm_token");
  localStorage.removeItem("ttm_user");
}

function startAutoRefresh() {
  stopAutoRefresh();
  state.refreshTimer = setInterval(() => {
    const active = document.activeElement;
    const isEditing = active && ["INPUT", "SELECT", "TEXTAREA"].includes(active.tagName);
    if (!state.token || document.hidden || isEditing) return;
    loadView({ silent: true });
  }, 5000);
}

function stopAutoRefresh() {
  if (state.refreshTimer) {
    clearInterval(state.refreshTimer);
    state.refreshTimer = null;
  }
}

function render() {
  if (!state.token || !state.user) {
    renderAuth();
    return;
  }
  renderShell();
}

function renderAuth() {
  app.innerHTML = document.querySelector("#auth-template").innerHTML;
  let mode = "login";
  const form = document.querySelector("#auth-form");
  const message = document.querySelector("#auth-message");
  const heading = document.querySelector("#auth-heading");
  const nameField = document.querySelector("#name-field");
  const roleField = document.querySelector("#role-field");
  const tabs = document.querySelectorAll("[data-auth-tab]");
  const submit = form.querySelector("button[type='submit']");

  function setMode(nextMode) {
    mode = nextMode;
    tabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.authTab === mode));
    nameField.classList.toggle("hidden", mode !== "signup");
    roleField.classList.toggle("hidden", mode !== "signup");
    heading.textContent = mode === "signup" ? "Signup" : "Login";
    submit.textContent = mode === "signup" ? "Create account" : "Login";
    message.textContent = "";
  }

  tabs.forEach((tab) => tab.addEventListener("click", () => setMode(tab.dataset.authTab)));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    message.textContent = "";
    const formData = new FormData(form);
    const payload = {
      email: formData.get("email"),
      password: formData.get("password")
    };
    if (mode === "signup") {
      payload.name = formData.get("name");
      payload.role = formData.get("role");
    }

    try {
      submit.disabled = true;
      submit.textContent = mode === "signup" ? "Creating..." : "Logging in...";
      const data = await api(`/api/auth/${mode}`, {
        method: "POST",
        body: JSON.stringify(payload)
      });
      saveSession(data);
      await bootstrap();
    } catch (error) {
      message.textContent = error.message;
      submit.disabled = false;
      submit.textContent = mode === "signup" ? "Create account" : "Login";
    }
  });
}

function renderShell() {
  app.innerHTML = document.querySelector("#app-template").innerHTML;
  document.querySelector("#current-user").textContent = state.user.name;
  document.querySelector("#current-role").textContent = state.user.role === "admin" ? "Global Admin" : "Member";
  document.querySelector("#logout").addEventListener("click", () => {
    clearSession();
    render();
  });
  document.querySelector("#refresh").addEventListener("click", () => loadView());
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === state.view);
    button.addEventListener("click", () => {
      state.view = button.dataset.view;
      renderShell();
      loadView();
    });
  });
  startAutoRefresh();
  loadView();
}

function setTitle(kicker, title) {
  document.querySelector("#view-kicker").textContent = kicker;
  document.querySelector("#view-title").textContent = title;
}

function showNotice(message) {
  const notice = document.querySelector("#notice");
  notice.textContent = message;
  notice.classList.toggle("hidden", !message);
}

function toast(message) {
  document.querySelector(".toast")?.remove();
  const element = document.createElement("div");
  element.className = "toast";
  element.textContent = message;
  document.body.appendChild(element);
  setTimeout(() => element.remove(), 2600);
}

async function loadView(options = {}) {
  try {
    if (!options.silent) showNotice("");
    if (state.view === "dashboard") await renderDashboard();
    if (state.view === "projects") await renderProjects();
  } catch (error) {
    if (!options.silent) showNotice(error.message);
  }
}

async function renderDashboard() {
  setTitle("Dashboard", "Overview");
  const [{ stats, upcoming }, projectsData] = await Promise.all([
    api("/api/dashboard"),
    api("/api/projects")
  ]);
  state.projects = projectsData.projects;
  const view = document.querySelector("#view");
  view.innerHTML = `
    <div class="grid stats">
      ${statCard("Total", stats.total)}
      ${statCard("To do", stats.todo)}
      ${statCard("In progress", stats.in_progress)}
      ${statCard("Done", stats.done)}
      ${statCard("Overdue", stats.overdue)}
    </div>
    <div class="grid two-col" style="margin-top:16px">
      <section class="panel">
        <h2>Upcoming work</h2>
        <div class="task-list">
          ${upcoming.length ? upcoming.map(compactTask).join("") : `<div class="empty">No open tasks yet.</div>`}
        </div>
      </section>
      <section class="panel">
        <h2>Project progress</h2>
        <div class="project-list">
          ${state.projects.length ? state.projects.map(progressProject).join("") : `<div class="empty">Create a project to get started.</div>`}
        </div>
      </section>
    </div>
  `;
}

function statCard(label, value) {
  return `<div class="stat"><span class="muted">${label}</span><strong>${value || 0}</strong></div>`;
}

function compactTask(task) {
  return `
    <article class="task-card">
      <div class="row">
        <strong>${escapeHtml(task.title)}</strong>
        <span class="pill ${task.status}">${statusLabels[task.status]}</span>
      </div>
      <div class="meta">
        <span class="pill">${escapeHtml(task.project_name || "")}</span>
        <span class="pill ${task.priority}">${task.priority}</span>
        ${task.due_date ? `<span class="pill ${isOverdue(task) ? "overdue" : ""}">${formatDate(task.due_date)}</span>` : ""}
      </div>
    </article>
  `;
}

function progressProject(project) {
  const total = Number(project.task_count) || 0;
  const done = Number(project.done_count) || 0;
  const percent = total ? Math.round((done / total) * 100) : 0;
  return `
    <article class="project-card">
      <div class="row">
        <strong>${escapeHtml(project.name)}</strong>
        <span class="pill">${percent}%</span>
      </div>
      <div class="muted">${done} of ${total} tasks complete</div>
      <progress value="${done}" max="${total || 1}"></progress>
    </article>
  `;
}

async function renderProjects() {
  setTitle("Projects", "Team workspace");
  const [projectsData, usersData] = await Promise.all([api("/api/projects"), api("/api/users")]);
  state.projects = projectsData.projects;
  state.users = usersData.users;
  const selectedStillVisible = state.projects.some((project) => project.id === state.selectedProjectId);
  if (!selectedStillVisible) {
    state.selectedProjectId = state.projects[0]?.id || null;
    state.members = [];
    state.tasks = [];
  }

  const selected = state.projects.find((project) => project.id === state.selectedProjectId);
  if (selected) {
    const [membersData, tasksData] = await Promise.all([
      api(`/api/projects/${selected.id}/members`),
      api(`/api/projects/${selected.id}/tasks`)
    ]);
    state.members = membersData.members;
    state.tasks = tasksData.tasks;
  }

  const view = document.querySelector("#view");
  view.innerHTML = `
    <div class="grid two-col">
      <section class="panel">
        <div class="row">
          <h2>Projects</h2>
          ${state.user.role === "admin" ? `<button class="secondary" data-action="new-project" type="button">New project</button>` : ""}
        </div>
        <div class="project-list">
          ${state.projects.length ? state.projects.map(projectCard).join("") : `<div class="empty">No projects available.</div>`}
        </div>
      </section>
      <section id="project-detail" class="panel">
        ${selected ? detailPanel(selected) : `<div class="empty">Select a project to manage tasks.</div>`}
      </section>
    </div>
  `;

  bindProjectEvents(selected);
}

function projectCard(project) {
  return `
    <article class="project-card ${project.id === state.selectedProjectId ? "selected" : ""}" data-project-id="${project.id}">
      <div class="row">
        <strong>${escapeHtml(project.name)}</strong>
        <span class="pill">${project.member_role}</span>
      </div>
      <p class="muted">${escapeHtml(project.description || "No description")}</p>
      <div class="meta">
        <span class="pill">${project.task_count} tasks</span>
        <span class="pill done">${project.done_count} done</span>
      </div>
    </article>
  `;
}

function detailPanel(project) {
  const canAdmin = state.user.role === "admin" || project.member_role === "admin";
  const filteredTasks = state.tasks.filter((task) => {
    const text = `${task.title} ${task.description || ""} ${task.assignee_name || ""}`.toLowerCase();
    const matchesSearch = text.includes(state.taskSearch.toLowerCase());
    const matchesStatus = state.taskStatus === "all" || task.status === state.taskStatus;
    return matchesSearch && matchesStatus;
  });
  return `
    <div class="row">
      <div>
        <h2>${escapeHtml(project.name)}</h2>
        <p class="muted">${escapeHtml(project.description || "")}</p>
      </div>
    </div>
    <div class="grid" style="margin-top:16px">
      <div>
        <div class="row">
          <h3>Tasks</h3>
          ${canAdmin ? `<button class="secondary" data-action="show-task-form" type="button">New task</button>` : ""}
        </div>
        <div class="toolbar">
          <input id="task-search" type="search" placeholder="Search tasks" value="${escapeHtml(state.taskSearch)}" />
          <select id="task-status-filter">
            <option value="all" ${state.taskStatus === "all" ? "selected" : ""}>All statuses</option>
            ${Object.entries(statusLabels).map(([value, label]) => `<option value="${value}" ${state.taskStatus === value ? "selected" : ""}>${label}</option>`).join("")}
          </select>
        </div>
        <div class="task-list">
          ${filteredTasks.length ? filteredTasks.map(taskCard).join("") : `<div class="empty">No matching tasks.</div>`}
        </div>
      </div>
      ${canAdmin ? `<div id="task-form-wrap" class="hidden">${taskForm(project)}</div>` + memberForm() : ""}
      <div>
        <h3>Members</h3>
        <div class="member-list">
          ${state.members.map((member) => `
            <div class="row">
              <span>${escapeHtml(member.name)}</span>
              <span class="pill">${member.project_role}</span>
            </div>
          `).join("")}
        </div>
      </div>
    </div>
  `;
}

function taskCard(task) {
  return `
    <article class="task-card">
      <div class="row">
        <strong>${escapeHtml(task.title)}</strong>
        <select class="status-select" data-task-status="${task.id}">
          ${Object.entries(statusLabels).map(([value, label]) => `
            <option value="${value}" ${task.status === value ? "selected" : ""}>${label}</option>
          `).join("")}
        </select>
      </div>
      <p class="muted">${escapeHtml(task.description || "")}</p>
      <div class="meta">
        <span class="pill ${task.priority}">${task.priority}</span>
        ${task.assignee_name ? `<span class="pill">${escapeHtml(task.assignee_name)}</span>` : `<span class="pill">Unassigned</span>`}
        ${task.due_date ? `<span class="pill ${isOverdue(task) ? "overdue" : ""}">${formatDate(task.due_date)}</span>` : ""}
      </div>
    </article>
  `;
}

function taskForm() {
  return `
    <form id="task-form" class="form-block stack">
      <h3>Create task</h3>
      <div class="field"><label for="task-title">Title</label><input id="task-title" name="title" required /></div>
      <div class="field"><label for="task-description">Description</label><textarea id="task-description" name="description"></textarea></div>
      <div class="field">
        <label for="assigneeId">Assignee</label>
        <select id="assigneeId" name="assigneeId">
          <option value="">Unassigned</option>
          ${state.members.map((member) => `<option value="${member.id}">${escapeHtml(member.name)}</option>`).join("")}
        </select>
      </div>
      <div class="field">
        <label for="priority">Priority</label>
        <select id="priority" name="priority">
          <option value="low">Low</option>
          <option value="medium" selected>Medium</option>
          <option value="high">High</option>
        </select>
      </div>
      <div class="field"><label for="dueDate">Due date</label><input id="dueDate" name="dueDate" type="date" /></div>
      <button class="primary" type="submit">Add task</button>
    </form>
  `;
}

function memberForm() {
  const currentIds = new Set(state.members.map((member) => member.id));
  const available = state.users.filter((user) => !currentIds.has(user.id));
  return `
    <form id="member-form" class="form-block stack">
      <h3>Add member</h3>
      <div class="field">
        <label for="userId">User</label>
        <select id="userId" name="userId" required>
          ${available.map((user) => `<option value="${user.id}">${escapeHtml(user.name)} (${escapeHtml(user.email)})</option>`).join("")}
        </select>
      </div>
      <div class="field">
        <label for="memberRole">Project role</label>
        <select id="memberRole" name="role">
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </select>
      </div>
      <button class="secondary" type="submit" ${available.length ? "" : "disabled"}>Add to project</button>
    </form>
  `;
}

function openProjectModal() {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <section class="modal">
      <form id="project-form" class="stack">
        <div class="row">
          <h2>Create project</h2>
          <button class="ghost" data-action="close-modal" type="button">Close</button>
        </div>
        <div class="field">
          <label for="project-name">Project name</label>
          <input id="project-name" name="name" required maxlength="120" autofocus />
        </div>
        <div class="field">
          <label for="project-description">Description</label>
          <textarea id="project-description" name="description" maxlength="1000"></textarea>
        </div>
        <button class="primary" type="submit">Create project</button>
      </form>
    </section>
  `;
  document.body.appendChild(backdrop);

  const close = () => backdrop.remove();
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop || event.target.dataset.action === "close-modal") close();
  });
  document.addEventListener("keydown", function escape(event) {
    if (event.key === "Escape") {
      close();
      document.removeEventListener("keydown", escape);
    }
  });

  backdrop.querySelector("#project-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = event.target.querySelector("button[type='submit']");
    const payload = Object.fromEntries(new FormData(event.target).entries());
    submit.disabled = true;
    submit.textContent = "Creating...";
    try {
      const data = await api("/api/projects", {
        method: "POST",
        body: JSON.stringify(payload)
      });
      state.selectedProjectId = data.project.id;
      close();
      toast("Project created");
      renderProjects();
    } catch (error) {
      submit.disabled = false;
      submit.textContent = "Create project";
      showNotice(error.message);
    }
  });
}

function bindProjectEvents(selected) {
  document.querySelectorAll("[data-project-id]").forEach((card) => {
    card.addEventListener("click", () => {
      state.selectedProjectId = Number(card.dataset.projectId);
      renderProjects();
    });
  });

  document.querySelector("[data-action='new-project']")?.addEventListener("click", openProjectModal);

  document.querySelector("[data-action='show-task-form']")?.addEventListener("click", () => {
    document.querySelector("#task-form-wrap")?.classList.toggle("hidden");
  });

  document.querySelector("#task-search")?.addEventListener("input", (event) => {
    state.taskSearch = event.target.value;
    const selectedProject = state.projects.find((project) => project.id === state.selectedProjectId);
    document.querySelector("#project-detail").innerHTML = detailPanel(selectedProject);
    bindProjectEvents(selectedProject);
  });

  document.querySelector("#task-status-filter")?.addEventListener("change", (event) => {
    state.taskStatus = event.target.value;
    const selectedProject = state.projects.find((project) => project.id === state.selectedProjectId);
    document.querySelector("#project-detail").innerHTML = detailPanel(selectedProject);
    bindProjectEvents(selectedProject);
  });

  document.querySelectorAll("[data-task-status]").forEach((select) => {
    select.addEventListener("change", async () => {
      const previous = state.tasks.find((task) => task.id === Number(select.dataset.taskStatus))?.status;
      try {
        await api(`/api/projects/${selected.id}/tasks/${select.dataset.taskStatus}/status`, {
          method: "PATCH",
          body: JSON.stringify({ status: select.value })
        });
        toast("Task status updated");
        renderProjects();
      } catch (error) {
        if (previous) select.value = previous;
        showNotice(error.message);
      }
    });
  });

  document.querySelector("#task-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target).entries());
    await api(`/api/projects/${selected.id}/tasks`, {
      method: "POST",
      body: JSON.stringify({
        ...data,
        assigneeId: data.assigneeId || null,
        dueDate: data.dueDate || null
      })
    });
    toast("Task added");
    renderProjects();
  });

  document.querySelector("#member-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target).entries());
    await api(`/api/projects/${selected.id}/members`, {
      method: "POST",
      body: JSON.stringify(data)
    });
    toast("Member added");
    renderProjects();
  });
}

async function bootstrap() {
  try {
    if (state.token) {
      const { user } = await api("/api/me");
      state.user = user;
      localStorage.setItem("ttm_user", JSON.stringify(user));
    }
    render();
  } catch (error) {
    clearSession();
    render();
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
}

function isOverdue(task) {
  return task.due_date && task.status !== "done" && new Date(task.due_date) < new Date(new Date().toDateString());
}

bootstrap();
