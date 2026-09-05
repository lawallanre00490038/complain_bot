// ─── Database Initialization Script ──────────────────────────────────────────
// Run this once to create the custom survey tables in PostgreSQL.
// Usage: npx tsx src/db-init.ts
//
// Mastra auto-creates its own tables (threads, messages, traces, etc.)
// but we need custom tables for survey tracking.
import pool from "./db/index.js";

async function runMigration(client: any, id: string, sql: string) {
  const exists = await client.query(
    'SELECT 1 FROM schema_migrations WHERE id = $1 LIMIT 1',
    [id]
  );

  if ((exists?.rowCount ?? 0) > 0) {
    return false;
  }

  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [id]);
    await client.query('COMMIT');
    console.log(`✅ Applied migration: ${id}`);
    return true;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  }
}

export const initDatabase = async () => {

  try {
    console.log('🔧 Connecting to PostgreSQL...');
    const client = await pool.connect();

    // --- ADD THIS BLOCK HERE ---
    console.log('🧹 Cleaning up old data and migration history...');
    
    // await client.query(`
    //   -- Drop tables in order of dependency
    //   DROP TABLE IF EXISTS schema_migrations CASCADE; 
    //   DROP TABLE IF EXISTS survey_responses CASCADE;
    //   DROP TABLE IF EXISTS survey_sessions CASCADE;
    //   DROP TABLE IF EXISTS surveys CASCADE;
    //   DROP TABLE IF EXISTS meta_flow_responses CASCADE;
    //   DROP TABLE IF EXISTS meta_flow_surveys CASCADE;
    //   DROP TABLE IF EXISTS chat_history CASCADE;
    //   DROP TABLE IF EXISTS escalation_messages CASCADE;
    //   DROP TABLE IF EXISTS escalations CASCADE;
    //   DROP TABLE IF EXISTS branches CASCADE;
    // `);

    console.log('📦 Initializing database...');

    // ───────────────────────────────────────────────────────────
    // Enable extension (for UUID if you switch later)
    // ───────────────────────────────────────────────────────────
    await client.query(`
      CREATE EXTENSION IF NOT EXISTS "pgcrypto";
    `);

    // Track one-time schema migrations for additive DB updates.
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);


    await client.query(`
      CREATE TABLE IF NOT EXISTS branches (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        address TEXT NOT NULL,
        latitude DOUBLE PRECISION NOT NULL,
        longitude DOUBLE PRECISION NOT NULL,
        geocoded_address TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // ───────────────────────────────────────────────────────────
    // Survey Sessions Table
    // ───────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS survey_sessions (
        id                TEXT PRIMARY KEY,
        survey_id         TEXT NOT NULL,
        customer_phone    TEXT NOT NULL,

        current_question  INTEGER NOT NULL DEFAULT 0,
        total_questions   INTEGER NOT NULL,

        questions_data    JSONB NOT NULL DEFAULT '[]'::jsonb,

        status            TEXT NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'completed', 'abandoned')),

        expires_at        TIMESTAMPTZ,

        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // ───────────────────────────────────────────────────────────
    // Survey Responses Table
    // ───────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS survey_responses (
        id               TEXT PRIMARY KEY,
        survey_id        TEXT NOT NULL,
        session_id       TEXT NOT NULL,
        customer_phone   TEXT NOT NULL,

        question_text    TEXT,
        question_id      TEXT NOT NULL,

        response_text    TEXT NOT NULL,
        response_id      TEXT,

        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT fk_session
          FOREIGN KEY (session_id)
          REFERENCES survey_sessions(id)
          ON DELETE CASCADE,

        CONSTRAINT unique_response_per_question
          UNIQUE (session_id, question_id)
      );
    `);

    // ───────────────────────────────────────────────────────────
    // Indexes (Performance critical)
    // ───────────────────────────────────────────────────────────
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_active_session
      ON survey_sessions (customer_phone, status);

      CREATE INDEX IF NOT EXISTS idx_survey_sessions_survey_id
      ON survey_sessions (survey_id);

      CREATE INDEX IF NOT EXISTS idx_survey_responses_session_id
      ON survey_responses (session_id);

      CREATE INDEX IF NOT EXISTS idx_session_question
      ON survey_responses (session_id, question_id);

      CREATE INDEX IF NOT EXISTS idx_survey_responses_survey_id
      ON survey_responses (survey_id);
    `);

      // ───────────────────────────────────────────────────────────
      // Escalation Table (for human handoff / tickets)
      // ───────────────────────────────────────────────────────────
      await client.query(`
        CREATE TABLE IF NOT EXISTS escalations (
          id              SERIAL PRIMARY KEY,
          ticket_id       TEXT UNIQUE NOT NULL,
          message         TEXT,
          category        TEXT CHECK (category IN ('complaint','enquiry','request')),
          ticket_status   TEXT NOT NULL DEFAULT 'pending' CHECK (ticket_status IN ('pending','completed')),
          customer_phone  TEXT,
          user_account_number TEXT,
          human_agent_active BOOLEAN NOT NULL DEFAULT FALSE,
          archived_at     TIMESTAMPTZ,
          is_archived BOOLEAN NOT NULL DEFAULT FALSE,
          human_engaged_at TIMESTAMPTZ,

          created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);

      await runMigration(
        client,
        '2026_06_01_escalations_human_handoff_columns',
        `
          ALTER TABLE escalations
          ADD COLUMN IF NOT EXISTS human_agent_active BOOLEAN NOT NULL DEFAULT FALSE;

          ALTER TABLE escalations
          ADD COLUMN IF NOT EXISTS human_engaged_at TIMESTAMPTZ;

          ALTER TABLE escalations
          ADD COLUMN IF NOT EXISTS handoff_phone TEXT;
        `
      );

      await runMigration(
        client,
        '2026_07_08_escalations_user_account_number',
        `
          ALTER TABLE escalations
          ADD COLUMN IF NOT EXISTS user_account_number TEXT;
        `
      );

      await runMigration(
        client,
        '2026_06_01_escalation_messages_table',
        `
          CREATE TABLE IF NOT EXISTS escalation_messages (
            id SERIAL PRIMARY KEY,
            ticket_id TEXT NOT NULL,
            direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
            message_text TEXT NOT NULL,
            customer_phone TEXT,
            source_message_id TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT fk_escalation_message_ticket
              FOREIGN KEY (ticket_id)
              REFERENCES escalations(ticket_id)
              ON DELETE CASCADE
          );

          CREATE INDEX IF NOT EXISTS idx_escalation_messages_ticket_created
          ON escalation_messages (ticket_id, created_at DESC);

          CREATE INDEX IF NOT EXISTS idx_escalation_messages_ticket_direction
          ON escalation_messages (ticket_id, direction);
        `
      );

      await runMigration(
        client,
        '2026_06_01_chat_history_table',
        `
          CREATE TABLE IF NOT EXISTS chat_history (
            id SERIAL PRIMARY KEY,
            thread_id TEXT NOT NULL,
            role TEXT NOT NULL CHECK (role IN ('AI', 'Human', 'Customer')),
            message_text TEXT NOT NULL,
            escalation_id TEXT,
            source_message_id TEXT,
            channel TEXT NOT NULL DEFAULT 'whatsapp',
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT fk_chat_history_escalation
              FOREIGN KEY (escalation_id)
              REFERENCES escalations(ticket_id)
              ON DELETE SET NULL
          );

          CREATE INDEX IF NOT EXISTS idx_chat_history_thread_created
          ON chat_history (thread_id, created_at DESC);

          CREATE INDEX IF NOT EXISTS idx_chat_history_role_created
          ON chat_history (role, created_at DESC);

          CREATE INDEX IF NOT EXISTS idx_chat_history_escalation_created
          ON chat_history (escalation_id, created_at DESC);
        `
      );

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_escalations_ticket_status
        ON escalations (ticket_status);

        CREATE INDEX IF NOT EXISTS idx_escalations_ticket_id
        ON escalations (ticket_id);

        CREATE INDEX IF NOT EXISTS idx_escalations_customer_phone
        ON escalations (customer_phone);
      `);

    // ───────────────────────────────────────────────────────────
    // Auto-update updated_at trigger
    // ───────────────────────────────────────────────────────────
    await client.query(`
      CREATE OR REPLACE FUNCTION update_updated_at_column()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_trigger
          WHERE tgname = 'trigger_update_survey_sessions_updated_at'
        ) THEN
          CREATE TRIGGER trigger_update_survey_sessions_updated_at
          BEFORE UPDATE ON survey_sessions
          FOR EACH ROW
          EXECUTE FUNCTION update_updated_at_column();
        END IF;
      END;
      $$;
    `);


    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_trigger
          WHERE tgname = 'trigger_update_escalations_updated_at'
        ) THEN
          CREATE TRIGGER trigger_update_escalations_updated_at
          BEFORE UPDATE ON escalations
          FOR EACH ROW
          EXECUTE FUNCTION update_updated_at_column();
        END IF;
      END;
      $$;
    `);

    await runMigration(
        client,
        '2026_06_surveys_table',
        `
          CREATE TABLE IF NOT EXISTS surveys (
            id              TEXT PRIMARY KEY,
            name            TEXT NOT NULL,
            mode            TEXT NOT NULL CHECK (mode IN ('ai', 'manual', 'meta')),
            description     TEXT,
            questions_data  JSONB NOT NULL DEFAULT '[]'::jsonb,
            status          TEXT NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active', 'inactive', 'draft')),
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            is_archived     BOOLEAN NOT NULL DEFAULT FALSE,
            archived_at     TIMESTAMPTZ 
          );

          CREATE INDEX IF NOT EXISTS idx_surveys_mode ON surveys(mode);
          CREATE INDEX IF NOT EXISTS idx_surveys_status ON surveys(status);
        `
      );
      


       await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_trigger
            WHERE tgname = 'trigger_update_surveys_updated_at'
          ) THEN
            CREATE TRIGGER trigger_update_surveys_updated_at
            BEFORE UPDATE ON surveys
            FOR EACH ROW
            EXECUTE FUNCTION update_updated_at_column();
          END IF;
        END;
        $$;
      `);

      // ─────────────────────────────────────────────────────────
      // Meta WhatsApp Flow Surveys  (new tables migration)
      // ─────────────────────────────────────────────────────────
      await runMigration(
        client,
        '2026_06_meta_flow_surveys',
        `
          CREATE TABLE IF NOT EXISTS meta_flow_surveys (
            id                TEXT PRIMARY KEY,
            flow_id           TEXT UNIQUE NOT NULL,
            flow_name         TEXT NOT NULL,
            survey_id         TEXT,
            questions_data    JSONB NOT NULL DEFAULT '[]'::jsonb,
            status            TEXT NOT NULL DEFAULT 'draft'
                              CHECK (status IN ('draft', 'published', 'deprecated')),
            data_endpoint_url TEXT,

            is_archived       BOOLEAN NOT NULL DEFAULT FALSE,
            archived_at       TIMESTAMPTZ,

            created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );

          CREATE INDEX IF NOT EXISTS idx_meta_flow_surveys_status
          ON meta_flow_surveys (status);

          CREATE INDEX IF NOT EXISTS idx_meta_flow_surveys_survey_id
          ON meta_flow_surveys (survey_id);
        `
      );

      await runMigration(
        client,
        '2026_06_meta_flow_surveys_archival_patch',
        `
          ALTER TABLE meta_flow_surveys
            ADD COLUMN IF NOT EXISTS is_archived BOOLEAN NOT NULL DEFAULT FALSE;

          ALTER TABLE meta_flow_surveys
            ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
        `
      );

      await runMigration(
        client,
        '2026_06_meta_flow_responses',
        `
          CREATE TABLE IF NOT EXISTS meta_flow_responses (
            id              TEXT PRIMARY KEY,
            flow_id         TEXT NOT NULL,
            flow_token      TEXT NOT NULL,
            customer_phone  TEXT,
            survey_id       TEXT,
            responses       JSONB NOT NULL DEFAULT '{}'::jsonb,
            source          TEXT NOT NULL DEFAULT 'data_exchange'
                            CHECK (source IN ('data_exchange', 'nfm_reply')),
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );

          CREATE INDEX IF NOT EXISTS idx_meta_flow_responses_flow_id
          ON meta_flow_responses (flow_id);

          CREATE INDEX IF NOT EXISTS idx_meta_flow_responses_phone
          ON meta_flow_responses (customer_phone);

          CREATE INDEX IF NOT EXISTS idx_meta_flow_responses_created
          ON meta_flow_responses (created_at DESC);

          CREATE INDEX IF NOT EXISTS idx_meta_flow_responses_flow_token
          ON meta_flow_responses (flow_token);
        `
      );

      await runMigration(
        client,
        '2026_06_meta_flow_token_map',
        `
          CREATE TABLE IF NOT EXISTS meta_flow_token_map (
            flow_token      TEXT PRIMARY KEY,
            flow_id         TEXT NOT NULL,
            survey_id       TEXT,
            customer_phone  TEXT,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );

          CREATE INDEX IF NOT EXISTS idx_meta_flow_token_map_flow_id
          ON meta_flow_token_map (flow_id);

          CREATE INDEX IF NOT EXISTS idx_meta_flow_token_map_survey_id
          ON meta_flow_token_map (survey_id);

          CREATE INDEX IF NOT EXISTS idx_meta_flow_token_map_phone
          ON meta_flow_token_map (customer_phone);
        `
      );

      await runMigration(
        client,
        '2026_06_meta_flow_accumulated',
        `
          CREATE TABLE IF NOT EXISTS meta_flow_accumulated (
            flow_token      TEXT PRIMARY KEY,
            flow_id         TEXT NOT NULL,
            survey_id       TEXT,
            customer_phone  TEXT,
            answers         JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );

          CREATE INDEX IF NOT EXISTS idx_meta_flow_accumulated_flow_id
          ON meta_flow_accumulated (flow_id);
        `
      );

    client.release();

    console.log('✅ Database initialized successfully!');
    console.log('   Tables: survey_sessions, survey_responses, escalations, meta_flow_surveys, meta_flow_responses');
  } catch (error) {
    console.error('❌ Database initialization failed:', error);
    process.exit(1);
  } 
  // finally {
  //   await pool.end();
  // }
}
