// Single source of truth: 29 event types → chip, human label, sentence.

export type EventChip =
  | 'Visits' | 'Refused' | 'Deploys' | 'Sharing'
  | 'People' | 'API keys' | 'Watchdog' | 'Admin' | 'Workspace';

export interface EventMeta {
  chip: EventChip;
  /** Short type word shown in the feed (e.g. "Visit", "Refused", "Deploy failed") */
  label: string;
  /** Colour token for the label (defaults to fg-2 if not set) */
  labelColor?: string; // e.g. "--orange", "--red"
  labelWeight?: number; // 500 for notable events
  /** Build a human sentence from the event */
  sentence: (e: ActivityEventFields) => string;
}

export interface ActivityEventFields {
  event_type: string;
  actor_email: string | null;
  actor_type: string;
  target_id: string | null;
  app_id: string | null;
  app_name: string | null;
  metadata: Record<string, unknown>;
}

function actor(e: ActivityEventFields): string {
  return e.actor_email ?? 'Someone';
}

function roleLabel(role: string): string {
  if (role === 'org:admin') return 'Admin';
  if (role === 'org:member') return 'Member';
  return role || 'Unknown role';
}

function appName(e: ActivityEventFields): string {
  if (typeof e.app_name === 'string' && e.app_name) return e.app_name;
  // legacy fallback: metadata.app_name (pre-enrichment responses)
  if (typeof e.metadata.app_name === 'string' && e.metadata.app_name) return e.metadata.app_name;
  // last resort: short id
  return e.app_id ? e.app_id.slice(0, 8) : 'an app';
}

export const EVENT_META: Record<string, EventMeta> = {
  'app.visit':               { chip: 'Visits',   label: 'Visit',       sentence: e => `${actor(e)} opened ${appName(e)}` },
  'access.refused':          { chip: 'Refused',  label: 'Refused',     labelColor: '--orange', labelWeight: 500, sentence: e => `${actor(e)} tried to open ${appName(e)}, not on the list` },
  'deploy.started':          { chip: 'Deploys',  label: 'Deploy',      sentence: e => `${actor(e)} started deploying ${appName(e)}` },
  'deploy.succeeded':        { chip: 'Deploys',  label: 'Deploy',      sentence: e => `${actor(e)} deployed ${appName(e)} successfully` },
  'deploy.failed':           { chip: 'Deploys',  label: 'Deploy failed', labelColor: '--red', labelWeight: 500, sentence: e => `${appName(e)} deploy failed` },
  'access.granted':          { chip: 'Sharing',  label: 'Sharing',     sentence: e => `${actor(e)} shared ${appName(e)} with ${e.target_id ?? 'someone'}` },
  'access.revoked':          { chip: 'Sharing',  label: 'Sharing',     sentence: e => `${actor(e)} removed ${e.target_id ?? 'someone'} from ${appName(e)}` },
  'access.pending_claimed':  { chip: 'Sharing',  label: 'Sharing',     sentence: e => `${actor(e)} claimed their invite to ${appName(e)}` },
  'email.invite_queued':     { chip: 'Sharing',  label: 'Sharing',     sentence: e => `Invite email queued for ${e.target_id ?? 'someone'} to ${appName(e)}` },
  'email.invite_sent':       { chip: 'Sharing',  label: 'Sharing',     sentence: e => `Invite email sent to ${e.target_id ?? 'someone'} for ${appName(e)}` },
  'email.invite_failed':     { chip: 'Sharing',  label: 'Email failed', labelColor: '--red', labelWeight: 500, sentence: e => `Invite email to ${e.target_id ?? 'someone'} for ${appName(e)} failed` },
  'user.signed_in':          { chip: 'People',   label: 'People',      sentence: e => `${actor(e)} signed in` },
  'clerk.user_created':      { chip: 'People',   label: 'People',      sentence: e => `${actor(e)} created an account` },
  'clerk.user_updated':      { chip: 'People',   label: 'People',      sentence: e => `${actor(e)} updated their account` },
  'clerk.user_deleted':      { chip: 'People',   label: 'People',      sentence: _e => 'An account was deleted' },
  'clerk.org_created':       { chip: 'People',   label: 'People',      sentence: _e => 'A workspace was created' },
  'clerk.org_updated':       { chip: 'People',   label: 'People',      sentence: _e => 'A workspace was updated' },
  'clerk.org_deleted':       { chip: 'People',   label: 'People',      sentence: _e => 'A workspace was deleted' },
  'clerk.membership_created':{ chip: 'People',   label: 'People',      sentence: e => `${actor(e)} joined a workspace` },
  'clerk.membership_updated':{ chip: 'People',   label: 'People',      sentence: _e => 'Workspace membership updated' },
  'clerk.membership_deleted':{ chip: 'People',   label: 'People',      sentence: e => `${actor(e)} left a workspace` },
  'key.created':             { chip: 'API keys', label: 'API key',     sentence: e => `${actor(e)} created key "${typeof e.metadata.name === 'string' ? e.metadata.name : (e.target_id ?? '')}"` },
  'key.revoked':             { chip: 'API keys', label: 'API key',     sentence: e => `${actor(e)} revoked an API key` },
  'key.auth_failed':         { chip: 'API keys', label: 'API key',     sentence: e => `Invalid API key attempt${typeof e.metadata.ip === 'string' ? ` from ${e.metadata.ip}` : ''}` },
  'app.suspended':           { chip: 'Watchdog', label: 'Watchdog',    sentence: e => `${appName(e)} was suspended` },
  'app.unsuspended':         { chip: 'Watchdog', label: 'Watchdog',    sentence: e => `${appName(e)} was unsuspended` },
  'watchdog.alert':          { chip: 'Watchdog', label: 'Watchdog',    labelColor: '--orange', labelWeight: 500, sentence: e => `Watchdog alert: ${typeof e.metadata.kind === 'string' ? e.metadata.kind : 'unknown'}` },
  'app.created':             { chip: 'Admin',    label: 'Admin',       sentence: e => `${actor(e)} created app ${appName(e)}` },
  'app.deleted':             { chip: 'Admin',    label: 'Admin',       sentence: e => `${actor(e)} deleted app ${appName(e)}` },
  'admin.activity_searched': { chip: 'Admin',    label: 'Admin',       sentence: e => `${actor(e)} searched activity` },
  'admin.activity_exported': { chip: 'Admin',    label: 'Admin',       sentence: e => `${actor(e)} exported the activity log` },
  'admin.person_erased':     { chip: 'Admin',    label: 'Admin',       sentence: e => `${actor(e)} erased a person` },
  'workspace.deleted':       { chip: 'Workspace', label: 'Workspace',  labelColor: '--red', labelWeight: 500, sentence: e => `${actor(e)} deleted the workspace` },
  'member.invited':            { chip: 'People',    label: 'People',      sentence: e => `${actor(e)} invited ${String(e.metadata.invitee_email ?? 'someone')} as ${roleLabel(String(e.metadata.role ?? ''))}` },
  'member.invitation_revoked': { chip: 'People',    label: 'People',      sentence: e => `${actor(e)} revoked invitation for ${String(e.metadata.invitee_email ?? 'someone')}` },
  'member.role_changed':       { chip: 'People',    label: 'People',      sentence: e => `${actor(e)} changed a member's role to ${roleLabel(String(e.metadata.new_role ?? ''))}` },
  'member.removed':            { chip: 'People',    label: 'People',      sentence: e => `${actor(e)} removed a member from the workspace` },
  'member.left':               { chip: 'People',    label: 'People',      sentence: e => `${actor(e)} left the workspace` },
};

export const CHIP_EVENT_TYPES: Record<EventChip, string[]> = {
  'Visits':   ['app.visit'],
  'Refused':  ['access.refused'],
  'Deploys':  ['deploy.started', 'deploy.succeeded', 'deploy.failed'],
  'Sharing':  ['access.granted', 'access.revoked', 'access.pending_claimed', 'email.invite_queued', 'email.invite_sent', 'email.invite_failed'],
  'People':   ['user.signed_in', 'clerk.user_created', 'clerk.user_updated', 'clerk.user_deleted', 'clerk.org_created', 'clerk.org_updated', 'clerk.org_deleted', 'clerk.membership_created', 'clerk.membership_updated', 'clerk.membership_deleted', 'member.invited', 'member.invitation_revoked', 'member.role_changed', 'member.removed', 'member.left'],
  'API keys': ['key.created', 'key.revoked', 'key.auth_failed'],
  'Watchdog': ['app.suspended', 'app.unsuspended', 'watchdog.alert'],
  'Admin':    ['app.created', 'app.deleted', 'admin.activity_searched', 'admin.activity_exported', 'admin.person_erased'],
  'Workspace': ['workspace.deleted'],
};

/** Simple UA → "Browser on Device" without any dependency */
export function simpleDevice(ua: string | null | undefined): string {
  if (!ua) return 'Unknown device';
  const browser =
    /Edg\//.test(ua) ? 'Edge' :
    /Chrome\//.test(ua) && !/Chromium/.test(ua) ? 'Chrome' :
    /Firefox\//.test(ua) ? 'Firefox' :
    /Safari\//.test(ua) ? 'Safari' :
    'Browser';
  const os =
    /iPhone/.test(ua) ? 'iPhone' :
    /iPad/.test(ua) ? 'iPad' :
    /Android/.test(ua) ? 'Android' :
    /Windows NT/.test(ua) ? 'Windows' :
    /Mac OS X/.test(ua) ? 'Mac' :
    /Linux/.test(ua) ? 'Linux' :
    'device';
  return `${browser} on ${os}`;
}
