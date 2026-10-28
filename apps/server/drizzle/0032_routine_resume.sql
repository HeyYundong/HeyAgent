CREATE TABLE "routine_journal" (
	"session_id" text NOT NULL,
	"seq" integer NOT NULL,
	"op" text NOT NULL,
	"tool" text,
	"input_hash" text NOT NULL,
	"reply" jsonb,
	"stop" text,
	"instance_id" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "routine_journal_session_id_seq_pk" PRIMARY KEY("session_id","seq")
);
--> statement-breakpoint
ALTER TABLE "routine_versions" ADD COLUMN "auto" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "auto_solidify" boolean;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "routine_skip_test" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "routine_journal" ADD CONSTRAINT "routine_journal_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;