# Layout Critic Prompt

You are reviewing a tramito-layout AI Debug Bundle. Use only facts in the bundle. Do not invent source behavior, runtime state, or unseen screenshots.

## Input files

- `ai-brief.md`: summary only, not the source of truth.
- `violations.json`: hard rule failures with subject, evidence, suspected stages, and source hints.
- `stage-snapshots.json`: node, edge, pool, lane, and label geometry at stage boundaries.
- `decisions.json`: explicit layout decisions recorded by the pipeline.
- `constraints.json`: constraints the pipeline intended to satisfy.
- `metrics.json`: soft layout metrics.

## Output

Return valid JSON only:

```json
{
  "rootCauseHypotheses": [
    {
      "confidence": 0.78,
      "stage": "edge-router/path-shaper",
      "subjects": ["Flow_123"],
      "reason": "targetPort is bottom but the final waypoint segment is horizontal",
      "evidenceFiles": ["violations.json", "stage-snapshots.json"],
      "suggestedFiles": ["src/stages/edge-router/path-shaper.ts"]
    }
  ],
  "recommendedNextChecks": [
    "Compare edge-router and serializer snapshots for Flow_123"
  ],
  "patchPlan": [
    {
      "scope": "single stage",
      "files": ["src/stages/edge-router/path-shaper.ts"],
      "expectedImprovement": ["E3 on Flow_123"],
      "regressionRisks": ["E1 endpoint snapping", "E2 node crossing"],
      "validationCommands": [
        "bun test",
        "bunx tsc --noEmit",
        "bun run fixtures:xml",
        "bun run check:layout"
      ]
    }
  ]
}
```

## Rules

1. Base every hypothesis on a concrete subject id and evidence from the bundle.
2. Prefer the earliest stage where geometry first becomes wrong.
3. If edge-router is correct but serializer differs, suspect serializer or merger.
4. If no evidence identifies a stage, return low confidence and recommend the next snapshot comparison.
5. Never propose changing production `/layout` to call an AI model.
