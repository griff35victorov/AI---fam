# Prisma Migrations

The initial migration intentionally uses Prisma's default PostgreSQL names from `schema.prisma`: quoted PascalCase table names and camelCase column names.

This keeps the artifact compatible with the current schema without adding `@@map` or `@map`. If the database naming convention is later changed to snake_case names such as `users`, `telegram_user_id`, or `dedupe_key`, update `schema.prisma` with matching `@@map` and `@map` entries before running `prisma migrate`.

Foreign keys in the migration are limited to relations declared in the current Prisma schema. Scalar ID fields without a Prisma `@relation` are left as scalar columns to avoid schema drift.

The migration seeds the default `workspace-family` workspace because the Telegram runtime uses it as the fallback workspace for first conversations. Production still needs real `User` rows, including Telegram IDs, before webhook traffic is enabled.
