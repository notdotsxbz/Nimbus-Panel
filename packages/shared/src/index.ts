/**
 * @nimbus/shared — types, enums and contracts shared across
 * apps/web, apps/api, apps/node-agent and service modules.
 */

export type Role = "owner" | "admin" | "staff" | "customer";

export const STAFF_ROLES: Role[] = ["owner", "admin", "staff"];
export const isStaff = (role: Role) => STAFF_ROLES.includes(role);

export type ServiceType =
  | "minecraft"
  | "discord"
  | "website"
  | "backend"
  | "nodejs"
  | "python"
  | "vps"
  | "vds"
  | "mongodb"
  | "database"
  | "docker"
  | "custom";

export type ServiceStatus =
  | "online"
  | "offline"
  | "starting"
  | "stopping"
  | "restarting"
  | "installing"
  | "updating"
  | "suspended"
  | "error";

export const ACTIVE_STATUSES: ServiceStatus[] = ["online", "starting", "restarting", "updating"];

export type PowerAction = "start" | "stop" | "restart" | "reinstall" | "kill";

/** Port allocation range, configurable in Admin → Network. */
export const DEFAULT_PORT_RANGE: readonly [number, number] = [4001, 4050];

export type Protocol = "tcp" | "udp";

export interface Allocation {
  nodeId: string;
  ip: string;
  port: number;
  protocol: Protocol;
  serviceId?: string;
  reserved?: boolean;
}

/** Connection details shown on a customer service card. */
export interface ConnectionDetails {
  domain?: string;
  ip?: string;
  port?: number;
  protocol?: Protocol;
}

export type DomainScope = "panel" | "hosting";
export type DomainVerification = "pending" | "verified" | "failed";

export interface DomainRecord {
  hostname: string;
  scope: DomainScope;
  ownerId?: string;
  serviceId?: string;
  verification: DomainVerification;
  verificationToken?: string;
  ssl?: { status: "pending" | "issued" | "failed"; expiresAt?: string };
}

export type BackupStatus = "pending" | "running" | "completed" | "failed";
export type BackupDestination = "gdrive" | "s3" | "local";

export interface BackupJob {
  serviceId: string;
  destination: BackupDestination;
  status: BackupStatus;
  sizeBytes?: number;
  checksum?: string;
  createdAt: string;
}

export interface NodeHeartbeat {
  nodeId: string;
  cpuPercent: number;
  ramUsedBytes: number;
  ramTotalBytes: number;
  diskUsedBytes: number;
  diskTotalBytes: number;
  containersRunning: number;
  uptimeSeconds: number;
  agentVersion: string;
  at: string;
}

export interface CapacitySummary {
  nodeId: string;
  ramAllocatedMb: number;
  ramTotalMb: number;
  diskAllocatedGb: number;
  diskTotalGb: number;
  portsAvailable: number;
  healthy: boolean;
}

export interface ApiError {
  statusCode: number;
  message: string;
  error?: string;
}

/** Subdomain naming pattern per service type, e.g. "play-{username}". */
export const SUBDOMAIN_PATTERNS: Record<string, string> = {
  minecraft: "play-{username}",
  website: "{username}",
  backend: "api-{username}",
  discord: "bot-{username}",
};

export const buildSubdomain = (
  type: keyof typeof SUBDOMAIN_PATTERNS | string,
  username: string,
  hostingDomain: string,
): string => {
  const pattern = SUBDOMAIN_PATTERNS[type] ?? "{username}";
  return `${pattern.replace("{username}", username.toLowerCase())}.${hostingDomain}`;
};

/** Valid power-state transitions enforced by the API before sending commands. */
export const POWER_TRANSITIONS: Record<ServiceStatus, PowerAction[]> = {
  offline: ["start", "reinstall"],
  online: ["stop", "restart", "reinstall"],
  starting: ["stop"],
  stopping: ["start"],
  restarting: [],
  installing: [],
  updating: [],
  suspended: [],
  error: ["start", "stop", "reinstall"],
};

export const canTransition = (status: ServiceStatus, action: PowerAction): boolean =>
  (POWER_TRANSITIONS[status] ?? []).includes(action);

export * from "./appearance";
