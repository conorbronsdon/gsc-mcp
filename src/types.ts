// Response shapes for the Google Search Console API (Webmasters v3 + URL
// Inspection v1). Only fields this server reads are typed; unknown extra fields
// are ignored. Docs: https://developers.google.com/webmaster-tools/v1

export interface SiteEntry {
  siteUrl: string;
  permissionLevel?: string;
}

export interface SitesListResponse {
  siteEntry?: SiteEntry[];
}

export interface SearchAnalyticsRow {
  keys?: string[];
  clicks?: number;
  impressions?: number;
  ctr?: number;
  position?: number;
}

export interface SearchAnalyticsResponse {
  rows?: SearchAnalyticsRow[];
  responseAggregationType?: string;
}

export interface SitemapResource {
  path?: string;
  lastSubmitted?: string;
  isPending?: boolean;
  isSitemapsIndex?: boolean;
  type?: string;
  lastDownloaded?: string;
  warnings?: string | number;
  errors?: string | number;
  contents?: {
    type?: string;
    submitted?: string | number;
    indexed?: string | number;
  }[];
}

export interface SitemapsListResponse {
  sitemap?: SitemapResource[];
}

// --- URL Inspection API v1 ---

export interface IndexStatusResult {
  verdict?: string;
  coverageState?: string;
  robotsTxtState?: string;
  indexingState?: string;
  lastCrawlTime?: string;
  pageFetchState?: string;
  googleCanonical?: string;
  userCanonical?: string;
  sitemap?: string[];
  referringUrls?: string[];
  crawledAs?: string;
}

export interface SimpleVerdictResult {
  verdict?: string;
  issues?: { issueType?: string; severity?: string; message?: string }[];
  detectedItems?: { richResultType?: string; items?: unknown[] }[];
}

export interface UrlInspectionResult {
  indexStatusResult?: IndexStatusResult;
  mobileUsabilityResult?: SimpleVerdictResult;
  richResultsResult?: SimpleVerdictResult;
  ampResult?: SimpleVerdictResult;
  inspectionResultLink?: string;
}

export interface UrlInspectionResponse {
  inspectionResult?: UrlInspectionResult;
}

export interface DimensionFilter {
  dimension: string;
  operator?: string;
  expression: string;
}

export interface DimensionFilterGroup {
  groupType?: string;
  filters: DimensionFilter[];
}
