export type UserRole = "admin" | "member";

export type UserRecord = {
  _id?: unknown;
  email: string;
  passwordHash: string;
  name?: string | null;
  role: UserRole;
  createdAt: Date;
  updatedAt: Date;
};

export type PreferenceRecord = {
  _id?: unknown;
  userId: string;
  title: string;
  enabled: boolean;
  locations: string[];
  boardDomains: string[];
  keywordSeed: string[];
  searchAfterDays: number;
  generatedKeywords: string[];
  searchQueries: string[];
  contextBlock: string;
  timezone: string;
  scheduleHourLocal: number;
  createdAt: Date;
  updatedAt: Date;
};

export type AssetRecord = {
  _id?: unknown;
  userId: string;
  kind: "resume_pdf" | "cover_letter_docx";
  filename: string;
  mimeType: string;
  byteLength: number;
  storagePath: string;
  extractedText?: string;
  createdAt: Date;
};

export type FieldAnswer = {
  key: string;
  label: string;
  type: string;
  required: boolean;
  options: string[];
  answer: string;
  reasoning: string;
};

export type JobRecord = {
  _id?: unknown;
  userId: string;
  preferenceId: string;
  digestDate: string;
  sourceUrl: string;
  sourceHost: string;
  sourceTitle: string;
  company: string;
  location: string;
  compensationRange?: string | null;
  companyHomepage?: string | null;
  linkedinLinks: string[];
  hiringContacts: string[];
  summary: string;
  listingText: string;
  applyUrl: string;
  appliedApplicationUrl?: string | null;
  appliedAtHiringContacts?: string[];
  appliedAtLinkedinLinks?: string[];
  fields: FieldAnswer[];
  resumeAssetId?: string | null;
  coverLetterAssetId?: string | null;
  status: "new" | "reviewed" | "applied" | "archived" | "dismissed";
  discoveredAt: Date;
  appliedAt?: Date | null;
  archivedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type DigestRecord = {
  _id?: unknown;
  userId: string;
  date: string;
  jobIds: string[];
  sentAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type SearchCandidate = {
  sourceUrl: string;
  sourceTitle: string;
  sourceHost: string;
  company: string;
  location: string;
  snippet: string;
};

export type ParsedJobPage = {
  title: string;
  company: string;
  location: string;
  summary: string;
  listingText: string;
  applyUrl: string;
  compensationRange?: string | null;
  companyHomepage?: string | null;
  linkedinLinks?: string[];
  hiringContacts?: string[];
  fields: Array<{
    key: string;
    label: string;
    type: string;
    required: boolean;
    options: string[];
  }>;
};

export type NotificationPayload = {
  title: string;
  digestUrl: string;
  date: string;
  count: number;
};
