-- 系统开的桌面（docs/dev/desktop-vm.md 第 4 节）：桌面分三种（manual / vm / template）、谁建的；虚拟机一台一行（desktop_vms）。
CREATE TABLE "desktop_vms" (
	"desktop_id" text PRIMARY KEY NOT NULL,
	"template_id" text,
	"storage_path" text NOT NULL,
	"dir" text NOT NULL,
	"container" text NOT NULL,
	"state" text NOT NULL,
	"desired" text NOT NULL,
	"op" text,
	"message" text,
	"state_since" timestamp with time zone DEFAULT now() NOT NULL,
	"installed_at" timestamp with time zone,
	"memory_gb" integer NOT NULL,
	"cpus" integer NOT NULL,
	"disk_gb" integer NOT NULL,
	"mcp_port" integer NOT NULL,
	"agent_port" integer NOT NULL,
	"vm_password_secret_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "desktop_vms_mcp_port_unique" UNIQUE("mcp_port"),
	CONSTRAINT "desktop_vms_agent_port_unique" UNIQUE("agent_port"),
	CONSTRAINT "desktop_vms_state_check" CHECK ("desktop_vms"."state" in ('creating', 'installing', 'starting', 'running', 'setup', 'ready', 'stopping', 'stopped', 'error', 'deleting')),
	CONSTRAINT "desktop_vms_desired_check" CHECK ("desktop_vms"."desired" in ('running', 'stopped')),
	CONSTRAINT "desktop_vms_op_check" CHECK ("desktop_vms"."op" is null or "desktop_vms"."op" in ('restart', 'reset', 'seal', 'delete'))
);
--> statement-breakpoint
ALTER TABLE "desktops" ADD COLUMN "kind" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "desktops" ADD COLUMN "created_by_id" text;--> statement-breakpoint
ALTER TABLE "desktop_vms" ADD CONSTRAINT "desktop_vms_desktop_id_desktops_id_fk" FOREIGN KEY ("desktop_id") REFERENCES "public"."desktops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desktop_vms" ADD CONSTRAINT "desktop_vms_template_id_desktops_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."desktops"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desktop_vms" ADD CONSTRAINT "desktop_vms_vm_password_secret_id_secrets_id_fk" FOREIGN KEY ("vm_password_secret_id") REFERENCES "public"."secrets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "desktop_vms_template_idx" ON "desktop_vms" USING btree ("template_id");--> statement-breakpoint
ALTER TABLE "desktops" ADD CONSTRAINT "desktops_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desktops" ADD CONSTRAINT "desktops_kind_check" CHECK ("desktops"."kind" in ('manual', 'vm', 'template'));--> statement-breakpoint
CREATE TRIGGER desktop_vms_notify_change AFTER INSERT OR UPDATE OR DELETE ON "desktop_vms" FOR EACH ROW EXECUTE FUNCTION heyagent_notify_change('desktop_id');
