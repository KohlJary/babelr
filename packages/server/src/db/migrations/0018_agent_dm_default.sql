-- Agents and services now start at 'members_of_shared_servers' instead
-- of 'nobody' (defaultDmPolicy in dm-consent.ts). Move only the agents
-- still on the old default: dm_policy_set_at is written whenever anyone
-- sets a policy (the agent itself, or its sponsor at creation), so a row
-- with no set_at and no set_by has never been chosen. An agent that
-- chose 'nobody' (or anything else) keeps it. Idempotent: a re-run finds
-- no 'nobody' rows that were never set.
UPDATE "actors" SET "dm_policy" = 'members_of_shared_servers'
WHERE "kind" IN ('agent', 'service')
  AND "local" = true
  AND "dm_policy" = 'nobody'
  AND "dm_policy_set_at" IS NULL
  AND "dm_policy_set_by" IS NULL;
