CREATE TYPE "public"."account_status" AS ENUM('ok', 'expired', 'captcha');--> statement-breakpoint
CREATE TYPE "public"."checkpoint_kind" AS ENUM('visit', 'message', 'count', 'artifact', 'confirm', 'note');--> statement-breakpoint
CREATE TYPE "public"."checkpoint_status" AS ENUM('done', 'open', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."human_item_kind" AS ENUM('approval', 'verify', 'login', 'memory', 'skill');--> statement-breakpoint
CREATE TYPE "public"."human_item_status" AS ENUM('open', 'resolved', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."mcp_status" AS ENUM('connected', 'error');--> statement-breakpoint
CREATE TYPE "public"."mcp_transport" AS ENUM('stdio', 'http');--> statement-breakpoint
CREATE TYPE "public"."memory_evidence" AS ENUM('chat', 'web', 'result');--> statement-breakpoint
CREATE TYPE "public"."memory_source_kind" AS ENUM('human', 'agent');--> statement-breakpoint
CREATE TYPE "public"."memory_status" AS ENUM('active', 'pending', 'rejected', 'archived');--> statement-breakpoint
CREATE TYPE "public"."model_role" AS ENUM('run', 'plan', 'verify');--> statement-breakpoint
CREATE TYPE "public"."provider_kind" AS ENUM('ollama', 'openrouter');--> statement-breakpoint
CREATE TYPE "public"."provider_status" AS ENUM('ok', 'error', 'unconfigured');--> statement-breakpoint
CREATE TYPE "public"."proxy_kind" AS ENUM('none', 'socks5');--> statement-breakpoint
CREATE TYPE "public"."risk" AS ENUM('read', 'write', 'external', 'money');--> statement-breakpoint
CREATE TYPE "public"."run_event_kind" AS ENUM('plan', 'think', 'tool', 'checkpoint', 'rule', 'wait', 'resume', 'human', 'verify', 'done', 'error');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('running', 'needs_human', 'waiting', 'verifying', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."secret_scope" AS ENUM('http_tool', 'mcp_env', 'model_provider', 'browser_proxy');--> statement-breakpoint
CREATE TYPE "public"."skill_status" AS ENUM('published', 'draft', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."suggestion_status" AS ENUM('pending', 'accepted', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."todo_status" AS ENUM('active', 'done', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."tool_source" AS ENUM('builtin', 'mcp', 'http');--> statement-breakpoint
CREATE TYPE "public"."trigger_kind" AS ENUM('time', 'cron', 'event', 'time_or_event');--> statement-breakpoint
CREATE TYPE "public"."wait_status" AS ENUM('waiting', 'fired', 'cancelled');--> statement-breakpoint
CREATE SEQUENCE "public"."human_item_no_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE SEQUENCE "public"."memory_no_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE SEQUENCE "public"."rule_no_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE SEQUENCE "public"."skill_no_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE SEQUENCE "public"."task_no_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE SEQUENCE "public"."todo_no_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "account_leases" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "account_leases_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"account_id" text NOT NULL,
	"session_id" text NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "auth_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"impersonated_by" text,
	CONSTRAINT "auth_sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "auth_verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "browser_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"profile_id" text NOT NULL,
	"platform_id" text NOT NULL,
	"account" text NOT NULL,
	"status" "account_status" NOT NULL,
	"last_login_at" timestamp with time zone,
	"logged_in_by_id" text,
	"max_concurrent" integer DEFAULT 1 NOT NULL,
	"probe_url" text,
	"save_indexed_db" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "browser_accounts_profile_platform_account_key" UNIQUE("profile_id","platform_id","account"),
	CONSTRAINT "browser_accounts_max_concurrent_check" CHECK ("browser_accounts"."max_concurrent" >= 1)
);
--> statement-breakpoint
CREATE TABLE "browser_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"proxy_kind" "proxy_kind" DEFAULT 'none' NOT NULL,
	"proxy_host" text,
	"proxy_port" integer,
	"proxy_username" text,
	"proxy_password_secret_id" text,
	"exit_ip" text DEFAULT '' NOT NULL,
	"timezone" text,
	"locale" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "browser_profiles_proxy_check" CHECK ("browser_profiles"."proxy_kind" = 'none' or ("browser_profiles"."proxy_host" is not null and "browser_profiles"."proxy_port" is not null))
);
--> statement-breakpoint
CREATE TABLE "browser_vaults" (
	"profile_id" text PRIMARY KEY NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"enc" jsonb NOT NULL,
	"cookie_count" integer DEFAULT 0 NOT NULL,
	"updated_by_session_id" text,
	"updated_by_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "checkpoint_records" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "checkpoint_records_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"checkpoint_id" bigint NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"text" text NOT NULL,
	"synced" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "checkpoints" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "checkpoints_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"session_id" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"title" text NOT NULL,
	"kind" "checkpoint_kind" NOT NULL,
	"target" integer,
	"step_id" text,
	"status" "checkpoint_status" DEFAULT 'open' NOT NULL,
	"progress" integer,
	"skip_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "checkpoints_session_position_key" UNIQUE("session_id","position")
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"mime" text NOT NULL,
	"size" bigint NOT NULL,
	"storage_path" text NOT NULL,
	"sha256" text NOT NULL,
	"created_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "human_items" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" "human_item_kind" NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"assignee_id" text NOT NULL,
	"task_id" text,
	"session_id" text,
	"rule_id" text,
	"memory_id" text,
	"skill_id" text,
	"urgency" integer DEFAULT 4 NOT NULL,
	"detail" jsonb NOT NULL,
	"status" "human_item_status" DEFAULT 'open' NOT NULL,
	"resolution" jsonb,
	"resolved_by_id" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "human_todos" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"title" text NOT NULL,
	"trigger_kind" "trigger_kind" NOT NULL,
	"at" timestamp with time zone,
	"cron" text,
	"cron_text" text,
	"next_at" timestamp with time zone,
	"event" text,
	"fallback_days" integer,
	"status" "todo_status" DEFAULT 'active' NOT NULL,
	"created_by_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_servers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"transport" "mcp_transport" NOT NULL,
	"command" text,
	"url" text,
	"status" "mcp_status" NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"env_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_servers_transport_check" CHECK (("mcp_servers"."transport" = 'stdio' and "mcp_servers"."command" is not null) or ("mcp_servers"."transport" = 'http' and "mcp_servers"."url" is not null))
);
--> statement-breakpoint
CREATE TABLE "memories" (
	"id" text PRIMARY KEY NOT NULL,
	"content" text NOT NULL,
	"applies_to" text NOT NULL,
	"status" "memory_status" NOT NULL,
	"source_kind" "memory_source_kind" NOT NULL,
	"source_by_id" text,
	"source_task_id" text,
	"source_session_id" text,
	"source_evidence" "memory_evidence",
	"reviewer_id" text,
	"web_unverified" boolean DEFAULT false NOT NULL,
	"evidence" text,
	"last_used_at" timestamp with time zone,
	"last_used_session_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memories_source_check" CHECK (("memories"."source_kind" = 'human' and "memories"."source_by_id" is not null) or ("memories"."source_kind" = 'agent' and "memories"."source_task_id" is not null and "memories"."source_evidence" is not null))
);
--> statement-breakpoint
CREATE TABLE "model_defaults" (
	"role" "model_role" PRIMARY KEY NOT NULL,
	"model_id" text NOT NULL,
	"updated_by_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_providers" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" "provider_kind" NOT NULL,
	"name" text NOT NULL,
	"base_url" text DEFAULT '' NOT NULL,
	"api_key_secret_id" text,
	"status" "provider_status" NOT NULL,
	"checked_at" timestamp with time zone,
	"latency_ms" integer,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "models" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"name" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"context_k" integer NOT NULL,
	"price_in" numeric(12, 4) DEFAULT 0 NOT NULL,
	"price_out" numeric(12, 4) DEFAULT 0 NOT NULL,
	"vision" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platforms" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rule_tools" (
	"rule_id" text NOT NULL,
	"tool_id" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "rule_tools_rule_id_tool_id_pk" PRIMARY KEY("rule_id","tool_id")
);
--> statement-breakpoint
CREATE TABLE "rules" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"trigger" text NOT NULL,
	"action" text NOT NULL,
	"compiled_trigger" jsonb,
	"created_by_id" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "secrets" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" "secret_scope" NOT NULL,
	"ref_id" text,
	"name" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"enc" jsonb NOT NULL,
	"masked" text NOT NULL,
	"created_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "secrets_scope_ref_name_key" UNIQUE NULLS NOT DISTINCT("scope","ref_id","name")
);
--> statement-breakpoint
CREATE TABLE "session_events" (
	"session_id" text NOT NULL,
	"seq" integer NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"kind" "run_event_kind" NOT NULL,
	"title" text NOT NULL,
	"detail" text,
	"tool_id" text,
	"input" text,
	"output" text,
	"ms" integer,
	"tokens_in" integer,
	"tokens_out" integer,
	CONSTRAINT "session_events_session_id_seq_pk" PRIMARY KEY("session_id","seq")
);
--> statement-breakpoint
CREATE TABLE "session_messages" (
	"session_id" text NOT NULL,
	"seq" integer NOT NULL,
	"role" text NOT NULL,
	"content" jsonb NOT NULL,
	"compacted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_messages_session_id_seq_pk" PRIMARY KEY("session_id","seq")
);
--> statement-breakpoint
CREATE TABLE "session_waits" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "session_waits_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"session_id" text NOT NULL,
	"what" text NOT NULL,
	"trigger_kind" "trigger_kind" NOT NULL,
	"resume_at" timestamp with time zone,
	"event" text,
	"match" jsonb,
	"cron" text,
	"cron_text" text,
	"fallback_days" integer,
	"deadline_at" timestamp with time zone,
	"status" "wait_status" DEFAULT 'waiting' NOT NULL,
	"fired_cause" text,
	"fired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"parent_session_id" text,
	"status" "run_status" NOT NULL,
	"model_id" text NOT NULL,
	"triggered_by" text,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"tokens_in" bigint DEFAULT 0 NOT NULL,
	"tokens_out" bigint DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"explored_steps" jsonb,
	"verification" jsonb,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_suggestions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "skill_suggestions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"skill_id" text NOT NULL,
	"task_id" text,
	"session_id" text,
	"summary" text NOT NULL,
	"diff" jsonb,
	"reviewer_id" text NOT NULL,
	"status" "suggestion_status" DEFAULT 'pending' NOT NULL,
	"human_item_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "skill_tools" (
	"skill_id" text NOT NULL,
	"tool_id" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "skill_tools_skill_id_tool_id_pk" PRIMARY KEY("skill_id","tool_id")
);
--> statement-breakpoint
CREATE TABLE "skill_versions" (
	"skill_id" text NOT NULL,
	"version" integer NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"body" text NOT NULL,
	"tool_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_versions_skill_id_version_pk" PRIMARY KEY("skill_id","version")
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"dept" text NOT NULL,
	"status" "skill_status" NOT NULL,
	"owner_id" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"body" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_memories" (
	"task_id" text NOT NULL,
	"memory_id" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "task_memories_task_id_memory_id_pk" PRIMARY KEY("task_id","memory_id")
);
--> statement-breakpoint
CREATE TABLE "task_rules" (
	"task_id" text NOT NULL,
	"rule_id" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "task_rules_task_id_rule_id_pk" PRIMARY KEY("task_id","rule_id")
);
--> statement-breakpoint
CREATE TABLE "task_skills" (
	"task_id" text NOT NULL,
	"skill_id" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "task_skills_task_id_skill_id_pk" PRIMARY KEY("task_id","skill_id")
);
--> statement-breakpoint
CREATE TABLE "task_tools" (
	"task_id" text NOT NULL,
	"tool_id" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "task_tools_task_id_tool_id_pk" PRIMARY KEY("task_id","tool_id")
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"goal" text NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"owner_id" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"schedule_cron" text,
	"schedule_text" text,
	"next_run_at" timestamp with time zone,
	"model_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_schedule_check" CHECK (("tasks"."schedule_cron" is null) = ("tasks"."schedule_text" is null))
);
--> statement-breakpoint
CREATE TABLE "tools" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"summary" text NOT NULL,
	"description" text NOT NULL,
	"source" "tool_source" NOT NULL,
	"server_id" text,
	"http" jsonb,
	"risk" "risk" NOT NULL,
	"always_on" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tools_source_check" CHECK (("tools"."source" <> 'mcp' or "tools"."server_id" is not null) and ("tools"."source" <> 'http' or "tools"."http" is not null))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"role" text,
	"banned" boolean DEFAULT false,
	"ban_reason" text,
	"ban_expires" timestamp with time zone,
	"title" text DEFAULT '' NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "account_leases" ADD CONSTRAINT "account_leases_account_id_browser_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."browser_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_leases" ADD CONSTRAINT "account_leases_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_accounts" ADD CONSTRAINT "auth_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_accounts" ADD CONSTRAINT "browser_accounts_profile_id_browser_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."browser_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_accounts" ADD CONSTRAINT "browser_accounts_platform_id_platforms_id_fk" FOREIGN KEY ("platform_id") REFERENCES "public"."platforms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_accounts" ADD CONSTRAINT "browser_accounts_logged_in_by_id_users_id_fk" FOREIGN KEY ("logged_in_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_profiles" ADD CONSTRAINT "browser_profiles_proxy_password_secret_id_secrets_id_fk" FOREIGN KEY ("proxy_password_secret_id") REFERENCES "public"."secrets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_vaults" ADD CONSTRAINT "browser_vaults_profile_id_browser_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."browser_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_vaults" ADD CONSTRAINT "browser_vaults_updated_by_session_id_sessions_id_fk" FOREIGN KEY ("updated_by_session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_vaults" ADD CONSTRAINT "browser_vaults_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkpoint_records" ADD CONSTRAINT "checkpoint_records_checkpoint_id_checkpoints_id_fk" FOREIGN KEY ("checkpoint_id") REFERENCES "public"."checkpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoints_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_items" ADD CONSTRAINT "human_items_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_items" ADD CONSTRAINT "human_items_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_items" ADD CONSTRAINT "human_items_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_items" ADD CONSTRAINT "human_items_rule_id_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_items" ADD CONSTRAINT "human_items_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_items" ADD CONSTRAINT "human_items_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_items" ADD CONSTRAINT "human_items_resolved_by_id_users_id_fk" FOREIGN KEY ("resolved_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_todos" ADD CONSTRAINT "human_todos_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_todos" ADD CONSTRAINT "human_todos_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_source_by_id_users_id_fk" FOREIGN KEY ("source_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_source_session_id_sessions_id_fk" FOREIGN KEY ("source_session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_last_used_session_id_sessions_id_fk" FOREIGN KEY ("last_used_session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_defaults" ADD CONSTRAINT "model_defaults_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_defaults" ADD CONSTRAINT "model_defaults_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_providers" ADD CONSTRAINT "model_providers_api_key_secret_id_secrets_id_fk" FOREIGN KEY ("api_key_secret_id") REFERENCES "public"."secrets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "models" ADD CONSTRAINT "models_provider_id_model_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."model_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule_tools" ADD CONSTRAINT "rule_tools_rule_id_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule_tools" ADD CONSTRAINT "rule_tools_tool_id_tools_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."tools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_events" ADD CONSTRAINT "session_events_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_messages" ADD CONSTRAINT "session_messages_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_waits" ADD CONSTRAINT "session_waits_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_parent_session_id_sessions_id_fk" FOREIGN KEY ("parent_session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_suggestions" ADD CONSTRAINT "skill_suggestions_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_suggestions" ADD CONSTRAINT "skill_suggestions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_suggestions" ADD CONSTRAINT "skill_suggestions_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_suggestions" ADD CONSTRAINT "skill_suggestions_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_suggestions" ADD CONSTRAINT "skill_suggestions_human_item_id_human_items_id_fk" FOREIGN KEY ("human_item_id") REFERENCES "public"."human_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_tools" ADD CONSTRAINT "skill_tools_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_tools" ADD CONSTRAINT "skill_tools_tool_id_tools_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."tools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_memories" ADD CONSTRAINT "task_memories_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_memories" ADD CONSTRAINT "task_memories_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_rules" ADD CONSTRAINT "task_rules_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_rules" ADD CONSTRAINT "task_rules_rule_id_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_skills" ADD CONSTRAINT "task_skills_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_skills" ADD CONSTRAINT "task_skills_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_tools" ADD CONSTRAINT "task_tools_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_tools" ADD CONSTRAINT "task_tools_tool_id_tools_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."tools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tools" ADD CONSTRAINT "tools_server_id_mcp_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_leases_active_idx" ON "account_leases" USING btree ("account_id") WHERE "account_leases"."released_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "account_leases_one_active_idx" ON "account_leases" USING btree ("account_id","session_id") WHERE "account_leases"."released_at" is null;--> statement-breakpoint
CREATE INDEX "auth_accounts_user_id_idx" ON "auth_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_sessions_user_id_idx" ON "auth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_verifications_identifier_idx" ON "auth_verifications" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "checkpoint_records_checkpoint_id_idx" ON "checkpoint_records" USING btree ("checkpoint_id");--> statement-breakpoint
CREATE INDEX "files_session_id_idx" ON "files" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "human_items_status_assignee_idx" ON "human_items" USING btree ("status","assignee_id");--> statement-breakpoint
CREATE INDEX "human_items_session_id_idx" ON "human_items" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "models_provider_id_idx" ON "models" USING btree ("provider_id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_waits_one_waiting_idx" ON "session_waits" USING btree ("session_id") WHERE "session_waits"."status" = 'waiting';--> statement-breakpoint
CREATE INDEX "session_waits_resume_at_idx" ON "session_waits" USING btree ("resume_at") WHERE "session_waits"."status" = 'waiting';--> statement-breakpoint
CREATE INDEX "sessions_task_id_started_at_idx" ON "sessions" USING btree ("task_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "sessions_status_idx" ON "sessions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sessions_parent_session_id_idx" ON "sessions" USING btree ("parent_session_id");--> statement-breakpoint
CREATE INDEX "task_memories_memory_id_idx" ON "task_memories" USING btree ("memory_id");--> statement-breakpoint
CREATE INDEX "task_rules_rule_id_idx" ON "task_rules" USING btree ("rule_id");--> statement-breakpoint
CREATE INDEX "task_skills_skill_id_idx" ON "task_skills" USING btree ("skill_id");--> statement-breakpoint
CREATE INDEX "task_tools_tool_id_idx" ON "task_tools" USING btree ("tool_id");--> statement-breakpoint
CREATE INDEX "tasks_owner_id_idx" ON "tasks" USING btree ("owner_id");