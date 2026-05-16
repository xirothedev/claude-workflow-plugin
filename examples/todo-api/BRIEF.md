# Project brief — Todo API + minimal frontend

A deliberately small but real project used to exercise the `orchestrate` skill
end to end. Paste this file (or point at it) when `orchestrate` asks for context
in **Step 1 — Intake**.

## Goal

A todo-list app: a REST API with persistence and a minimal web frontend.

## Scope

- **Backend** — REST API with CRUD for todo items (`id`, `title`, `done`,
  `createdAt`). In-memory store is acceptable for v1; the storage layer must be
  swappable.
- **Frontend** — one page: list todos, add a todo, toggle `done`, delete a todo.
  No build step beyond what the framework needs.
- **Tests** — every API route has a test; the toggle/delete flows have a test.

## Out of scope

- Authentication, multi-user, deployment, real database, styling beyond legible.

## Success criteria

- `GET/POST/PATCH/DELETE /todos` all work and are covered by tests.
- The frontend can add, toggle, and delete a todo against the running API.
- Typecheck and the test suite both pass.

## Notes for the interview (Steps 2–4)

These are starting points — `orchestrate` should still confirm each via
`AskUserQuestion`, not assume them:

- Runtime/package manager: Bun.
- Backend framework: open (Hono / Express / built-in `Bun.serve`).
- Frontend: open (plain TS + DOM, or a small framework).
- Architecture: route → service → store layering; the store is an interface so
  in-memory can later be swapped for a database.
- Design system: minimal — one accent color, system font, legible spacing.
