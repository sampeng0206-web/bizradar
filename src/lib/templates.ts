import { AppSettings, Lead } from '../types';
import { formatRecommendedServicesPitch } from './services';

export interface RenderTemplateOptions {
  lead: Lead;
  settings: AppSettings;
  surveyUrl?: string;
  unsubscribeUrl?: string;
}

export function renderTemplateText(
  template: string,
  options: RenderTemplateOptions
): string {
  const {
    lead,
    settings,
    surveyUrl = '{{問卷連結}}',
    unsubscribeUrl = '{{拒收連結}}',
  } = options;

  const recommendedPitch = formatRecommendedServicesPitch(
    lead.services,
    settings.services,
    3
  );

  return (template || '')
    .replace(/\{\{公司名稱\}\}/g, lead.name || '')
    .replace(/\{\{負責人\}\}/g, lead.representative || '負責人')
    .replace(/\{\{推薦服務\}\}/g, recommendedPitch)
    .replace(/\{\{問卷連結\}\}/g, surveyUrl)
    .replace(/\{\{拒收連結\}\}/g, unsubscribeUrl)
    .replace(/\{\{公司全名\}\}/g, settings.companyName || '')
    .replace(/\{\{地址\}\}/g, settings.companyAddress || '')
    .replace(/\{\{電話\}\}/g, settings.companyPhone || '')
    .replace(/\{\{官網\}\}/g, settings.companyWebsite || '');
}

export function checkMissingRequiredSettings(settings: AppSettings): string[] {
  const missing: string[] = [];
  if (!settings.workerUrl?.trim()) missing.push('Worker 網址');
  if (!settings.appToken?.trim()) missing.push('APP_TOKEN');
  if (!settings.companyName?.trim()) missing.push('公司全名');
  if (!settings.companyAddress?.trim()) missing.push('公司地址');
  if (!settings.companyPhone?.trim()) missing.push('公司電話');
  if (!settings.companyWebsite?.trim()) missing.push('公司官網');
  return missing;
}
