CREATE TABLE `agent_definitions` (
  `id`                  TEXT    NOT NULL PRIMARY KEY,
  `name`                TEXT    NOT NULL,
  `description`         TEXT,
  `model_id`            TEXT    NOT NULL,
  `system_prompt`       TEXT    NOT NULL,
  `output_schema_json`  TEXT    NOT NULL,
  `max_runs_per_hour`   INTEGER NOT NULL DEFAULT 10,
  `is_active`           INTEGER NOT NULL DEFAULT 1,
  `created_at`          INTEGER NOT NULL,
  `updated_at`          INTEGER NOT NULL
);

CREATE TABLE `agent_assignments` (
  `id`            TEXT    NOT NULL PRIMARY KEY,
  `agent_id`      TEXT    NOT NULL REFERENCES `agent_definitions`(`id`) ON DELETE CASCADE,
  `mailbox`       TEXT,
  `person_id`     TEXT,
  `template_slug` TEXT    NOT NULL,
  `mode`          TEXT    NOT NULL,
  `is_active`     INTEGER NOT NULL DEFAULT 1,
  `created_at`    INTEGER NOT NULL,
  `updated_at`    INTEGER NOT NULL
);
CREATE INDEX `assignments_agent_idx`          ON `agent_assignments`(`agent_id`);
CREATE INDEX `assignments_mailbox_person_idx` ON `agent_assignments`(`mailbox`, `person_id`);

CREATE TABLE `agent_runs` (
  `id`             TEXT    NOT NULL PRIMARY KEY,
  `assignment_id`  TEXT    NOT NULL REFERENCES `agent_assignments`(`id`),
  `email_id`       TEXT    NOT NULL REFERENCES `emails`(`id`),
  `person_id`      TEXT    NOT NULL REFERENCES `people`(`id`),
  `status`         TEXT    NOT NULL,
  `action`         TEXT,
  `sent_email_id`  TEXT    REFERENCES `sent_emails`(`id`),
  `draft_id`       TEXT,
  `model_id`       TEXT,
  `input_tokens`   INTEGER,
  `output_tokens`  INTEGER,
  `error_message`  TEXT,
  `created_at`     INTEGER NOT NULL,
  `updated_at`     INTEGER NOT NULL
);
CREATE INDEX `runs_assignment_person_created_idx`
  ON `agent_runs`(`assignment_id`, `person_id`, `created_at`);
CREATE INDEX `runs_email_idx`          ON `agent_runs`(`email_id`);
CREATE INDEX `runs_status_created_idx` ON `agent_runs`(`status`, `created_at`);

CREATE TABLE `drafts` (
  `id`            TEXT    NOT NULL PRIMARY KEY,
  `person_id`     TEXT    NOT NULL REFERENCES `people`(`id`),
  `agent_run_id`  TEXT    NOT NULL REFERENCES `agent_runs`(`id`),
  `from_address`  TEXT    NOT NULL,
  `to_address`    TEXT    NOT NULL,
  `subject`       TEXT    NOT NULL,
  `body_html`     TEXT,
  `in_reply_to`   TEXT,
  `created_at`    INTEGER NOT NULL,
  `updated_at`    INTEGER NOT NULL
);
CREATE INDEX `drafts_person_created_idx` ON `drafts`(`person_id`, `created_at`);
CREATE INDEX `drafts_agent_run_idx`      ON `drafts`(`agent_run_id`);
