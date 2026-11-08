/**
 * Document tier classification system.
 * Classifies documents into 5 tiers based on content structure.
 */

export const TIERS = [
  'guide',
  'standard',
  'example',
  'reference',
  'admin',
  'plan',
  'fact',
  'incident-narrative',
  'incident-facts',
] as const;
export type Tier = (typeof TIERS)[number];

/**
 * Tiers that use lifecycle status (status field) instead of semver versioning.
 * These tiers have `version` relaxed to optional in the MetadataSchema and
 * accept tier-specific status enums in addition to (or instead of) the
 * doc-tier status enum.
 *
 * - plan: phase/task/atom planning artifacts (added in 2.2.0)
 * - fact: atomic knowledge claims, tracked via `last_verified` + confidence
 * - incident-narrative: postmortem story (date-stamped, immutable)
 * - incident-facts: bridge doc linking incidents to facts they produced
 */
export const LIFECYCLE_TRACKED_TIERS = [
  'plan',
  'fact',
  'incident-narrative',
  'incident-facts',
] as const satisfies readonly Tier[];
export type LifecycleTrackedTier = (typeof LIFECYCLE_TRACKED_TIERS)[number];

export function is_lifecycle_tracked_tier(tier: unknown): tier is LifecycleTrackedTier {
  return (
    typeof tier === 'string' &&
    (LIFECYCLE_TRACKED_TIERS as readonly string[]).includes(tier)
  );
}

export interface TierDefinition {
  id: Tier;
  name: string;
  description: string;
  size_range: { min: number; max: number }; // in KB
  indicators: string[];
  heading_patterns: RegExp[];
}

export const TIER_DEFINITIONS: Record<Tier, TierDefinition> = {
  guide: {
    id: 'guide',
    name: 'Guide',
    description: 'Step-by-step how-to guides',
    size_range: { min: 15, max: 30 },
    indicators: [
      'how to', 'step by step', 'tutorial', 'guide', 'walkthrough',
      'getting started', 'learn', 'implement', 'build', 'create',
    ],
    heading_patterns: [
      /^#+\s*(prerequisites?|requirements?)/i,
      /^#+\s*(step\s*\d+|first|next|then|finally)/i,
      /^#+\s*(overview|introduction|getting started)/i,
      /^#+\s*(example|demo|try it)/i,
    ],
  },
  standard: {
    id: 'standard',
    name: 'Standard',
    description: 'Coding standards and conventions',
    size_range: { min: 5, max: 15 },
    indicators: [
      'standard', 'convention', 'rule', 'must', 'should', 'must not',
      'should not', 'required', 'recommended', 'best practice', 'guideline',
    ],
    heading_patterns: [
      /^#+\s*(rules?|guidelines?|conventions?)/i,
      /^#+\s*(do|don'?t|avoid|prefer)/i,
      /^#+\s*(naming|formatting|style)/i,
      /^#+\s*(required|recommended|optional)/i,
    ],
  },
  example: {
    id: 'example',
    name: 'Example',
    description: 'Code examples and templates',
    size_range: { min: 3, max: 10 },
    indicators: [
      'example', 'sample', 'template', 'snippet', 'code', 'demo',
      'showcase', 'pattern example', 'usage example',
    ],
    heading_patterns: [
      /^#+\s*(example|sample|template)/i,
      /^#+\s*(code|snippet|usage)/i,
      /^#+\s*(input|output|result)/i,
    ],
  },
  reference: {
    id: 'reference',
    name: 'Reference',
    description: 'Comprehensive references',
    size_range: { min: 30, max: 100 },
    indicators: [
      'reference', 'specification', 'api', 'complete', 'comprehensive',
      'all', 'full list', 'documentation', 'schema', 'interface',
    ],
    heading_patterns: [
      /^#+\s*(api|schema|interface|type)/i,
      /^#+\s*(parameters?|arguments?|options?)/i,
      /^#+\s*(methods?|functions?|endpoints?)/i,
      /^#+\s*(properties|fields|attributes)/i,
    ],
  },
  admin: {
    id: 'admin',
    name: 'Admin',
    description: 'Administrative/operational docs',
    size_range: { min: 10, max: 20 },
    indicators: [
      'admin', 'administrative', 'operational', 'maintenance', 'ops',
      'manage', 'configure', 'setup', 'deployment', 'monitoring',
    ],
    heading_patterns: [
      /^#+\s*(configuration|setup|installation)/i,
      /^#+\s*(maintenance|monitoring|logging)/i,
      /^#+\s*(backup|restore|recovery)/i,
      /^#+\s*(troubleshooting|debugging)/i,
    ],
  },
  plan: {
    id: 'plan',
    name: 'Plan',
    description: 'Phase/task/atom planning artifacts (added in 2.2.0 for persistent-planning lg-mode interop). Plans typically carry tier: plan in frontmatter; auto-classification is a fallback.',
    size_range: { min: 1, max: 200 },
    indicators: [
      'phase', 'task', 'atom', 'milestone', 'deliverable',
      'plan', 'roadmap', 'blocker', 'dependency', 'next concrete action',
    ],
    heading_patterns: [
      /^#+\s*(goal|scope|status)/i,
      /^#+\s*(phases?|tasks?|atoms?)/i,
      /^#+\s*(decisions? made|errors? encountered)/i,
      /^#+\s*(implementation notes|key questions)/i,
    ],
  },
  fact: {
    id: 'fact',
    name: 'Fact',
    description: 'Atomic, single-claim, citable unit of knowledge (added in 2.3.0). Facts use last_verified + confidence instead of semver versioning. Facts typically carry tier: fact in frontmatter; auto-classification is a fallback.',
    size_range: { min: 1, max: 5 },
    indicators: [
      'claim', 'confidence', 'verify', 'last verified', 'provenance',
      'citation', 'fact', 'hypothesis', 'invalidated by', 'consequence',
    ],
    heading_patterns: [
      /^#+\s*(claim|the claim)/i,
      /^#+\s*(how to verify|verification)/i,
      /^#+\s*(consequences?|implications?)/i,
      /^#+\s*(cited by|provenance)/i,
    ],
  },
  'incident-narrative': {
    id: 'incident-narrative',
    name: 'Incident narrative',
    description: 'Immutable postmortem story (added in 2.3.0). Lives at <vault-root>/incidents/<date-slug>/narrative.md. Date-stamped; uses lifecycle status (open/partial/resolved/planned) not semver.',
    size_range: { min: 2, max: 50 },
    indicators: [
      'postmortem', 'incident', 'outage', 'severity', 'resolution',
      'timeline', 'root cause', 'remediation', 'symptoms', 'on-call',
    ],
    heading_patterns: [
      /^#+\s*(timeline|sequence of events)/i,
      /^#+\s*(root cause|cause)/i,
      /^#+\s*(impact|severity)/i,
      /^#+\s*(remediation|resolution|fix)/i,
      /^#+\s*(lessons learned|action items|follow[-\s]ups?)/i,
    ],
  },
  'incident-facts': {
    id: 'incident-facts',
    name: 'Incident facts bridge',
    description: 'Bridge document linking an incident to the facts it produced, strengthened, or weakened (added in 2.3.0). Lives at <vault-root>/incidents/<date-slug>/facts.md.',
    size_range: { min: 1, max: 10 },
    indicators: [
      'produced', 'strengthened', 'weakened', 'facts from',
      'incident facts', 'bridges to', 'derived from',
    ],
    heading_patterns: [
      /^#+\s*(produced|new facts)/i,
      /^#+\s*(strengthened)/i,
      /^#+\s*(weakened|invalidated)/i,
    ],
  },
};

export interface TierClassificationResult {
  tier: Tier;
  confidence: number; // 0-1
  scores: Record<Tier, number>;
  reasoning: string[];
}

/**
 * Classify document content into a tier
 */
export function classify_tier(content: string): TierClassificationResult {
  const scores: Record<Tier, number> = {
    guide: 0,
    standard: 0,
    example: 0,
    reference: 0,
    admin: 0,
    plan: 0,
    fact: 0,
    'incident-narrative': 0,
    'incident-facts': 0,
  };

  const reasoning: string[] = [];
  const lower_content = content.toLowerCase();

  // Calculate content size in KB
  const size_kb = Buffer.byteLength(content, 'utf8') / 1024;

  // Score based on indicators
  for (const tier of TIERS) {
    const definition = TIER_DEFINITIONS[tier];

    // Check indicators
    for (const indicator of definition.indicators) {
      const regex = new RegExp(`\\b${escape_regex(indicator)}\\b`, 'gi');
      const matches = lower_content.match(regex);
      if (matches) {
        scores[tier] += matches.length * 2;
        if (matches.length >= 3) {
          reasoning.push(`Found indicator "${indicator}" ${matches.length} times (${tier})`);
        }
      }
    }

    // Check heading patterns
    for (const pattern of definition.heading_patterns) {
      const matches = content.match(new RegExp(pattern.source, 'gim'));
      if (matches) {
        scores[tier] += matches.length * 5;
        reasoning.push(`Matched heading pattern for ${tier}: ${matches.length} matches`);
      }
    }

    // Size-based scoring
    if (size_kb >= definition.size_range.min && size_kb <= definition.size_range.max) {
      scores[tier] += 10;
      reasoning.push(`Size ${size_kb.toFixed(1)}KB matches ${tier} range`);
    }
  }

  // Additional heuristics

  // Code block ratio indicates example or reference
  const code_block_count = (content.match(/```/g) ?? []).length / 2;
  const lines = content.split('\n').length;
  const code_ratio = code_block_count / (lines / 50);

  if (code_ratio > 0.5) {
    scores.example += 15;
    reasoning.push('High code block ratio suggests example');
  }

  // Bullet/numbered list ratio indicates guide or standard
  const list_items = (content.match(/^[\s]*[-*\d.]+\s/gm) ?? []).length;
  const list_ratio = list_items / lines;

  if (list_ratio > 0.3) {
    scores.guide += 10;
    scores.standard += 8;
    reasoning.push('High list ratio suggests guide or standard');
  }

  // Table presence indicates reference
  const tables = (content.match(/^\|.*\|$/gm) ?? []).length;
  if (tables > 5) {
    scores.reference += 15;
    reasoning.push('Multiple tables suggest reference');
  }

  // Warning/Note boxes indicate admin or troubleshooting
  const warnings = (content.match(/>\s*\*\*(warning|note|caution|important)/gi) ?? []).length;
  if (warnings > 2) {
    scores.admin += 10;
    reasoning.push('Warning boxes suggest admin documentation');
  }

  // Find the winning tier
  let max_score = 0;
  let winning_tier: Tier = 'guide';

  for (const tier of TIERS) {
    if (scores[tier] > max_score) {
      max_score = scores[tier];
      winning_tier = tier;
    }
  }

  // Calculate confidence based on score difference
  const sorted_scores = Object.values(scores).sort((a, b) => b - a);
  const top_score = sorted_scores[0] ?? 0;
  const second_score = sorted_scores[1] ?? 0;
  const score_diff = top_score - second_score;

  let confidence = 0.5;
  if (top_score > 0) {
    confidence = Math.min(0.5 + (score_diff / top_score) * 0.3 + (top_score / 100) * 0.2, 0.95);
  }

  return {
    tier: winning_tier,
    confidence,
    scores,
    reasoning,
  };
}

/**
 * Get tier definition by ID
 */
export function get_tier_definition(tier: Tier): TierDefinition {
  return TIER_DEFINITIONS[tier];
}

/**
 * Check if a string is a valid tier
 */
export function is_valid_tier(value: string): value is Tier {
  return TIERS.includes(value as Tier);
}

/**
 * Get tier display name
 */
export function get_tier_display_name(tier: Tier): string {
  return TIER_DEFINITIONS[tier].name;
}

/**
 * Escape special regex characters
 */
function escape_regex(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
