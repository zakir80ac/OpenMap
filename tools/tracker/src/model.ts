// REQ-CORE-007 — tracker domain model and workbook column definitions (CLAUDE.md §3).
import { z } from 'zod';
import { PRIORITIES, REQ_ID_PATTERN, REQ_STATUSES, TEST_TYPES, WORKSTREAMS } from '@openmap/constants';

export const requirementSchema = z.object({
  id: z.string().regex(REQ_ID_PATTERN),
  workstream: z.enum(WORKSTREAMS),
  capabilityArea: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  acceptanceCriteria: z.string().min(1),
  priority: z.enum(PRIORITIES),
  status: z.enum(REQ_STATUSES),
  owner: z.string(),
  dependsOn: z.array(z.string()),
  specSection: z.string(),
  testIds: z.array(z.string()),
  evidence: z.string(),
  created: z.string(),
  updated: z.string(),
  notes: z.string(),
});
export type Requirement = z.infer<typeof requirementSchema>;

export const REQUIREMENT_COLUMNS: Array<{ key: keyof Requirement; header: string; width: number }> = [
  { key: 'id', header: 'ID', width: 16 },
  { key: 'workstream', header: 'Workstream', width: 12 },
  { key: 'capabilityArea', header: 'Capability area', width: 28 },
  { key: 'title', header: 'Title', width: 48 },
  { key: 'description', header: 'Description', width: 60 },
  { key: 'acceptanceCriteria', header: 'Acceptance criteria', width: 60 },
  { key: 'priority', header: 'Priority', width: 9 },
  { key: 'status', header: 'Status', width: 14 },
  { key: 'owner', header: 'Owner', width: 14 },
  { key: 'dependsOn', header: 'Depends on', width: 24 },
  { key: 'specSection', header: 'Spec section', width: 28 },
  { key: 'testIds', header: 'Test IDs', width: 18 },
  { key: 'evidence', header: 'Evidence', width: 40 },
  { key: 'created', header: 'Created', width: 12 },
  { key: 'updated', header: 'Updated', width: 12 },
  { key: 'notes', header: 'Notes', width: 40 },
];

export const componentSchema = z.object({
  name: z.string().min(1),
  layer: z.string().min(1),
  versionPinned: z.string().min(1),
  licence: z.string().min(1),
  runsAs: z.enum(['library', 'subprocess', 'service']),
  airGapReady: z.enum(['Y', 'N']),
  replacedByOption: z.string(),
});
export type Component = z.infer<typeof componentSchema>;

export const contractRowSchema = z.object({
  name: z.string().min(1),
  file: z.string().min(1),
  version: z.string().min(1),
  frozenOn: z.string(),
  lastAdr: z.string(),
});
export type ContractRow = z.infer<typeof contractRowSchema>;

export const decisionSchema = z.object({
  adr: z.string().min(1),
  title: z.string().min(1),
  status: z.enum(['Proposed', 'Accepted', 'Superseded', 'Rejected']),
  date: z.string(),
  link: z.string(),
});
export type Decision = z.infer<typeof decisionSchema>;

export const riskSchema = z.object({
  id: z.string().min(1),
  risk: z.string().min(1),
  likelihood: z.enum(['Low', 'Medium', 'High']),
  impact: z.enum(['Low', 'Medium', 'High']),
  mitigation: z.string(),
  owner: z.string(),
  status: z.enum(['Open', 'Mitigating', 'Closed']),
});
export type Risk = z.infer<typeof riskSchema>;

export const testRowSchema = z.object({
  id: z.string().min(1),
  type: z.enum(TEST_TYPES),
  covers: z.array(z.string()),
  lastRun: z.string(),
  result: z.enum(['Pass', 'Fail', 'Not run']),
  durationMs: z.number().int().min(0),
});
export type TestRow = z.infer<typeof testRowSchema>;

export const sessionSchema = z.object({
  date: z.string(),
  summary: z.string().min(1),
  reqsTouched: z.array(z.string()),
  commits: z.array(z.string()),
  blockers: z.string(),
});
export type Session = z.infer<typeof sessionSchema>;

export interface TrackerData {
  requirements: Requirement[];
  components: Component[];
  contracts: ContractRow[];
  decisions: Decision[];
  risks: Risk[];
  tests: TestRow[];
  sessions: Session[];
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}
