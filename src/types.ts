// Standby: shared types.
//
// Two households. Each links its own Amazon account, on its own Echo, through its own
// Alexa app. Standby never learns who is speaking: it only knows which linked account
// the request arrived on, which is all the Alexa+ MCP Toolkit gives you
// (Supported Capabilities lists Authentication and Account Linking, and nothing else).
// That is why "household" and "account" are separate here, and why every capability
// decision is written in terms of the account the request came in on.

export type HouseholdId = string;
export type AccountId = string;

export interface Household {
  id: HouseholdId;
  name: string;
  timezone: string;
  /** Free-text label only. Standby never stores a postal address. */
  areaLabel: string;
}

export interface Account {
  id: AccountId;
  /** Opaque identifier from account linking. Never an email, never a name. */
  linkedSubject: string;
  displayName: string;
  householdId: HouseholdId;
  /** Written channel for this account. Policy Requirement 15 mandates one. */
  email: string;
  sms: string | null;
}

/**
 * Service categories Standby will act in. Health is absent on purpose and cannot be
 * added by configuration: see `screening.ts`.
 */
export const CATEGORIES = [
  'plumbing',
  'heating',
  'electrical',
  'appliance_repair',
  'gardening',
  'cleaning',
  'pest_control',
  'locksmith',
  'delivery',
  'window_cleaning',
  'gutters',
  'chimney',
] as const;
export type Category = (typeof CATEGORIES)[number];

export type GrantStatus = 'proposed' | 'active' | 'paused' | 'revoked' | 'expired';

/** What one account may do inside another household, and on what terms. */
export interface Grant {
  id: string;
  /** The account that will act. The adult child. */
  delegateAccount: AccountId;
  /** The household acted upon. The older relative's. */
  subjectHousehold: HouseholdId;
  /** The account inside that household that accepted. Needed for the consent record. */
  subjectAccount: AccountId;
  status: GrantStatus;
  categories: Category[];
  /** Hard ceiling on a single booking, in cents. */
  spendCapCents: number;
  /** A visit cannot be put in the diary with less than this much warning. */
  noticeHours: number;
  /** No visit may start before or after these hours, local to the subject household. */
  earliestHour: number;
  latestHour: number;
  mayBook: boolean;
  mayReschedule: boolean;
  mayCancel: boolean;
  proposedAt: string;
  acceptedAt: string | null;
  /** How the subject accepted: on their own speaker, or by tapping in the console. */
  acceptedVia: 'voice' | 'touch' | null;
  expiresAt: string;
  /** Six characters, spoken or typed at the subject's end. Cleared once accepted. */
  pairingCode: string | null;
  revokedAt: string | null;
  revokedBy: AccountId | null;
}

export type VisitStatus =
  /** Somebody asked for this. Nobody has agreed to pay for it yet. */
  | 'proposed'
  | 'booked'
  | 'rescheduled'
  | 'cancelled'
  | 'completed'
  /** Arranged by the delegate on terms that need someone at home to agree. */
  | 'awaiting_subject';

export interface Provider {
  id: string;
  name: string;
  category: Category;
  phone: string;
  /** Read back by voice before a cancellation. Policy Requirement 15. */
  cancellationPolicy: string;
  cancellationFeeCents: number;
  /** Hours of notice below which the provider charges the cancellation fee. */
  freeCancelHours: number;
  ratePerVisitCents: number;
}

export interface Visit {
  id: string;
  householdId: HouseholdId;
  providerId: string;
  category: Category;
  /** What is being done, in the household's own words. Screened on the way in. */
  summary: string;
  startsAt: string;
  endsAt: string;
  status: VisitStatus;
  priceCents: number;
  reference: string;
  arrangedBy: AccountId;
  arrangedAt: string;
  /** Set when a visit moved, so the ledger and the speaker can both say so. */
  previousStartsAt: string | null;
}

export type ChangeKind = 'reschedule' | 'cancel' | 'new_visit';
export type ChangeStatus =
  | 'offered'
  | 'applied'
  | 'held_for_delegate'
  | 'declined'
  | 'expired';

/**
 * A change the subject household asked for on their own speaker, or one the delegate
 * proposed that the grant does not cover outright.
 */
export interface ChangeRequest {
  id: string;
  visitId: string;
  kind: ChangeKind;
  requestedBy: AccountId;
  requestedAt: string;
  status: ChangeStatus;
  /** Slots Standby offered in the same turn. Deterministic, never model-generated. */
  offeredSlots: string[];
  chosenSlot: string | null;
  /** Why the capability engine held it, in the engine's own words. */
  holdReason: string | null;
  /** Written by Bedrock, off the voice path, for the delegate to act on. */
  adjudication: Adjudication | null;
  decidedBy: AccountId | null;
  decidedAt: string | null;
}

export interface Adjudication {
  recommendation: 'approve' | 'decline' | 'ask_the_household';
  headline: string;
  reasons: string[];
  risks: string[];
  /** True when the rule engine wrote this because Bedrock was unreachable. */
  fromFallback: boolean;
  model: string | null;
  latencyMs: number;
}

export type Surface = 'voice' | 'touch' | 'system';

export interface AuditEntry {
  id: string;
  at: string;
  householdId: HouseholdId;
  actor: AccountId | 'system';
  surface: Surface;
  action: string;
  subject: string;
  /** The capability code the engine returned. Present on every acting entry. */
  capability: string | null;
  reason: string;
  detail: Record<string, unknown>;
}

export type OutboxChannel = 'email' | 'sms';
export type OutboxStatus = 'queued' | 'sent' | 'failed';

export interface OutboxMessage {
  id: string;
  at: string;
  channel: OutboxChannel;
  to: string;
  subject: string;
  body: string;
  status: OutboxStatus;
  attempts: number;
  lastError: string | null;
  relatedVisit: string | null;
  kind: string;
}

/** Everything a tool handler is allowed to know about the caller. */
export interface CallerContext {
  account: Account;
  household: Household;
  surface: Surface;
}
