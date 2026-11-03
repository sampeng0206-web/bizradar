import {
  BusinessItem,
  Lead,
  LeadStatus,
  OrgType,
  ScoreBreakdown,
  ScoringWeights,
  ServiceDefinition,
} from '../types';
import { evaluateServiceFit, getNextStepAdvice } from './businessRules';
import { DEFAULT_SERVICES, DEFAULT_WEIGHTS } from './services';

export interface ScoringInput {
  name: string;
  address: string;
  capital: number;
  setupDate: string; // yyyy-mm-dd
  orgType: OrgType;
  businessItems: BusinessItem[];
  email?: string;
  website?: string;
  notes?: string;
  demandFound?: boolean;
  status?: LeadStatus;
  referenceDate?: Date | string;
  services?: ServiceDefinition[];
  weights?: ScoringWeights;
}

export interface ScoringOutput {
  score: number;
  scoreBreakdown: ScoreBreakdown;
  services: string[];
  reasons: string[];
  unknowns: string[];
  contactAdvice: string;
  nextStep: string;
  daysSinceSetup: number;
}

export function calculateDaysSinceSetup(
  setupDate: string,
  referenceDate: Date | string = new Date()
): number {
  const ref =
    typeof referenceDate === 'string'
      ? new Date(`${referenceDate.slice(0, 10)}T00:00:00Z`)
      : new Date(
          Date.UTC(
            referenceDate.getFullYear(),
            referenceDate.getMonth(),
            referenceDate.getDate()
          )
        );
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec((setupDate || '').trim());
  if (!match) return 9999;

  const target = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  );
  if (Number.isNaN(target.getTime())) return 9999;

  const diffMs = ref.getTime() - target.getTime();
  return Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
}

export function calculateTimelinessScore(
  days: number,
  maxTimeliness = 25
): number {
  let base = 0;
  if (days <= 60) {
    base = 25;
  } else if (days <= 90) {
    base = 20;
  } else if (days <= 150) {
    base = 10;
  } else {
    base = 0;
  }
  if (maxTimeliness === 25) return base;
  return Math.round((base / 25) * maxTimeliness);
}

export function calculateReachabilityScore(
  email: string | undefined,
  address: string | undefined,
  maxReachability = 20
): number {
  let raw = 0;
  if (email && email.trim().length > 0) {
    raw += 12;
  }
  if (address && address.includes('號')) {
    raw += 8;
  }
  const scaled =
    maxReachability === 20 ? raw : Math.round((raw / 20) * maxReachability);
  return Math.max(0, Math.min(maxReachability, scaled));
}

export function calculateDemandSignalScore(
  website: string | undefined,
  notes: string | undefined,
  demandFound: boolean | undefined,
  maxDemandSignal = 15
): number {
  let raw = 0;
  if (website && website.trim().length > 0) {
    raw += 8;
  }
  if (notes && notes.trim().length > 0) {
    raw += 4;
  }
  if (demandFound) {
    raw += 15;
  }
  const capped15 = Math.min(15, raw);
  const scaled =
    maxDemandSignal === 15
      ? capped15
      : Math.round((capped15 / 15) * maxDemandSignal);
  return Math.max(0, Math.min(maxDemandSignal, scaled));
}

export function scoreLead(input: ScoringInput): ScoringOutput {
  const weights = input.weights ?? DEFAULT_WEIGHTS;
  const serviceDefs = input.services ?? DEFAULT_SERVICES;

  const daysSinceSetup = calculateDaysSinceSetup(
    input.setupDate,
    input.referenceDate
  );

  // 1. 服務適配 (上限 40 或 weights.serviceFitMax)
  const fitResult = evaluateServiceFit(
    {
      name: input.name,
      capital: input.capital,
      orgType: input.orgType,
      businessItems: input.businessItems,
      enabledServices: serviceDefs,
    },
    weights.serviceFitMax
  );

  // 2. 時間性 (上限 25 或 weights.timelinessMax)
  const timeliness = calculateTimelinessScore(
    daysSinceSetup,
    weights.timelinessMax
  );

  // 3. 可接觸 (上限 20 或 weights.reachabilityMax)
  const hasEmail = Boolean(input.email && input.email.trim().length > 0);
  const reachability = calculateReachabilityScore(
    input.email,
    input.address,
    weights.reachabilityMax
  );

  // 4. 需求訊號 (上限 15 或 weights.demandSignalMax)
  const demandSignal = calculateDemandSignalScore(
    input.website,
    input.notes,
    input.demandFound,
    weights.demandSignalMax
  );

  const total =
    fitResult.cappedScore + timeliness + reachability + demandSignal;

  const unknowns: string[] = [
    '負責人年齡與資格未知（貸款條件需諮詢核實）',
    '實際營運地址未知',
    '是否已有記帳／顧問未知',
  ];
  if (!hasEmail) {
    unknowns.push('無公開商務Email');
  }

  const contactAdvice = hasEmail
    ? 'Email（人工核准後寄送）'
    : '紙本信寄登記地址';

  const status: LeadStatus = input.status ?? '新線索';
  const nextStep = getNextStepAdvice(status, hasEmail);

  return {
    score: total,
    scoreBreakdown: {
      serviceFit: fitResult.cappedScore,
      timeliness,
      reachability,
      demandSignal,
      total,
    },
    services: fitResult.services,
    reasons: fitResult.reasons,
    unknowns,
    contactAdvice,
    nextStep,
    daysSinceSetup,
  };
}

export function applyScoringToLead(
  lead: Lead,
  services: ServiceDefinition[] = DEFAULT_SERVICES,
  weights: ScoringWeights = DEFAULT_WEIGHTS,
  referenceDate?: Date | string
): Lead {
  const result = scoreLead({
    name: lead.name,
    address: lead.address,
    capital: lead.capital,
    setupDate: lead.setupDate,
    orgType: lead.orgType,
    businessItems: lead.businessItems,
    email: lead.email,
    website: lead.website,
    notes: lead.notes,
    demandFound: lead.demandFound,
    status: lead.status,
    services,
    weights,
    referenceDate,
  });

  return {
    ...lead,
    score: result.score,
    scoreBreakdown: result.scoreBreakdown,
    services: result.services,
    reasons: result.reasons,
    unknowns: result.unknowns,
    contactAdvice: result.contactAdvice,
    nextStep: result.nextStep,
  };
}
