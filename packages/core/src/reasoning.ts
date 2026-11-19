export interface ReasoningOption { id: string; label: string }

const labels: Record<string, string> = {
  off: '关闭思考', disabled: '关闭思考', none: '不启用', enabled: '启用思考',
  minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高', ultra: '超高',
};

export function reasoningOption(id: string): ReasoningOption {
  return { id, label: labels[id] ? `${labels[id]}（${id}）` : id };
}

/** The recorded value is a requested override, not an observation of model internals. */
export function reasoningLabel(value?: string | null, language: 'zh-CN' | 'en' = 'zh-CN'): string {
  return language === 'en' ? `Reasoning: ${value || 'Agent default'}`
    : `推理：${value ? reasoningOption(value).label : '沿用 Agent 配置'}`;
}
