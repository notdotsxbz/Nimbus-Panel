# API Guide

Base URL: `https://<panel-domain>/api/v1`

Authentication: the web panel uses an httpOnly session cookie; API clients use
`Authorization: Bearer <token>` from `POST /auth/login`, or an API key
(Admin → API) with scoped permissions.

## Endpoints

```
POST   /auth/login                {identifier, password}        → session + redirect
POST   /auth/firebase             {idToken}                     → session (Firebase users)
POST   /auth/logout
GET    /auth/me

GET    /users?q=&page=            staff only
POST   /users                     admin only — create customer
PATCH  /users/:id/suspended       admin only
POST   /users/me/password         {current, next}
PATCH  /users/me/username         {username}

GET    /nodes                     staff only
POST   /nodes                     admin only — returns enrollment token
POST   /nodes/:id/maintenance     admin only
GET    /nodes/capacity            staff only — real per-node capacity

GET    /services                  customer: own; staff: all
POST   /services                  admin only — assign (capacity validated)
GET    /services/:id              ownership enforced
POST   /services/:id/power/:action   start|stop|restart|reinstall

GET    /allocations               staff only
POST   /allocations               admin only — manual (conflict-checked)
POST   /allocations/auto          admin only — next free port
DELETE /allocations/:id           admin only — release

GET    /domains                   customer: own; staff: all
POST   /domains/subdomain         free Nimbus hostname
POST   /domains/custom            issues TXT verification
POST   /domains/:id/verify
POST   /domains/:id/map           {serviceId}
DELETE /domains/:id

GET    /backups?serviceId=
POST   /backups                   {serviceId}
POST   /backups/:id/restore
GET    /backups/gdrive/auth-url   Google Drive OAuth (per account)
```

## Webhooks

Register endpoints (Admin → Webhooks) for events: `service.online`,
`service.offline`, `service.crash`, `backup.completed`, `backup.failed`,
`node.offline`, `node.recovered`, `domain.verified`, `subscription.expiring`.

## Rate limiting

Default 100 requests / 60 s per IP (`RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX_REQUESTS`).
Login is stricter (10/min). 429 responses include `Retry-After`.

## Errors

```json
{ "statusCode": 403, "message": "You do not own this service" }
```
