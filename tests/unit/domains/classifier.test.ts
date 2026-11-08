import { describe, it, expect } from 'vitest';
import {
  TIERS,
  TIER_DEFINITIONS,
  classify_tier,
  get_tier_definition,
  is_valid_tier,
  get_tier_display_name,
  LIFECYCLE_TRACKED_TIERS,
  is_lifecycle_tracked_tier,
} from '../../../src/core/domains/classifier.js';

describe('Tier Classifier', () => {
  describe('TIERS', () => {
    it('should have 9 tiers (added "plan" in 2.2.0; "fact", "incident-narrative", "incident-facts" in 2.3.0)', () => {
      expect(TIERS).toHaveLength(9);
    });

    it('should include all expected tiers', () => {
      expect(TIERS).toContain('guide');
      expect(TIERS).toContain('standard');
      expect(TIERS).toContain('example');
      expect(TIERS).toContain('reference');
      expect(TIERS).toContain('admin');
      expect(TIERS).toContain('plan');
      expect(TIERS).toContain('fact');
      expect(TIERS).toContain('incident-narrative');
      expect(TIERS).toContain('incident-facts');
    });
  });

  describe('TIER_DEFINITIONS', () => {
    it('should have a definition for each tier', () => {
      for (const tier of TIERS) {
        expect(TIER_DEFINITIONS[tier]).toBeDefined();
      }
    });

    it('should have required properties', () => {
      for (const tier of TIERS) {
        const def = TIER_DEFINITIONS[tier];
        expect(def.id).toBe(tier);
        expect(def.name).toBeTruthy();
        expect(def.description).toBeTruthy();
        expect(def.indicators).toBeInstanceOf(Array);
        expect(def.headingPatterns).toBeInstanceOf(Array);
        expect(def.sizeRange.min).toBeLessThan(def.sizeRange.max);
      }
    });
  });

  describe('classifyTier', () => {
    it('should classify guide content', () => {
      const guide_content = `
# How to Setup Authentication

## Overview
This guide shows you how to set up authentication.

## Prerequisites
- Node.js installed
- Database configured

## Step 1: Install dependencies
First, install the required packages.

## Step 2: Configure settings
Next, configure your settings.

## Step 3: Test the setup
Finally, test everything works.
`;

      const result = classify_tier(guide_content);
      expect(result.tier).toBe('guide');
      expect(result.confidence).toBeGreaterThan(0.5);
    });

    it('should classify standard content', () => {
      const standard_content = `
# API Design Standards

## Rules

### Rule 1: Use REST conventions
You MUST use REST conventions for all endpoints.

**DO:**
- Use nouns for resources

**DON'T:**
- Use verbs in URLs

### Rule 2: Naming conventions
All endpoints SHOULD follow kebab-case naming.

## Guidelines
Follow these best practices for consistent API design.
`;

      const result = classify_tier(standard_content);
      expect(['standard', 'guide']).toContain(result.tier);
    });

    it('should classify example content', () => {
      const example_content = `
# React Component Example

## Code

\`\`\`typescript
export function Button({ label }: Props) {
  return <button>{label}</button>;
}
\`\`\`

## Usage

\`\`\`typescript
<Button label="Click me" />
\`\`\`

## Output
Renders a button with the label.
`;

      const result = classify_tier(example_content);
      expect(['example', 'guide']).toContain(result.tier);
    });

    it('should classify reference content', () => {
      const reference_content = `
# API Reference

## Endpoints

### GET /api/users

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| page | number | No | Page number |
| limit | number | No | Items per page |

### POST /api/users

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| name | string | Yes | User name |
| email | string | Yes | User email |

## Types

### User

| Property | Type | Description |
|----------|------|-------------|
| id | string | Unique ID |
| name | string | Display name |

## Methods

### getUser(id)
Returns a user by ID.
`;

      const result = classify_tier(reference_content);
      expect(['reference', 'admin']).toContain(result.tier);
    });

    it('should return confidence between 0 and 1', () => {
      const content = 'Some random content';
      const result = classify_tier(content);

      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });

    it('should return scores for all tiers', () => {
      const content = 'Some content here';
      const result = classify_tier(content);

      for (const tier of TIERS) {
        expect(result.scores).toHaveProperty(tier);
      }
    });
  });

  describe('getTierDefinition', () => {
    it('should return the correct definition', () => {
      const guide_def = get_tier_definition('guide');
      expect(guide_def.id).toBe('guide');
      expect(guide_def.name).toBe('Guide');
    });
  });

  describe('isValidTier', () => {
    it('should return true for valid tiers', () => {
      expect(is_valid_tier('guide')).toBe(true);
      expect(is_valid_tier('standard')).toBe(true);
      expect(is_valid_tier('admin')).toBe(true);
      expect(is_valid_tier('plan')).toBe(true);
      expect(is_valid_tier('fact')).toBe(true);
      expect(is_valid_tier('incident-narrative')).toBe(true);
      expect(is_valid_tier('incident-facts')).toBe(true);
    });

    it('should return false for invalid tiers', () => {
      expect(is_valid_tier('invalid')).toBe(false);
      expect(is_valid_tier('')).toBe(false);
      expect(is_valid_tier('GUIDE')).toBe(false);
      expect(is_valid_tier('incident')).toBe(false); // must be incident-narrative or incident-facts
      expect(is_valid_tier('playbook-symptoms')).toBe(false); // symptoms is a field, not a tier
    });
  });

  describe('getTierDisplayName', () => {
    it('should return display names', () => {
      expect(get_tier_display_name('guide')).toBe('Guide');
      expect(get_tier_display_name('standard')).toBe('Standard');
      expect(get_tier_display_name('admin')).toBe('Admin');
      expect(get_tier_display_name('plan')).toBe('Plan');
    });
  });

  // --- 2.3.0: knowledge-base tiers ---
  describe('LIFECYCLE_TRACKED_TIERS (2.3.0)', () => {
    it('includes plan, fact, incident-narrative, incident-facts', () => {
      expect(LIFECYCLE_TRACKED_TIERS).toContain('plan');
      expect(LIFECYCLE_TRACKED_TIERS).toContain('fact');
      expect(LIFECYCLE_TRACKED_TIERS).toContain('incident-narrative');
      expect(LIFECYCLE_TRACKED_TIERS).toContain('incident-facts');
    });

    it('does NOT include doc-style tiers', () => {
      expect(LIFECYCLE_TRACKED_TIERS).not.toContain('guide');
      expect(LIFECYCLE_TRACKED_TIERS).not.toContain('standard');
      expect(LIFECYCLE_TRACKED_TIERS).not.toContain('example');
      expect(LIFECYCLE_TRACKED_TIERS).not.toContain('reference');
      expect(LIFECYCLE_TRACKED_TIERS).not.toContain('admin');
    });

    it('isLifecycleTrackedTier returns true only for lifecycle tiers', () => {
      expect(is_lifecycle_tracked_tier('plan')).toBe(true);
      expect(is_lifecycle_tracked_tier('fact')).toBe(true);
      expect(is_lifecycle_tracked_tier('incident-narrative')).toBe(true);
      expect(is_lifecycle_tracked_tier('incident-facts')).toBe(true);
      expect(is_lifecycle_tracked_tier('guide')).toBe(false);
      expect(is_lifecycle_tracked_tier('admin')).toBe(false);
      expect(is_lifecycle_tracked_tier(undefined)).toBe(false);
      expect(is_lifecycle_tracked_tier(null)).toBe(false);
      expect(is_lifecycle_tracked_tier('')).toBe(false);
      expect(is_lifecycle_tracked_tier('FACT')).toBe(false);
    });
  });

  describe('fact tier (2.3.0)', () => {
    it('TIER_DEFINITIONS.fact has the right shape', () => {
      const def = TIER_DEFINITIONS.fact;
      expect(def).toBeDefined();
      expect(def.id).toBe('fact');
      expect(def.name).toBe('Fact');
      expect(def.indicators).toContain('claim');
      expect(def.indicators).toContain('confidence');
      expect(def.indicators).toContain('provenance');
    });

    it('classifyTier scores fact-shaped content into the fact tier', () => {
      const fact_content = `
# Alloy reads env only at entrypoint

## Claim
Grafana Alloy reads environment variables at entrypoint only, never refreshing them mid-run.

## How to verify
\`docker exec alloy printenv VAR\` after restart shows the new value; without restart shows old.

## Consequences
Updating Vault tokens via .env requires a container restart, not a config reload.

## Provenance
Confidence: high. Last verified: 2026-05-14.
`;
      const result = classify_tier(fact_content);
      expect(result.tier).toBe('fact');
    });
  });

  describe('incident-narrative tier (2.3.0)', () => {
    it('TIER_DEFINITIONS["incident-narrative"] has the right shape', () => {
      const def = TIER_DEFINITIONS['incident-narrative'];
      expect(def).toBeDefined();
      expect(def.id).toBe('incident-narrative');
      expect(def.name).toBe('Incident narrative');
      expect(def.indicators).toContain('postmortem');
      expect(def.indicators).toContain('severity');
      expect(def.indicators).toContain('root cause');
    });

    it('classifyTier scores postmortem-shaped content into incident-narrative', () => {
      const postmortem_content = `
# Postmortem: Vault Down on Auth-Staging

## Timeline
- 14:02 — Alert fires for Vault on-call
- 14:05 — On-call investigates, finds Vault is fine
- 14:15 — Root cause identified: Alloy scrape worker stuck

## Root Cause
Grafana Alloy's scrape worker was stuck on a stale connection.

## Impact
Severity: high. False positive page during off-hours.

## Resolution
Restarted Alloy container.

## Lessons Learned
- Alloy can produce false-positive metric outages
- On-call playbook should check Alloy before assuming Vault outage
`;
      const result = classify_tier(postmortem_content);
      expect(result.tier).toBe('incident-narrative');
    });
  });

  // --- 2.2.0: plan tier ---
  describe('plan tier (2.2.0)', () => {
    it('TIER_DEFINITIONS.plan has the right shape', () => {
      const def = TIER_DEFINITIONS.plan;
      expect(def).toBeDefined();
      expect(def.id).toBe('plan');
      expect(def.name).toBe('Plan');
      expect(def.indicators).toContain('phase');
      expect(def.indicators).toContain('task');
      expect(def.indicators).toContain('atom');
    });

    it('classifyTier scores plan-shaped content into the plan tier', () => {
      const plan_content = `
# Task Plan: Migrate to Postgres

## Goal
Migrate from MySQL to Postgres without downtime.

## Scope at a glance
Three phases.

## Phases

### Phase 1: Schema port
- [ ] Atom: dump schema
- [ ] Atom: convert types
- [ ] Atom: validate

## Decisions Made
- Use logical replication for the cutover

## Status
Phase 1 in progress
`;
      const result = classify_tier(plan_content);
      // Plan-shaped content should win the classification
      expect(result.tier).toBe('plan');
    });
  });
});
